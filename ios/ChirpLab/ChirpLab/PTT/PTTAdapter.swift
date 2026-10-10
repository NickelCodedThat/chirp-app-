import AVFAudio
import ChirpCore
import Foundation
import PushToTalk
import UIKit

/// Everything Apple-specific about Push to Talk lives here. The rest of the app
/// sees only `PTTEvent`s and a handful of commands, so the shared protocol,
/// floor control and transport never depend on this framework.
///
/// Rules this class follows (from Apple's documentation):
///   - Create the channel manager at launch.
///   - Join only from a foreground user action.
///   - Never activate or deactivate the audio session; wait for didActivate.
///   - Return from incomingPushResult immediately.
///   - Never answer a push with `leaveChannel` as a generic failure: it removes
///     the user from their listening session.
enum PTTEvent {
    case managerReady(restoredChannel: UUID?)
    case managerFailed(String)
    case joined(reason: String)
    case left(reason: String)
    case joinFailed(String)
    case leaveFailed(String)
    case ephemeralToken(hex: String)
    case beganTransmitting(TransmitSource)
    case endedTransmitting(TransmitSource)
    case failedToBegin(String)
    case failedToStop(String)
    case audioActivated
    case audioDeactivated
    /// A push arrived. `transmissionId` is nil if the payload was unusable.
    case incomingPush(transmissionId: String?, senderRef: String?)
}

final class PTTAdapter: NSObject, PTChannelManagerDelegate, PTChannelRestorationDelegate, @unchecked Sendable {
    /// Delivered on the main queue.
    var onEvent: (@Sendable (PTTEvent) -> Void)?

    /// Set by the model so incomingPushResult can stop a local transmission
    /// first (required by half-duplex mode when a push arrives mid-transmit).
    var isTransmittingProvider: (@Sendable () -> Bool)?
    /// Looks up a display name for an opaque sender reference from local cache.
    var displayNameProvider: (@Sendable (String) -> String?)?

    private(set) var manager: PTChannelManager?
    let channelUUID: UUID
    private let descriptor = PTChannelDescriptor(name: "Chirp Lab", image: nil)
    private let log = LabLog.shared

    override init() {
        // One stable channel identifier per install: Apple expects a single
        // long-lived channel, not one per conversation.
        let key = "chirp.lab.channelUUID"
        if let s = UserDefaults.standard.string(forKey: key), let u = UUID(uuidString: s) {
            channelUUID = u
        } else {
            let u = UUID()
            UserDefaults.standard.set(u.uuidString, forKey: key)
            channelUUID = u
        }
        super.init()
    }

    // MARK: commands

    func start() async {
        log.record("ptt.manager-create-begin")
        do {
            let m = try await PTChannelManager.channelManager(delegate: self, restorationDelegate: self)
            manager = m
            let active = m.activeChannelUUID
            log.record("ptt.manager-ready", ["activeChannel": active?.uuidString ?? "none"])
            emit(.managerReady(restoredChannel: active))
        } catch {
            let desc = Self.describe(error)
            log.record("ptt.manager-failed", ["error": desc])
            emit(.managerFailed(desc))
        }
    }

    /// Must be called from a foreground user action.
    func join() {
        guard let manager else { return log.record("ptt.join-skipped", ["why": "no-manager"]) }
        log.record("ptt.join-requested")
        manager.requestJoinChannel(channelUUID: channelUUID, descriptor: descriptor)
    }

    func leave() {
        guard let manager else { return }
        log.record("ptt.leave-requested")
        manager.leaveChannel(channelUUID: channelUUID)
    }

    func requestBeginTransmitting() {
        log.record("ptt.request-begin")
        manager?.requestBeginTransmitting(channelUUID: channelUUID)
    }

    func stopTransmitting() {
        log.record("ptt.request-stop")
        manager?.stopTransmitting(channelUUID: channelUUID)
    }

    func setServiceStatus(_ status: PTServiceStatus) async {
        guard let manager else { return }
        log.record("ptt.service-status", ["status": "\(status)"])
        do { try await manager.setServiceStatus(status, channelUUID: channelUUID) }
        catch { log.record("ptt.service-status-failed", ["error": Self.describe(error)]) }
    }

    func setActiveRemoteParticipant(name: String?) async {
        guard let manager else { return }
        let participant = name.map { PTParticipant(name: $0, image: nil) }
        log.record("ptt.active-remote", ["participant": name == nil ? "none" : "set"])
        do { try await manager.setActiveRemoteParticipant(participant, channelUUID: channelUUID) }
        catch { log.record("ptt.active-remote-failed", ["error": Self.describe(error)]) }
    }

