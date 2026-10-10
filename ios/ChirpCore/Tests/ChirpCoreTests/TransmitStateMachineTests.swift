import XCTest
@testable import ChirpCore

/// Drives the machine and tracks what the microphone would be doing, from the
/// effects alone, so tests can assert on the real invariant.
private struct Harness {
    var m: TransmitStateMachine
    var micOn = false
    var captureStarts = 0
    var effectsLog: [TransmitEffect] = []
    var floorsOutstanding = Set<String>()   // requested and not released
    private var counter = 0

    init(timing: TransmitStateMachine.Timing = .init()) {
        // A deterministic id generator.
        let box = IDBox()
        m = TransmitStateMachine(timing: timing, makeId: { box.next() })
    }

    @discardableResult
    mutating func send(_ e: TransmitEvent) -> [TransmitEffect] {
        let fx = m.handle(e)
        for f in fx {
            switch f {
            case .startCapture:
                XCTAssertFalse(micOn, "capture started twice")
                micOn = true
                captureStarts += 1
            case .stopCapture:
                micOn = false
            case .requestFloor(let id):
                floorsOutstanding.insert(id)
            case .releaseFloor(let id, _):
                floorsOutstanding.remove(id)
            default:
                break
            }
        }
        effectsLog += fx
        // The core invariant, after every single event.
        XCTAssertEqual(micOn, m.phase == .live, "microphone must be on exactly in the live phase (after \(e))")
        return fx
    }

    var txId: String { m.transmissionId ?? "" }
}

private final class IDBox: @unchecked Sendable {
    private var n = 0
    private let lock = NSLock()
    func next() -> String { lock.lock(); defer { lock.unlock() }; n += 1; return "tx-\(n)" }
}

final class TransmitStateMachineTests: XCTestCase {

    func testNormalInAppTransmission() {
        var h = Harness()
        var fx = h.send(.press(.inApp))
        XCTAssertTrue(fx.contains(.requestFloor("tx-1")))
        XCTAssertTrue(fx.contains(.requestSystemTransmit))
        XCTAssertEqual(h.m.phase, .starting)

        XCTAssertEqual(h.send(.systemDidBegin(.inApp)), [])
        XCTAssertEqual(h.send(.floorGranted("tx-1")), [])           // not ready yet: no audio session
        XCTAssertFalse(h.micOn)
        fx = h.send(.audioActivated)
        XCTAssertTrue(fx.contains(.startCapture("tx-1")))
        XCTAssertEqual(h.m.phase, .live)

        fx = h.send(.release(.inApp))
        XCTAssertEqual(Array(fx.prefix(3)), [.stopCapture, .releaseFloor("tx-1", aborted: false), .stopSystemTransmit])
        XCTAssertEqual(h.m.phase, .stopping)
        h.send(.systemDidEnd(.inApp))
        XCTAssertEqual(h.m.phase, .idle)
        XCTAssertTrue(h.floorsOutstanding.isEmpty)
    }

    func testTheChirpAloneNeverStartsTheMic() {
        // The system chime/begin without a floor grant must not capture.
        var h = Harness()
        h.send(.press(.inApp))
        h.send(.systemDidBegin(.inApp))
        h.send(.audioActivated)
        XCTAssertFalse(h.micOn)
        XCTAssertEqual(h.m.phase, .starting)
    }

    func testEveryOrderingOfStartupCallbacksStartsCaptureExactlyOnce() {
        let callbacks: [TransmitEvent] = [.floorGranted("tx-1"), .systemDidBegin(.inApp), .audioActivated]
        for order in permutations(callbacks) {
            var h = Harness()
            h.send(.press(.inApp))
            for (i, e) in order.enumerated() {
                h.send(e)
                XCTAssertEqual(h.micOn, i == order.count - 1, "capture only after all three: \(order)")
            }
            XCTAssertEqual(h.captureStarts, 1, "\(order)")
        }
    }

