import AVFAudio
import Foundation

/// Capture and playback for the lab. 16 kHz mono signed 16-bit little-endian PCM,
/// 20 ms frames (640 bytes). PCM is a stand-in so the lifecycle can be proven
/// before the transport/codec decision (Experiment D); it is not a product codec.
///
/// Audio-session rules (Apple Push to Talk):
///   - This class never activates or deactivates the AVAudioSession. The engine
///     is started in `sessionActivated()` (called from didActivate) and stopped
///     in `sessionDeactivated()`.
///   - The microphone tap exists only between `startCapture` and `stopCapture`.
///
/// Nothing here writes audio to disk or to logs. The pre-activation queue is RAM
/// only and bounded (five seconds).
final class AudioIO: @unchecked Sendable {
    static let sampleRate = 16_000.0
    static let frameSamples = 320            // 20 ms at 16 kHz
    static let maxPendingFrames = 250        // 5 s, matches the approved temporary-buffer bound

    /// Called on an internal queue for each captured 20 ms frame.
    var onCaptureFrame: (@Sendable (UInt32, Data) -> Void)?
    /// Called once per playback stream, when the first buffer has actually been played back.
    var onFirstPlayedBack: (@Sendable () -> Void)?
    /// Called when end-of-stream was marked and everything scheduled has played.
    var onDrained: (@Sendable () -> Void)?