    func setTransmissionMode(_ mode: PTTransmissionMode) async {
        guard let manager else { return }
        log.record("ptt.transmission-mode", ["mode": "\(mode)"])
        do { try await manager.setTransmissionMode(mode, channelUUID: channelUUID) }
        catch { log.record("ptt.transmission-mode-failed", ["error": Self.describe(error)]) }
    }

    func setAccessoryButtonEvents(enabled: Bool) async {
        guard let manager else { return }
        do { try await manager.setAccessoryButtonEventsEnabled(enabled, channelUUID: channelUUID) }
        catch { log.record("ptt.accessory-events-failed", ["error": Self.describe(error)]) }
    }

    // MARK: PTChannelRestorationDelegate

    func channelDescriptor(restoredChannelUUID channelUUID: UUID) -> PTChannelDescriptor {
        // Must return immediately with no network work.
        log.record("ptt.restoration-descriptor", ["channel": channelUUID.uuidString])
        return descriptor
    }

    // MARK: PTChannelManagerDelegate: join / leave / token

    func channelManager(_ channelManager: PTChannelManager, didJoinChannel channelUUID: UUID, reason: PTChannelJoinReason) {
        let r = Self.describe(reason)
        log.record("ptt.did-join", ["reason": r])
        emit(.joined(reason: r))
    }

    func channelManager(_ channelManager: PTChannelManager, didLeaveChannel channelUUID: UUID, reason: PTChannelLeaveReason) {
        let r = Self.describe(reason)
        log.record("ptt.did-leave", ["reason": r])
        emit(.left(reason: r))
    }

    func channelManager(_ channelManager: PTChannelManager, failedToJoinChannel channelUUID: UUID, error: any Error) {
        let d = Self.describe(error)
        log.record("ptt.join-failed", ["error": d])
        emit(.joinFailed(d))
    }

    func channelManager(_ channelManager: PTChannelManager, failedToLeaveChannel channelUUID: UUID, error: any Error) {
        let d = Self.describe(error)
        log.record("ptt.leave-failed", ["error": d])
        emit(.leaveFailed(d))
    }

    func channelManager(_ channelManager: PTChannelManager, receivedEphemeralPushToken pushToken: Data) {
        let hex = pushToken.map { String(format: "%02x", $0) }.joined()
        // Log only the length: the token itself is a credential for pushing to this device.
        log.record("ptt.ephemeral-token", ["bytes": "\(pushToken.count)"])
        emit(.ephemeralToken(hex: hex))
    }

    // MARK: transmit

    func channelManager(_ channelManager: PTChannelManager, channelUUID: UUID, didBeginTransmittingFrom source: PTChannelTransmitRequestSource) {
        log.record("ptt.did-begin-transmitting", ["source": Self.describe(source)])
        emit(.beganTransmitting(Self.map(source)))
    }

    func channelManager(_ channelManager: PTChannelManager, channelUUID: UUID, didEndTransmittingFrom source: PTChannelTransmitRequestSource) {
        log.record("ptt.did-end-transmitting", ["source": Self.describe(source)])
        emit(.endedTransmitting(Self.map(source)))
    }

    func channelManager(_ channelManager: PTChannelManager, failedToBeginTransmittingInChannel channelUUID: UUID, error: any Error) {
        let d = Self.describe(error)
        log.record("ptt.failed-to-begin", ["error": d])
        emit(.failedToBegin(d))
    }

    func channelManager(_ channelManager: PTChannelManager, failedToStopTransmittingInChannel channelUUID: UUID, error: any Error) {
        let d = Self.describe(error)
        log.record("ptt.failed-to-stop", ["error": d])
        emit(.failedToStop(d))
    }

    // MARK: audio session (owned by the system)

    func channelManager(_ channelManager: PTChannelManager, didActivate audioSession: AVAudioSession) {
        log.record("ptt.did-activate")
        emit(.audioActivated)
    }

    func channelManager(_ channelManager: PTChannelManager, didDeactivate audioSession: AVAudioSession) {
        log.record("ptt.did-deactivate")
        emit(.audioDeactivated)
    }

    // MARK: incoming push

    func incomingPushResult(channelManager: PTChannelManager, channelUUID: UUID, pushPayload: [String: Any]) -> PTPushResult {
        let t = LabLog.mono()
        let transmissionId = pushPayload["transmissionId"] as? String
        let senderRef = pushPayload["senderRef"] as? String
        log.record("ptt.incoming-push", [
            "transmissionId": transmissionId ?? "none",
            "payloadKeys": pushPayload.keys.sorted().joined(separator: ","),
            "appState": Self.appStateName(),
        ])

        // Half-duplex: a local transmission must end before a remote participant
        // can be reported, otherwise the framework returns an error.
        if isTransmittingProvider?() == true {
            log.record("ptt.push-while-transmitting")
            channelManager.stopTransmitting(channelUUID: channelUUID)
        }

        emit(.incomingPush(transmissionId: transmissionId, senderRef: senderRef))

        // Always report a participant: the only other result is leaveChannel, which
        // would eject the user. A stale or malformed push is cleared by the model
        // right after this returns.
        let name = senderRef.flatMap { displayNameProvider?($0) } ?? "Chirp Lab"
        log.record("ptt.incoming-push-returned", ["handlerMs": String(format: "%.2f", LabLog.mono() - t)])
        return .activeRemoteParticipant(PTParticipant(name: name, image: nil))
    }

