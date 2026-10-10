import Foundation

// One state model for every way a transmission can begin or end: the in-app
// button, Apple's system PTT controls, the Action Button / intents, and
// accessories. All of them feed events in; the machine decides what to do.
//
// Guarantees (enforced by tests, including a randomized one):
//   1. Capture starts only when the floor is granted, the system has begun the
//      transmission, AND the system has activated the audio session. The system
//      chirp is never treated as readiness.
//   2. Capture is on only in the `live` phase. A release, cancel, denial,
//      interruption, disconnect or server cut stops it.
//   3. A release or cancel during startup can never be undone by a late
//      activation, grant or begin callback.
//   4. After any forced stop the machine will not start again until the
//      trigger is released and pressed anew. Reconnecting never resumes.
//   5. Stale server answers (a grant for an abandoned transmission) are
//      answered with a release so the floor is not held.

public enum TransmitSource: Sendable, Equatable {
    case inApp
    case systemUI
    case intent
    case accessory
    case unknown
}

extension TransmitSource {
    /// Sources that can legitimately begin a transmission from a system callback,
    /// as opposed to echoing a request this app made itself.
    var startsFromSystemCallback: Bool { self == .systemUI || self == .accessory }
}

public enum TransmitPhase: Sendable, Equatable {
    case idle
    case starting      // trigger accepted; waiting for floor, system begin and audio session
    case live          // capturing and streaming
    case stopping      // releasing; waiting for the system to confirm the end
    case interrupted   // forced stop; needs a release before a new press
}

public enum TransmitEvent: Sendable, Equatable {
    case press(TransmitSource)
    case release(TransmitSource)
    case toggle(TransmitSource)
    case systemDidBegin(TransmitSource)
    case systemDidEnd(TransmitSource)
    case systemFailedToBegin
    case floorGranted(String)
    case floorDenied(String, reason: String)
    case floorEnded(String, reason: String)
    case audioActivated
    case audioDeactivated
    case audioInterrupted
    case connectionLost
    case connectionRestored
    case micPermissionDenied
    case watchdogFired(epoch: Int)
}

public enum TransmitNotice: Sendable, Equatable {
    case busy(reason: String)
    case ended(reason: String)
    case micDenied
    case interrupted
    case ignoredPress
}

public enum TransmitEffect: Sendable, Equatable {
    case requestFloor(String)
    case releaseFloor(String, aborted: Bool)
    case requestSystemTransmit
    case stopSystemTransmit
    case startCapture(String)
    case stopCapture
    case armWatchdog(seconds: Double, epoch: Int)
    case notify(TransmitNotice)
}

public struct TransmitStateMachine: Sendable {
    public private(set) var phase: TransmitPhase = .idle
    public private(set) var transmissionId: String?
    public private(set) var source: TransmitSource = .unknown
    public private(set) var floorGranted = false
    public private(set) var systemBegun = false
    public private(set) var audioActive = false
    public private(set) var epoch = 0

    public struct Timing: Sendable {
        public var startupSeconds: Double = 4
        public var stoppingSeconds: Double = 3
        public var maxTransmissionSeconds: Double = 30
        public init() {}
    }

    private let makeId: @Sendable () -> String
    private let timing: Timing