    private let log = LabLog.shared
    private let q = DispatchQueue(label: "chirp.audio")
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!
    private let wireFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true)!

    // q-confined state
    private var graphBuilt = false
    private var engineRunning = false
    private var capturing = false
    private var captureSeq: UInt32 = 0
    private var preActivation: [Data] = []
    private var preActivationDropped = 0
    private var scheduled = 0
    private var playedBack = 0
    private var firstDecodedLogged = false
    private var firstPlayedBackLogged = false
    private var endOfStream = false
    private var drainedFired = false
    private var tapPending: [Int16] = []   // only touched on the tap thread

    // MARK: session lifecycle (driven by the PTT framework callbacks)

    /// Called once at launch. Sets the category only; activation belongs to the system.
    static func configureCategory() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP, .defaultToSpeaker])
            LabLog.shared.record("audio.category-set")
        } catch {
            LabLog.shared.record("audio.category-failed", ["error": error.localizedDescription])
        }
    }

    func sessionActivated() {
        q.async {
            self.buildGraphIfNeeded()
            do {
                try self.engine.start()
                self.engineRunning = true
                self.log.record("audio.engine-started")
            } catch {
                self.log.record("audio.engine-start-failed", ["error": error.localizedDescription])
                return
            }
            if !self.preActivation.isEmpty || self.scheduled > 0 || !self.endOfStream {
                self.player.play()
            }
            let queued = self.preActivation
            self.preActivation.removeAll()
            if !queued.isEmpty { self.log.record("audio.flush-pre-activation", ["frames": "\(queued.count)", "dropped": "\(self.preActivationDropped)"]) }
            for d in queued { self.scheduleLocked(d) }
        }
    }

    func sessionDeactivated() {
        q.async {
            self.stopCaptureLocked()
            self.player.stop()
            if self.engineRunning { self.engine.stop() }
            self.engineRunning = false
            self.log.record("audio.engine-stopped")
        }
    }

    // MARK: capture

    /// Starts capturing. Returns false if the engine is not running (the system has
    /// not activated the session), in which case no microphone data is read.
    @discardableResult
    func startCapture() -> Bool {
        q.sync {
            guard engineRunning else {
                log.record("audio.capture-refused", ["why": "engine-not-running"])
                return false
            }
            guard !capturing else { return true }
            buildGraphIfNeeded()
            let input = engine.inputNode
            let inFormat = input.outputFormat(forBus: 0)
            guard inFormat.sampleRate > 0, let converter = AVAudioConverter(from: inFormat, to: wireFormat) else {
                log.record("audio.capture-refused", ["why": "no-input-format"])
                return false
            }
            captureSeq = 0
            tapPending.removeAll(keepingCapacity: true)
            input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] buffer, _ in
                self?.process(buffer, converter: converter)
            }
            capturing = true
            log.record("audio.capture-started", ["inputRate": "\(Int(inFormat.sampleRate))"])
            return true
        }
    }

    func stopCapture() {
        q.sync { stopCaptureLocked() }
    }

    var isCapturing: Bool { q.sync { capturing } }

    private func stopCaptureLocked() {
        guard capturing else { return }
        engine.inputNode.removeTap(onBus: 0)
        capturing = false
        log.record("audio.capture-stopped", ["frames": "\(captureSeq)"])
    }

    private func process(_ buffer: AVAudioPCMBuffer, converter: AVAudioConverter) {
        let ratio = Self.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let ch = out.int16ChannelData?[0] else { return }
        tapPending.append(contentsOf: UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))
        while tapPending.count >= Self.frameSamples {
            let chunk = Array(tapPending.prefix(Self.frameSamples))
            tapPending.removeFirst(Self.frameSamples)
            let data = chunk.withUnsafeBufferPointer { Data(buffer: $0) }   // little-endian on Apple platforms
            let s = captureSeq
            captureSeq &+= 1
            onCaptureFrame?(s, data)
        }
    }

    // MARK: playback

    /// Queues a received frame. Safe to call before the system has activated the session.
    func play(payload: Data) {
        q.async {
            if self.engineRunning {
                self.scheduleLocked(payload)
            } else {
                if self.preActivation.count >= Self.maxPendingFrames {
                    self.preActivation.removeFirst()
                    self.preActivationDropped += 1
                }
                self.preActivation.append(payload)
            }
        }
    }

    func markEndOfStream() {
        q.async {
            self.endOfStream = true
            self.checkDrained()
        }
    }

    /// Prepares for a new incoming transmission.
    func resetPlayback() {
        q.async {
            self.preActivation.removeAll()
            self.preActivationDropped = 0
            self.scheduled = 0
            self.playedBack = 0
            self.firstDecodedLogged = false
            self.firstPlayedBackLogged = false
            self.endOfStream = false
            self.drainedFired = false
            if self.graphBuilt { self.player.stop() }
        }
    }

    private func scheduleLocked(_ payload: Data) {
        let n = payload.count / 2
        guard n > 0, let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(n)),
              let dst = buf.floatChannelData?[0] else { return }
        buf.frameLength = AVAudioFrameCount(n)
        payload.withUnsafeBytes { raw in
            let src = raw.bindMemory(to: Int16.self)
            for i in 0..<n { dst[i] = Float(Int16(littleEndian: src[i])) / 32768.0 }
        }
        if !firstDecodedLogged {
            firstDecodedLogged = true
            log.record("audio.first-decoded")
        }
        scheduled += 1
        if !player.isPlaying { player.play() }
        player.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            self?.q.async {
                guard let self else { return }
                self.playedBack += 1
                if !self.firstPlayedBackLogged {
                    self.firstPlayedBackLogged = true
                    // "Played back" means the buffer finished rendering to the output. It is
                    // the closest on-device signal to "audible"; the acoustic recording is the proof.
                    self.log.record("audio.first-played-back")
                    self.onFirstPlayedBack?()
                }
                self.checkDrained()
            }
        }
    }

    private func checkDrained() {
        guard endOfStream, !drainedFired else { return }
        // Drained means everything we scheduled has played, and nothing is still
        // waiting for the system to activate the session.
        let allPlayed = scheduled > 0 ? playedBack >= scheduled : preActivation.isEmpty
        guard allPlayed, preActivation.isEmpty else { return }
        drainedFired = true
        log.record("audio.drained", ["frames": "\(playedBack)"])
        onDrained?()
    }

    private func buildGraphIfNeeded() {
        guard !graphBuilt else { return }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        graphBuilt = true
    }
}
