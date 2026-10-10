import Foundation

/// Experiment event log. Writes JSON lines to Documents/lab-events.jsonl (readable
/// from the Files app because file sharing is enabled) and keeps a short tail in
/// memory for the harness. Records identifiers, timings and outcomes only: never
/// audio, and never real participant identities.
final class LabLog: @unchecked Sendable {
    static let shared = LabLog()

    struct Entry: Identifiable {
        let id = UUID()
        let mono: Double
        let wall: Double
        let event: String
        let fields: [String: String]
    }

    private let queue = DispatchQueue(label: "chirp.lab.log")
    private let fileURL: URL
    private var tail: [Entry] = []
    var onAppend: (@Sendable (Entry) -> Void)?

    private init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        fileURL = docs.appendingPathComponent("lab-events.jsonl")
    }

    /// Monotonic clock in milliseconds, for intervals within one device.
    static func mono() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }

    func record(_ event: String, _ fields: [String: String] = [:]) {
        let entry = Entry(mono: Self.mono(), wall: Date().timeIntervalSince1970 * 1000, event: event, fields: fields)
        queue.async {
            self.tail.append(entry)
            if self.tail.count > 400 { self.tail.removeFirst(100) }
            var obj: [String: Any] = ["mono": entry.mono, "wall": entry.wall, "event": event]
            for (k, v) in fields { obj[k] = v }
            if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
               var line = String(data: data, encoding: .utf8) {
                line += "\n"
                if let h = try? FileHandle(forWritingTo: self.fileURL) {
                    h.seekToEndOfFile()
                    h.write(Data(line.utf8))
                    try? h.close()
                } else {
                    try? line.write(to: self.fileURL, atomically: true, encoding: .utf8)
                }
            }
            self.onAppend?(entry)
        }
    }

    func clear() {
        queue.async {
            self.tail.removeAll()
            try? FileManager.default.removeItem(at: self.fileURL)
        }
    }
}