    public init(timing: Timing = Timing(), makeId: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }) {
        self.timing = timing
        self.makeId = makeId
    }

    /// True exactly while the microphone should be capturing.
    public var isCapturing: Bool { phase == .live }

    public mutating func handle(_ event: TransmitEvent) -> [TransmitEffect] {
        switch (phase, event) {

        // MARK: audio session truth is tracked in every phase
        case (_, .audioActivated):
            audioActive = true
            return phase == .starting ? goLiveIfReady() : []
        case (_, .audioDeactivated):
            audioActive = false
            if phase == .live { return forceStop(notice: .interrupted, releaseSystem: true) }
            return []

        // MARK: idle
        case (.idle, .press(let s)):
            return begin(source: s, systemAlreadyBegun: false)
        case (.idle, .toggle(let s)):
            return begin(source: s, systemAlreadyBegun: false)
        case (.idle, .systemDidBegin(let s)):
            // Only the system's own controls or an accessory may start a transmission
            // from a begin callback. Anything else is a late echo of a request we
            // already abandoned, and must not reopen the microphone.
            return s.startsFromSystemCallback ? begin(source: s, systemAlreadyBegun: true) : [.stopSystemTransmit]
        case (.idle, .floorGranted(let id)):
            return [.releaseFloor(id, aborted: true)]   // stale grant: give the floor back
        case (.idle, _):
            return []

        // MARK: starting
        case (.starting, .systemDidBegin):
            systemBegun = true
            return goLiveIfReady()
        case (.starting, .floorGranted(let id)):
            if id != transmissionId { return [.releaseFloor(id, aborted: true)] }
            floorGranted = true
            return goLiveIfReady()
        case (.starting, .floorDenied(let id, let reason)):
            guard id == transmissionId else { return [] }
            return forceStop(notice: .busy(reason: reason), releaseFloor: false, releaseSystem: true)
        case (.starting, .floorEnded(let id, let reason)):
            guard id == transmissionId else { return [] }
            return forceStop(notice: .ended(reason: reason), releaseFloor: false, releaseSystem: true)
        case (.starting, .release), (.starting, .systemDidEnd):
            return beginStopping()
        case (.starting, .toggle):
            return beginStopping()
        case (.starting, .press):
            return []   // already starting
        case (.starting, .systemFailedToBegin), (.starting, .audioInterrupted),
             (.starting, .connectionLost), (.starting, .micPermissionDenied):
            return forceStop(notice: notice(for: event), releaseSystem: true)
        case (.starting, .watchdogFired(let e)):
            guard e == epoch else { return [] }
            return forceStop(notice: .interrupted, releaseSystem: true)
        case (.starting, .connectionRestored):
            return []

        // MARK: live
        case (.live, .release), (.live, .toggle):
            return beginStopping()
        case (.live, .systemDidEnd):
            // The system ended it (for example the system Talk button was released).
            return endFromSystem()
        case (.live, .floorEnded(let id, let reason)):
            guard id == transmissionId else { return [] }
            return forceStop(notice: .ended(reason: reason), releaseFloor: false, releaseSystem: true)
        case (.live, .audioInterrupted), (.live, .connectionLost), (.live, .micPermissionDenied),
             (.live, .systemFailedToBegin):
            return forceStop(notice: notice(for: event), releaseSystem: true)
        case (.live, .watchdogFired(let e)):
            guard e == epoch else { return [] }
            return forceStop(notice: .ended(reason: "max-duration"), releaseSystem: true)
        case (.live, .floorGranted(let id)):
            return id == transmissionId ? [] : [.releaseFloor(id, aborted: true)]
        case (.live, .floorDenied), (.live, .press), (.live, .systemDidBegin), (.live, .connectionRestored):
            return []

        // MARK: stopping
        case (.stopping, .systemDidEnd):
            return finish()
        case (.stopping, .systemDidBegin):
            return [.stopSystemTransmit]   // a late begin must not reopen the mic
        case (.stopping, .floorGranted(let id)):
            return id == transmissionId ? [] : [.releaseFloor(id, aborted: true)]
        case (.stopping, .systemFailedToBegin):
            return finish()
        case (.stopping, .watchdogFired(let e)):
            guard e == epoch else { return [] }
            return finish(extra: [.stopSystemTransmit])
        case (.stopping, .press), (.stopping, .toggle):
            return [.notify(.ignoredPress)]
        case (.stopping, _):
            return []

        // MARK: interrupted
        case (.interrupted, .release), (.interrupted, .systemDidEnd), (.interrupted, .toggle):
            return finish()
        case (.interrupted, .systemDidBegin(let s)):
            guard s.startsFromSystemCallback else { return [.stopSystemTransmit] }
            // The system started a fresh transmission (a new press of its own button).
            _ = finish()
            return begin(source: s, systemAlreadyBegun: true)
        case (.interrupted, .floorGranted(let id)):
            return [.releaseFloor(id, aborted: true)]
        case (.interrupted, .press):
            return [.notify(.ignoredPress)]
        case (.interrupted, _):
            return []
        }
    }

    // MARK: transitions

    private mutating func begin(source: TransmitSource, systemAlreadyBegun: Bool) -> [TransmitEffect] {
        let id = makeId()
        transmissionId = id
        self.source = source
        floorGranted = false
        systemBegun = systemAlreadyBegun
        setPhase(.starting)
        var fx: [TransmitEffect] = [.requestFloor(id)]
        if !systemAlreadyBegun { fx.append(.requestSystemTransmit) }
        fx.append(.armWatchdog(seconds: timing.startupSeconds, epoch: epoch))
        return fx
    }

    private mutating func goLiveIfReady() -> [TransmitEffect] {
        guard phase == .starting, let id = transmissionId, floorGranted, systemBegun, audioActive else { return [] }
        setPhase(.live)
        return [.startCapture(id), .armWatchdog(seconds: timing.maxTransmissionSeconds + 1, epoch: epoch)]
    }

    /// Trigger released or toggled off by the user.
    private mutating func beginStopping() -> [TransmitEffect] {
        var fx: [TransmitEffect] = []
        if phase == .live { fx.append(.stopCapture) }
        if let id = transmissionId { fx.append(.releaseFloor(id, aborted: false)) }
        fx.append(.stopSystemTransmit)
        setPhase(.stopping)
        fx.append(.armWatchdog(seconds: timing.stoppingSeconds, epoch: epoch))
        return fx
    }

    /// The system reported the end (its own button released); no stopSystemTransmit needed.
    private mutating func endFromSystem() -> [TransmitEffect] {
        var fx: [TransmitEffect] = []
        if phase == .live { fx.append(.stopCapture) }
        if let id = transmissionId { fx.append(.releaseFloor(id, aborted: false)) }
        audioActive = false
        resetToIdle()
        return fx
    }

    /// Anything other than a normal release: stop everything and demand a fresh press.
    private mutating func forceStop(
        notice: TransmitNotice,
        releaseFloor: Bool = true,
        releaseSystem: Bool
    ) -> [TransmitEffect] {
        var fx: [TransmitEffect] = []
        if phase == .live { fx.append(.stopCapture) }
        if releaseFloor, let id = transmissionId { fx.append(.releaseFloor(id, aborted: true)) }
        if releaseSystem { fx.append(.stopSystemTransmit) }
        fx.append(.notify(notice))
        setPhase(.interrupted)
        return fx
    }

    private mutating func finish(extra: [TransmitEffect] = []) -> [TransmitEffect] {
        resetToIdle()
        return extra
    }

    private mutating func resetToIdle() {
        transmissionId = nil
        floorGranted = false
        systemBegun = false
        source = .unknown
        setPhase(.idle)
    }

    private mutating func setPhase(_ p: TransmitPhase) {
        phase = p
        epoch += 1
    }

    private func notice(for event: TransmitEvent) -> TransmitNotice {
        switch event {
        case .micPermissionDenied: return .micDenied
        default: return .interrupted
        }
    }
}
