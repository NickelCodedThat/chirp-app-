import AVFAudio
import ChirpCore
import Foundation
import PushToTalk
import SwiftUI
import UIKit

/// Wires the pure state machine to the Apple PTT adapter, the network and audio.
/// Every transmission entry point (in-app button, system UI, intents, accessories)
/// feeds `drive(_:)`; this class only executes the effects the machine returns.
///
/// Created by the AppDelegate at launch so that a push-triggered background
/// launch (no UI scene) still creates the channel manager immediately.
@MainActor
final class LabModel: ObservableObject {
    static let shared = LabModel()

    // Shown by the harness.
    @Published private(set) var phase: TransmitPhase = .idle
    @Published private(set) var joined = false
    @Published private(set) var connection: LabConnection.State = .disconnected
    @Published private(set) var notice = ""
    @Published private(set) var managerStatus = "starting"
    @Published private(set) var logTail: [LabLog.Entry] = []
    @Published var serverURL: String { didSet { UserDefaults.standard.set(serverURL, forKey: "lab.serverURL") } }
    @Published var token: String { didSet { UserDefaults.standard.set(token, forKey: "lab.token") } }
    @Published var conversationId: String { didSet { UserDefaults.standard.set(conversationId, forKey: "lab.conversation") } }

    let ptt = PTTAdapter()
    let net = LabConnection()
    let audio = AudioIO()
    private let log = LabLog.shared

    private var machine = TransmitStateMachine()
    private var tokenHex: String?
    private var pendingReqTransmission: [String: String] = [:]   // reqId -> transmissionId
    private var handledPushIds: [String] = []
    private var rx: Rx?
    private var started = false

    /// One incoming transmission's timeline, for the experiment record.
    private struct Rx {
        let transmissionId: String
        var pushAtMs = LabLog.mono()
        var activated = false
        var attached = false
        var ended = false
        var framesIn = 0
        var firstFrameLogged = false
    }

    private init() {
        let d = UserDefaults.standard
        serverURL = d.string(forKey: "lab.serverURL") ?? "ws://127.0.0.1:8787"
        token = d.string(forKey: "lab.token") ?? ""
        conversationId = d.string(forKey: "lab.conversation") ?? "lab-1"
    }

    // MARK: launch

    func start() {
        guard !started else { return }
        started = true
        AppStateTracker.install()
        AudioIO.configureCategory()
        log.onAppend = { [weak self] _ in Task { @MainActor in self?.refreshTail() } }

        ptt.isTransmittingProvider = { [weak self] in
            // Read without hopping to the main actor: the push callback must not block.
            self?.phaseSnapshot.isTransmitting ?? false
        }
        ptt.displayNameProvider = { _ in nil }
        ptt.onEvent = { [weak self] e in Task { @MainActor in self?.handle(e) } }

        net.onState = { [weak self] s in Task { @MainActor in self?.netState(s) } }
        net.onMessage = { [weak self] m in Task { @MainActor in self?.netMessage(m) } }
        net.onFrame = { [weak self] seq, payload in Task { @MainActor in self?.netFrame(seq, payload) } }

        audio.onCaptureFrame = { [weak self] seq, data in self?.net.sendFrame(seq: seq, payload: data) }
        audio.onFirstPlayedBack = { [weak self] in Task { @MainActor in self?.rxFirstPlayedBack() } }
        audio.onDrained = { [weak self] in Task { @MainActor in self?.rxDrained() } }

        Task { await ptt.start() }
    }

    /// Lock-protected mirror of the phase, readable from the push callback thread.
    private let phaseSnapshot = PhaseSnapshot()
    private final class PhaseSnapshot: @unchecked Sendable {
        private let lock = NSLock()
        private var live = false
        var isTransmitting: Bool { lock.lock(); defer { lock.unlock() }; return live }
        func set(_ phase: TransmitPhase) { lock.lock(); live = (phase == .live || phase == .starting); lock.unlock() }
    }

    // MARK: user actions (harness calls these)

    func connect() {
        guard let url = URL(string: serverURL), !token.isEmpty else {
            notice = "Set a server URL and token first"
            return
        }
        net.connect(.init(url: url, token: token, deviceId: UIDevice.current.name.prefix(32).description))
    }

    func disconnect() { net.disconnect() }
    func join() { ptt.join() }
    func leave() { ptt.leave() }

