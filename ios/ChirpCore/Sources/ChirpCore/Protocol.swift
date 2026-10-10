import Foundation

// Swift mirror of server/src/protocol.ts. Control messages are JSON text;
// audio is a binary frame: 4-byte big-endian sequence number, then payload.
// Golden fixtures in the tests keep this in step with the server.

public let chirpProtocolVersion = 1

public enum ClientMessage: Sendable, Equatable {
    case hello(token: String, deviceId: String)
    case listeningRegister(pttToken: String?)
    case listeningUnregister
    case floorRequest(reqId: String, conversationId: String, transmissionId: String)
    case floorRelease(transmissionId: String, aborted: Bool)
    case attach(transmissionId: String)
    case clockPing(clientSentMs: Double)

    public func encoded() throws -> String {
        var d: [String: Any]
        switch self {
        case .hello(let token, let deviceId):
            d = ["type": "hello", "token": token, "deviceId": deviceId, "protocol": chirpProtocolVersion]
        case .listeningRegister(let t):
            d = ["type": "listening.register"]
            if let t { d["pttToken"] = t }
        case .listeningUnregister:
            d = ["type": "listening.unregister"]
        case .floorRequest(let reqId, let conversationId, let transmissionId):
            d = ["type": "floor.request", "reqId": reqId, "conversationId": conversationId, "transmissionId": transmissionId]
        case .floorRelease(let id, let aborted):
            d = ["type": "floor.release", "transmissionId": id, "reason": aborted ? "sender-aborted" : "released"]
        case .attach(let id):
            d = ["type": "attach", "transmissionId": id]
        case .clockPing(let ms):
            d = ["type": "clock.ping", "clientSentMs": ms]
        }
        let data = try JSONSerialization.data(withJSONObject: d, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }
}

public enum ServerMessage: Sendable, Equatable {
    case helloOK(participantRef: String, serverTimeMs: Double)
    case helloDenied(reason: String)
    case listeningOK
    case floorGranted(reqId: String, transmissionId: String, idleLeaseMs: Int, maxMs: Int, reachable: Int)
    case floorDenied(reqId: String, reason: String)
    case floorEnded(transmissionId: String, reason: String)
    case attachOK(transmissionId: String, startSeq: Int, headDropped: Bool)
    case attachDenied(transmissionId: String)
    case transmissionEnded(transmissionId: String, reason: String, lastSeq: Int)
    case clockPong(clientSentMs: Double, serverTimeMs: Double)
    case error(reason: String)
    case unknown(type: String)

    public enum DecodeError: Error, Equatable { case notAnObject, missing(String) }

    public static func decode(_ text: String) throws -> ServerMessage {
        guard let obj = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let type = obj["type"] as? String else { throw DecodeError.notAnObject }
        func str(_ k: String) throws -> String {
            guard let v = obj[k] as? String else { throw DecodeError.missing(k) }
            return v
        }
        func num(_ k: String) throws -> Double {
            guard let v = obj[k] as? NSNumber else { throw DecodeError.missing(k) }
            return v.doubleValue
        }
        switch type {
        case "hello.ok": return .helloOK(participantRef: try str("participantRef"), serverTimeMs: try num("serverTimeMs"))
        case "hello.denied": return .helloDenied(reason: try str("reason"))
        case "listening.ok": return .listeningOK
        case "floor.granted":
            return .floorGranted(reqId: try str("reqId"), transmissionId: try str("transmissionId"),
                                 idleLeaseMs: Int(try num("idleLeaseMs")), maxMs: Int(try num("maxMs")),
                                 reachable: Int(try num("reachable")))
        case "floor.denied": return .floorDenied(reqId: try str("reqId"), reason: try str("reason"))
        case "floor.ended": return .floorEnded(transmissionId: try str("transmissionId"), reason: try str("reason"))
        case "attach.ok":
            guard let hd = obj["headDropped"] as? Bool else { throw DecodeError.missing("headDropped") }
            return .attachOK(transmissionId: try str("transmissionId"), startSeq: Int(try num("startSeq")), headDropped: hd)
        case "attach.denied": return .attachDenied(transmissionId: try str("transmissionId"))
        case "transmission.ended":
            return .transmissionEnded(transmissionId: try str("transmissionId"), reason: try str("reason"), lastSeq: Int(try num("lastSeq")))
        case "clock.pong": return .clockPong(clientSentMs: try num("clientSentMs"), serverTimeMs: try num("serverTimeMs"))
        case "error": return .error(reason: try str("reason"))
        default: return .unknown(type: type)
        }
    }
}

public enum FrameCodec {
    public static let headerBytes = 4

    public static func encode(seq: UInt32, payload: Data) -> Data {
        var out = Data(capacity: headerBytes + payload.count)
        out.append(UInt8((seq >> 24) & 0xff))
        out.append(UInt8((seq >> 16) & 0xff))
        out.append(UInt8((seq >> 8) & 0xff))
        out.append(UInt8(seq & 0xff))
        out.append(payload)
        return out
    }

    public static func decode(_ wire: Data) -> (seq: UInt32, payload: Data)? {
        guard wire.count >= headerBytes else { return nil }
        let b = [UInt8](wire.prefix(headerBytes))
        let seq = (UInt32(b[0]) << 24) | (UInt32(b[1]) << 16) | (UInt32(b[2]) << 8) | UInt32(b[3])
        return (seq, wire.dropFirst(headerBytes))
    }
}