    // MARK: helpers

    private func emit(_ e: PTTEvent) {
        DispatchQueue.main.async { [weak self] in self?.onEvent?(e) }
    }

    private static func map(_ s: PTChannelTransmitRequestSource) -> TransmitSource {
        switch s {
        case .userRequest: return .systemUI
        case .developerRequest: return .inApp
        case .handsfreeButton: return .accessory
        default: return .unknown
        }
    }

    static func describe(_ s: PTChannelTransmitRequestSource) -> String {
        switch s {
        case .userRequest: return "userRequest"
        case .developerRequest: return "developerRequest"
        case .handsfreeButton: return "handsfreeButton"
        default: return "unknown"
        }
    }

    static func describe(_ r: PTChannelJoinReason) -> String {
        switch r {
        case .developerRequest: return "developerRequest"
        case .channelRestoration: return "channelRestoration"
        default: return "unknown"
        }
    }

    static func describe(_ r: PTChannelLeaveReason) -> String {
        switch r {
        case .userRequest: return "userRequest"
        case .developerRequest: return "developerRequest"
        case .systemPolicy: return "systemPolicy"
        default: return "unknown"
        }
    }

    static func describe(_ error: any Error) -> String {
        let ns = error as NSError
        // Prefer the framework's typed case name over a bare numeric code.
        var typed = ""
        if let e = error as? PTInstantiationError { typed = "instantiation.\(instantiationName(e.code)) " }
        else if let e = error as? PTChannelError { typed = "channel.\(channelName(e.code)) " }
        return "\(typed)\(ns.domain)#\(ns.code)"
    }

    private static func instantiationName(_ c: PTInstantiationError.Code) -> String {
        switch c {
        case .invalidPlatform: return "invalidPlatform"
        case .missingBackgroundMode: return "missingBackgroundMode"
        case .missingPushServerEnvironment: return "missingPushServerEnvironment"
        case .missingEntitlement: return "missingEntitlement"
        case .instantiationAlreadyInProgress: return "instantiationAlreadyInProgress"
        case .unknown: return "unknown"
        @unknown default: return "raw\(c.rawValue)"
        }
    }

    private static func channelName(_ c: PTChannelError.Code) -> String {
        switch c {
        case .appNotForeground: return "appNotForeground"
        case .channelNotFound: return "channelNotFound"
        case .channelLimitReached: return "channelLimitReached"
        case .callActive: return "callActive"
        case .transmissionInProgress: return "transmissionInProgress"
        case .transmissionNotFound: return "transmissionNotFound"
        case .deviceManagementRestriction: return "deviceManagementRestriction"
        case .screenTimeRestriction: return "screenTimeRestriction"
        case .transmissionNotAllowed: return "transmissionNotAllowed"
        case .unknown: return "unknown"
        @unknown default: return "raw\(c.rawValue)"
        }
    }

    /// Cached app state, readable from any thread without blocking. Never hop to
    /// the main thread synchronously inside incomingPushResult.
    private static func appStateName() -> String { AppStateTracker.shared.name }
}

/// Tracks UIApplication lifecycle via notifications so the push callback can
/// record the app state without touching UIKit off the main thread.
final class AppStateTracker: @unchecked Sendable {
    static let shared = AppStateTracker()
    private let lock = NSLock()
    private var current = "launching"

    var name: String { lock.lock(); defer { lock.unlock() }; return current }

    private init() {
        let nc = NotificationCenter.default
        let pairs: [(Notification.Name, String)] = [
            (UIApplication.didBecomeActiveNotification, "active"),
            (UIApplication.willResignActiveNotification, "inactive"),
            (UIApplication.didEnterBackgroundNotification, "background"),
            (UIApplication.willEnterForegroundNotification, "inactive"),
        ]
        for (n, label) in pairs {
            nc.addObserver(forName: n, object: nil, queue: nil) { [weak self] _ in self?.set(label) }
        }
    }

    private func set(_ v: String) { lock.lock(); current = v; lock.unlock() }

    /// Touch once at launch so the observers are installed before any push.
    static func install() { _ = shared }
}