    func press(_ source: TransmitSource = .inApp) {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: drive(.press(source))
        case .denied: drive(.press(source)); drive(.micPermissionDenied)
        case .undetermined:
            AVAudioApplication.requestRecordPermission { [weak self] granted in
                Task { @MainActor in
                    self?.log.record("mic.permission", ["granted": "\(granted)"])
                    self?.notice = granted ? "Microphone allowed. Press again." : "Microphone denied"
                }
            }
        @unknown default: break
        }
    }

    func release(_ source: TransmitSource = .inApp) { drive(.release(source)) }
    func toggle(_ source: TransmitSource) { drive(.toggle(source)) }

    func setMode(_ mode: PTTransmissionMode) { Task { await ptt.setTransmissionMode(mode) } }
    func clearLog() { log.clear(); logTail = [] }

    // MARK: state machine driver

    private func drive(_ event: TransmitEvent) {
        let before = machine.phase
        let effects = machine.handle(event)
        phase = machine.phase
        phaseSnapshot.set(machine.phase)
        log.record("tx.event", ["event": "\(event)", "from": "\(before)", "to": "\(machine.phase)", "tx": machine.transmissionId ?? "-"])
        for fx in effects { run(fx) }
    }

    private func run(_ fx: TransmitEffect) {
        switch fx {
        case .requestFloor(let id):
            guard net.state == .connected else {
                log.record("tx.floor-not-sent", ["why": "not-connected"])
                drive(.connectionLost)
                return
            }
            let req = UUID().uuidString.lowercased()
            pendingReqTransmission[req] = id
            log.record("tx.floor-requested", ["tx": id])
            net.send(.floorRequest(reqId: req, conversationId: conversationId, transmissionId: id))
        case .releaseFloor(let id, let aborted):
            log.record("tx.floor-release-sent", ["tx": id, "aborted": "\(aborted)"])
            net.send(.floorRelease(transmissionId: id, aborted: aborted))
        case .requestSystemTransmit:
            guard joined else {
                log.record("tx.system-transmit-refused", ["why": "not-joined"])
                drive(.systemFailedToBegin)
                return
            }
            ptt.requestBeginTransmitting()
        case .stopSystemTransmit:
            ptt.stopTransmitting()
        case .startCapture(let id):
            log.record("tx.capture-start", ["tx": id])
            if !audio.startCapture() { drive(.audioInterrupted) }
        case .stopCapture:
            audio.stopCapture()
            log.record("tx.capture-stop")
        case .armWatchdog(let seconds, let epoch):
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(seconds))
                self?.drive(.watchdogFired(epoch: epoch))
            }
        case .notify(let n):
            notice = Self.text(for: n)
            log.record("tx.notice", ["notice": "\(n)"])
            UINotificationFeedbackGenerator().notificationOccurred({
                switch n { case .busy, .micDenied: return .error; case .ignoredPress: return .warning; default: return .warning }
            }())
        }
    }

    private static func text(for n: TransmitNotice) -> String {
        switch n {
        case .busy(let r): return "Busy (\(r))"
        case .ended(let r): return "Ended (\(r))"
        case .micDenied: return "Microphone denied"
        case .interrupted: return "Interrupted"
        case .ignoredPress: return "Wait for the previous transmission to finish"
        }
    }

    // MARK: PTT events

    private func handle(_ e: PTTEvent) {
        switch e {
        case .managerReady(let restored):
            managerStatus = restored == nil ? "ready" : "ready (restored channel)"
            if restored != nil { joined = true }
        case .managerFailed(let why):
            managerStatus = "failed: \(why)"
        case .joined:
            joined = true
            Task { await ptt.setServiceStatus(.ready) }
            registerListeningIfPossible()
        case .left:
            joined = false
            tokenHex = nil
            net.send(.listeningUnregister)
            drive(.connectionLost)   // no joined channel: any in-flight start must stop
        case .joinFailed(let why): notice = "Join failed: \(why)"
        case .leaveFailed(let why): notice = "Leave failed: \(why)"
        case .ephemeralToken(let hex):
            tokenHex = hex
            registerListeningIfPossible()
        case .beganTransmitting(let s): drive(.systemDidBegin(s))
        case .endedTransmitting(let s): drive(.systemDidEnd(s))
        case .failedToBegin(let why):
            notice = "Could not begin: \(why)"
            drive(.systemFailedToBegin)
        case .failedToStop: break
        case .audioActivated:
            audio.sessionActivated()
            if rx != nil { rx?.activated = true; log.record("rx.audio-activated", ["sincePushMs": sincePush()]) }
            drive(.audioActivated)
        case .audioDeactivated:
            audio.sessionDeactivated()
            drive(.audioDeactivated)
        case .incomingPush(let id, let ref):
            incomingPush(transmissionId: id, senderRef: ref)
        }
    }

    private func registerListeningIfPossible() {
        guard net.state == .connected, joined else { return }
        net.send(.listeningRegister(pttToken: tokenHex))
        log.record("net.listening-register-sent", ["hasToken": "\(tokenHex != nil)"])
    }

    // MARK: incoming transmissions

    private func incomingPush(transmissionId: String?, senderRef: String?) {
        log.record("rx.push-callback", ["tx": transmissionId ?? "none"])
        guard let id = transmissionId, UUID(uuidString: id) != nil, !handledPushIds.contains(id) else {
            // Stale, duplicate or malformed. incomingPushResult already had to report
            // a participant (leaveChannel would eject the user), so clear it again.
            log.record("rx.push-stale-or-duplicate", ["tx": transmissionId ?? "none"])
            Task { await ptt.setActiveRemoteParticipant(name: nil) }
            return
        }
        handledPushIds.append(id)
        if handledPushIds.count > 256 { handledPushIds.removeFirst(64) }
        rx = Rx(transmissionId: id)
        audio.resetPlayback()
        if net.state == .connected {
            attach(id)
        } else {
            log.record("rx.connect-started", ["sincePushMs": sincePush()])
            connect()   // the attach is sent when hello succeeds
        }
        // Do not leave the system showing a speaker forever if the stream never arrives.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard let self, let r = self.rx, r.transmissionId == id else { return }
            self.log.record("rx.timeout", ["attached": "\(r.attached)", "frames": "\(r.framesIn)"])
            self.finishReceive()
        }
    }

    private func attach(_ id: String) {
        log.record("rx.attach-sent", ["sincePushMs": sincePush()])
        net.send(.attach(transmissionId: id))
    }

    private func netFrame(_ seq: UInt32, _ payload: Data) {
        guard rx != nil else { return }
        rx?.framesIn += 1
        if rx?.firstFrameLogged == false {
            rx?.firstFrameLogged = true
            log.record("rx.first-frame", ["seq": "\(seq)", "sincePushMs": sincePush()])
        }
        audio.play(payload: payload)
    }

    private func rxFirstPlayedBack() {
        log.record("rx.first-played-back", ["sincePushMs": sincePush()])
    }

    private func rxDrained() {
        guard rx?.ended == true else { return }
        finishReceive()
    }

    private func finishReceive() {
        guard let r = rx else { return }
        log.record("rx.complete", ["tx": r.transmissionId, "frames": "\(r.framesIn)", "totalMs": sincePush()])
        rx = nil
        Task { await ptt.setActiveRemoteParticipant(name: nil) }
    }

    private func sincePush() -> String {
        guard let r = rx else { return "-" }
        return String(format: "%.1f", LabLog.mono() - r.pushAtMs)
    }

    // MARK: network events

    private func netState(_ s: LabConnection.State) {
        connection = s
        log.record("net.state", ["state": s.rawValue])
        if s == .disconnected {
            // A lost connection is a forced stop. It never resumes on its own.
            drive(.connectionLost)
            if rx != nil, rx?.attached == true { audio.markEndOfStream(); rx?.ended = true }
        }
    }

    private func netMessage(_ m: ServerMessage) {
        switch m {
        case .helloOK:
            registerListeningIfPossible()
            if let r = rx, !r.attached { attach(r.transmissionId) }
        case .helloDenied(let why): notice = "Server refused: \(why)"
        case .listeningOK: log.record("net.listening-ok")
        case .floorGranted(let req, let id, _, _, let reachable):
            pendingReqTransmission[req] = nil
            log.record("tx.floor-granted", ["tx": id, "reachable": "\(reachable)"])
            drive(.floorGranted(id))
        case .floorDenied(let req, let reason):
            let id = pendingReqTransmission.removeValue(forKey: req) ?? ""
            log.record("tx.floor-denied", ["tx": id, "reason": reason])
            drive(.floorDenied(id, reason: reason))
        case .floorEnded(let id, let reason):
            log.record("tx.floor-ended", ["tx": id, "reason": reason])
            drive(.floorEnded(id, reason: reason))
        case .attachOK(let id, let startSeq, let headDropped):
            guard rx?.transmissionId == id else { return }
            rx?.attached = true
            log.record("rx.attach-ok", ["startSeq": "\(startSeq)", "headDropped": "\(headDropped)", "sincePushMs": sincePush()])
        case .attachDenied(let id):
            log.record("rx.attach-denied", ["tx": id])
            if rx?.transmissionId == id { finishReceive() }
        case .transmissionEnded(let id, let reason, _):
            guard rx?.transmissionId == id else { return }
            rx?.ended = true
            log.record("rx.transmission-ended", ["reason": reason, "sincePushMs": sincePush()])
            audio.markEndOfStream()
        case .clockPong, .error, .unknown: break
        }
    }

    private func refreshTail() {
        // Pulled lazily; the file is the source of truth for evidence.
        objectWillChange.send()
    }
}