    func testReleaseDuringStartupCanNeverBeUndoneByLateCallbacks() {
        let late: [TransmitEvent] = [.floorGranted("tx-1"), .systemDidBegin(.inApp), .audioActivated]
        // Release after k of the three callbacks have arrived (k = 0...2), then the
        // rest arrive in every possible order.
        for k in 0...2 {
            for order in permutations(late) {
                var h = Harness()
                h.send(.press(.inApp))
                for e in order.prefix(k) { h.send(e) }
                h.send(.release(.inApp))
                for e in order.dropFirst(k) { h.send(e) }
                XCTAssertEqual(h.captureStarts, 0, "release at \(k) with \(order)")
                XCTAssertFalse(h.micOn)
                h.send(.systemDidEnd(.inApp))
                XCTAssertEqual(h.m.phase, .idle)
                XCTAssertTrue(h.floorsOutstanding.isEmpty, "floor must not be left held (release at \(k), \(order))")
            }
        }
    }

    func testLateBeginAfterReleaseIsCancelledNotHonoured() {
        var h = Harness()
        h.send(.press(.inApp))
        h.send(.release(.inApp))
        let fx = h.send(.systemDidBegin(.inApp))
        XCTAssertEqual(fx, [.stopSystemTransmit])
        XCTAssertFalse(h.micOn)
    }

    func testLateBeginEchoWhenIdleDoesNotStartAnything() {
        var h = Harness()
        h.send(.press(.inApp))
        h.send(.release(.inApp))
        h.send(.systemDidEnd(.inApp))           // back to idle
        let fx = h.send(.systemDidBegin(.inApp)) // a stale echo of our own old request
        XCTAssertEqual(fx, [.stopSystemTransmit])
        XCTAssertEqual(h.m.phase, .idle)
    }

    func testFloorDeniedStopsEverythingAndDoesNotRetryWhileHeld() {
        var h = Harness()
        h.send(.press(.inApp))
        h.send(.systemDidBegin(.inApp))
        let fx = h.send(.floorDenied("tx-1", reason: "busy"))
        XCTAssertTrue(fx.contains(.stopSystemTransmit))
        XCTAssertTrue(fx.contains(.notify(.busy(reason: "busy"))))
        XCTAssertEqual(h.m.phase, .interrupted)
        // Still holding the button: further presses and a late activation do nothing.
        XCTAssertEqual(h.send(.press(.inApp)), [.notify(.ignoredPress)])
        h.send(.audioActivated)
        XCTAssertFalse(h.micOn)
        // A new press needs a release first.
        h.send(.release(.inApp))
        XCTAssertEqual(h.m.phase, .idle)
        XCTAssertTrue(h.send(.press(.inApp)).contains(.requestFloor("tx-2")))
    }

    func testInterruptionWhileLiveStopsCaptureAndNeverResumes() {
        var h = Harness()
        goLive(&h)
        let fx = h.send(.audioInterrupted)
        XCTAssertTrue(fx.contains(.stopCapture))
        XCTAssertTrue(fx.contains(.releaseFloor("tx-1", aborted: true)))
        XCTAssertEqual(h.m.phase, .interrupted)
        // Everything that could tempt a resume.
        h.send(.connectionRestored)
        h.send(.audioActivated)
        h.send(.floorGranted("tx-1"))
        XCTAssertFalse(h.micOn)
        XCTAssertEqual(h.captureStarts, 1)
        h.send(.release(.inApp))
        XCTAssertEqual(h.m.phase, .idle)
    }

    func testConnectionLossWhileLiveStopsCaptureAndReconnectDoesNotResume() {
        var h = Harness()
        goLive(&h)
        h.send(.connectionLost)
        XCTAssertFalse(h.micOn)
        h.send(.connectionRestored)
        XCTAssertFalse(h.micOn)
        XCTAssertEqual(h.m.phase, .interrupted)
    }

    func testServerCutStopsCaptureAndDoesNotEchoARelease() {
        var h = Harness()
        goLive(&h)
        let fx = h.send(.floorEnded("tx-1", reason: "idle-lease-expired"))
        XCTAssertTrue(fx.contains(.stopCapture))
        XCTAssertFalse(fx.contains(.releaseFloor("tx-1", aborted: true)), "the server already ended it")
        XCTAssertEqual(h.m.phase, .interrupted)
    }

    func testAudioSessionLossWhileLiveStopsCapture() {
        var h = Harness()
        goLive(&h)
        h.send(.audioDeactivated)
        XCTAssertFalse(h.micOn)
        XCTAssertEqual(h.m.phase, .interrupted)
    }

    func testMicDeniedAbortsStartup() {
        var h = Harness()
        h.send(.press(.inApp))
        let fx = h.send(.micPermissionDenied)
        XCTAssertTrue(fx.contains(.notify(.micDenied)))
        XCTAssertTrue(fx.contains(.releaseFloor("tx-1", aborted: true)))
        XCTAssertEqual(h.m.phase, .interrupted)
    }

