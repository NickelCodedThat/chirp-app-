import ChirpCore
import Foundation

/// WebSocket client for the lab server. Control messages are JSON text, audio is
/// binary frames. Reconnecting restores the control channel only: it never
/// resumes a transmission (the model treats a lost connection as a forced stop).
final class LabConnection: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    enum State: String { case disconnected, connecting, connected }

    struct Config {
        var url: URL
        var token: String
        var deviceId: String
    }

    /// All callbacks arrive on the main queue.
    var onState: (@Sendable (State) -> Void)?
    var onMessage: (@Sendable (ServerMessage) -> Void)?
    var onFrame: (@Sendable (UInt32, Data) -> Void)?

    private let log = LabLog.shared
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var config: Config?
    private let lock = NSLock()
    private var generation = 0
    private(set) var state: State = .disconnected

    func connect(_ config: Config) {
        lock.lock()
        generation += 1
        let gen = generation
        self.config = config
        lock.unlock()

        task?.cancel(with: .goingAway, reason: nil)
        set(.connecting)
        log.record("net.connect-begin", ["host": config.url.host ?? "?"])
        let s = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        session = s
        let t = s.webSocketTask(with: config.url)
        task = t
        t.resume()
        send(.hello(token: config.token, deviceId: config.deviceId))
        receiveLoop(t, gen)
    }

    func disconnect() {
        lock.lock(); generation += 1; lock.unlock()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        set(.disconnected)
    }

    func send(_ msg: ClientMessage) {
        guard let task, let text = try? msg.encoded() else { return }
        task.send(.string(text)) { [log] error in
            if let error { log.record("net.send-failed", ["error": error.localizedDescription]) }
        }
    }

    func sendFrame(seq: UInt32, payload: Data) {
        guard let task else { return }
        task.send(.data(FrameCodec.encode(seq: seq, payload: payload))) { _ in }
    }

    // MARK: URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        log.record("net.socket-open")
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        log.record("net.socket-closed", ["code": "\(closeCode.rawValue)"])
        handleLoss(webSocketTask)
    }

    // MARK: private

    private func receiveLoop(_ t: URLSessionWebSocketTask, _ gen: Int) {
        t.receive { [weak self] result in
            guard let self else { return }
            self.lock.lock(); let current = self.generation; self.lock.unlock()
            guard gen == current else { return }
            switch result {
            case .failure(let error):
                self.log.record("net.receive-failed", ["error": error.localizedDescription])
                self.handleLoss(t)
            case .success(let message):
                switch message {
                case .string(let text):
                    if let m = try? ServerMessage.decode(text) {
                        if case .helloOK = m { self.set(.connected) }
                        DispatchQueue.main.async { self.onMessage?(m) }
                    }
                case .data(let d):
                    if let f = FrameCodec.decode(d) {
                        DispatchQueue.main.async { self.onFrame?(f.seq, f.payload) }
                    }
                @unknown default: break
                }
                self.receiveLoop(t, gen)
            }
        }
    }

    private func handleLoss(_ t: URLSessionWebSocketTask) {
        guard t === task else { return }
        task = nil
        set(.disconnected)
    }

    private func set(_ s: State) {
        state = s
        DispatchQueue.main.async { self.onState?(s) }
    }
}