    func testSystemUIInitiatedTransmissionUsesTheSameFlow() {
        var h = Harness()
        var fx = h.send(.systemDidBegin(.systemUI))
        XCTAssertEqual(fx.first, .requestFloor("tx-1"))
        XCTAssertFalse(fx.contains(.requestSystemTransmit), "the system already began it")
        h.send(.floorGranted("tx-1"))
        fx = h.send(.audioActivated)
        XCTAssertTrue(fx.contains(.startCapture("tx-1")))
        // The user lets go of the system's Talk button.
        fx = h.send(.systemDidEnd(.systemUI))
        XCTAssertTrue(fx.contains(.stopCapture))
        XCTAssertTrue(fx.contains(.releaseFloor("tx-1", aborted: false)))
        XCTAssertEqual(h.m.phase, .idle)
        XCTAssertFalse(h.micOn)
    }

    func testSystemUIPressWhileBusyIsEndedAfterTheDenial() {
        var h = Harness()
        h.send(.systemDidBegin(.systemUI))
        let fx = h.send(.floorDenied("tx-1", reason: "busy"))
        XCTAssertTrue(fx.contains(.stopSystemTransmit), "end the system transmission the user started")
        XCTAssertFalse(h.micOn)
    }

    func testIntentToggleStartsThenStops() {
        var h = Harness()
        h.send(.toggle(.intent))
        XCTAssertEqual(h.m.phase, .starting)
        h.send(.systemDidBegin(.intent))
        h.send(.floorGranted("tx-1"))
        h.send(.audioActivated)
        XCTAssertTrue(h.micOn)
        h.send(.toggle(.intent))
        XCTAssertFalse(h.micOn)
        XCTAssertEqual(h.m.phase, .stopping)
    }

    func testAccessoryButtonUsesSystemCallbacks() {
        var h = Harness()
        h.send(.systemDidBegin(.accessory))
        h.send(.floorGranted("tx-1"))
        h.send(.audioActivated)
        XCTAssertTrue(h.micOn)
        h.send(.systemDidEnd(.accessory))
        XCTAssertFalse(h.micOn)
    }

    func testStaleGrantForAnAbandonedTransmissionIsGivenBack() {
        var h = Harness()
        h.send(.press(.inApp))
        h.send(.release(.inApp))
        h.send(.systemDidEnd(.inApp))
        XCTAssertEqual(h.send(.floorGranted("tx-1")), [.releaseFloor("tx-1", aborted: true)])
        // And a grant for an id we never issued while starting something else.
        h.send(.press(.inApp))
        XCTAssertEqual(h.send(.floorGranted("tx-OLD")), [.releaseFloor("tx-OLD", aborted: true)])
        XCTAssertFalse(h.m.floorGranted)
    }

    func testStartupWatchdogAbortsAStuckStart() {
        var h = Harness()
        var fx = h.send(.press(.inApp))
        let epoch = fx.compactMap { e -> Int? in if case .armWatchdog(_, let ep) = e { return ep } else { return nil } }.last!
        fx = h.send(.watchdogFired(epoch: epoch))
        XCTAssertTrue(fx.contains(.releaseFloor("tx-1", aborted: true)))
        XCTAssertEqual(h.m.phase, .interrupted)
    }

    func testStaleWatchdogFromAnEarlierPhaseIsIgnored() {
        var h = Harness()
        let fx = h.send(.press(.inApp))
        let startupEpoch = fx.compactMap { e -> Int? in if case .armWatchdog(_, let ep) = e { return ep } else { return nil } }.last!
        h.send(.systemDidBegin(.inApp)); h.send(.floorGranted("tx-1")); h.send(.audioActivated)
        XCTAssertEqual(h.m.phase, .live)
        XCTAssertEqual(h.send(.watchdogFired(epoch: startupEpoch)), [])
        XCTAssertTrue(h.micOn)
    }

    func testLiveWatchdogCapsTransmissionLength() {
        var h = Harness()
        goLive(&h)
        let epoch = h.m.epoch
        h.send(.watchdogFired(epoch: epoch))
        XCTAssertFalse(h.micOn)
        XCTAssertEqual(h.m.phase, .interrupted)
    }

    func testStoppingWatchdogRecoversFromAMissingSystemEnd() {
        var h = Harness()
        goLive(&h)
        h.send(.release(.inApp))
        XCTAssertEqual(h.m.phase, .stopping)
        h.send(.watchdogFired(epoch: h.m.epoch))
        XCTAssertEqual(h.m.phase, .idle)
    }

    func testRapidPressDuringStoppingIsIgnoredNotQueued() {
        var h = Harness()
        goLive(&h)
        h.send(.release(.inApp))
        XCTAssertEqual(h.send(.press(.inApp)), [.notify(.ignoredPress)])
        XCTAssertFalse(h.micOn)
    }

    func testRandomEventStreamsNeverBreakTheMicInvariants() {
        var rng = SeededGenerator(seed: 0xC41B)
        let ids = ["tx-1", "tx-2", "tx-3", "tx-9"]
        let sources: [TransmitSource] = [.inApp, .systemUI, .intent, .accessory, .unknown]
        var liveEntries = 0
        var interruptedEntries = 0
        for run in 0..<300 {
            var h = Harness()
            for _ in 0..<200 {
                // Favor the current transmission's ID so streams reach deep states.
                let id = (rng.next() % 3 != 0 ? h.m.transmissionId : nil) ?? ids.randomElement(using: &rng)!
                let s = sources.randomElement(using: &rng)!
                let noise: [TransmitEvent] = [
                    .press(s), .release(s), .toggle(s), .systemDidBegin(s), .systemDidEnd(s), .systemFailedToBegin,
                    .floorGranted(id), .floorDenied(id, reason: "busy"), .floorEnded(id, reason: "x"),
                    .audioActivated, .audioDeactivated, .audioInterrupted, .connectionLost, .connectionRestored,
                    .micPermissionDenied, .watchdogFired(epoch: h.m.epoch), .watchdogFired(epoch: h.m.epoch - 1),
                ]
                // Phase-aware guidance: usually move the transmission forward, sometimes inject noise.
                let current = h.m.transmissionId ?? "tx-none"
                let forward: [TransmitEvent]
                switch h.m.phase {
                case .idle: forward = [.press(.inApp), .systemDidBegin(.systemUI), .toggle(.intent)]
                case .starting: forward = [.systemDidBegin(.inApp), .floorGranted(current), .audioActivated]
                case .live: forward = [.release(.inApp), .systemDidEnd(.systemUI), .audioInterrupted, .connectionLost,
                                       .floorEnded(current, reason: "idle-lease-expired"), .audioDeactivated]
                case .stopping: forward = [.systemDidEnd(.inApp), .systemDidBegin(.inApp), .floorGranted(current)]
                case .interrupted: forward = [.release(.inApp), .connectionRestored, .audioActivated, .floorGranted(current)]
                }
                let pool = (rng.next() % 100 < 70) ? forward : noise
                let e = pool.randomElement(using: &rng)!
                let before = h.m.phase
                h.send(e)
                if before != .live, h.m.phase == .live { liveEntries += 1 }
                if before != .interrupted, h.m.phase == .interrupted { interruptedEntries += 1 }
                // Capture requires every precondition at the moment it begins.
                if before != .live, h.m.phase == .live {
                    XCTAssertTrue(h.m.floorGranted && h.m.systemBegun && h.m.audioActive, "run \(run)")
                }
                // Once forced out of a transmission, nothing but a release/new system press re-enters it.
                if before == .interrupted, h.m.phase == .live { XCTFail("resumed after interruption (run \(run), event \(e))") }
            }
        }
        // The test is only meaningful if the random streams actually exercised these states.
        XCTAssertGreaterThan(liveEntries, 200, "random streams must reach the live phase often")
        XCTAssertGreaterThan(interruptedEntries, 200, "random streams must reach the interrupted phase often")
    }

    // MARK: helpers

    private func goLive(_ h: inout Harness) {
        h.send(.press(.inApp))
        h.send(.systemDidBegin(.inApp))
        h.send(.floorGranted("tx-1"))
        h.send(.audioActivated)
        XCTAssertEqual(h.m.phase, .live)
    }

    private func permutations<T>(_ a: [T]) -> [[T]] {
        if a.count <= 1 { return [a] }
        return a.indices.flatMap { i -> [[T]] in
            var rest = a
            let x = rest.remove(at: i)
            return permutations(rest).map { [x] + $0 }
        }
    }
}

private struct SeededGenerator: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
}
