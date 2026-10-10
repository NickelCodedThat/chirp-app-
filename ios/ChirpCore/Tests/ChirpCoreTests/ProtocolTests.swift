import XCTest
@testable import ChirpCore

/// Keeps the Swift wire format in step with the server, using the shared
/// fixtures in protocol-fixtures/messages.json.
final class ProtocolTests: XCTestCase {

    private struct Fixtures {
        let client: [[String: Any]]
        let server: [[String: Any]]
        let frames: [[String: Any]]
    }

    private func loadFixtures() throws -> Fixtures {
        // Tests/ChirpCoreTests/ProtocolTests.swift -> repo root is five levels up.
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("protocol-fixtures/messages.json")
        let obj = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        return Fixtures(client: obj["client"] as! [[String: Any]],
                        server: obj["server"] as! [[String: Any]],
                        frames: obj["frames"] as! [[String: Any]])
    }

    private func normalized(_ json: String) throws -> NSDictionary {
        try JSONSerialization.jsonObject(with: Data(json.utf8)) as! NSDictionary
    }

    func testClientMessagesEncodeToTheFixtureShapes() throws {
        let f = try loadFixtures()
        let id = "22222222-2222-4222-8222-222222222222"
        let produced: [ClientMessage] = [
            .hello(token: "EXAMPLE-ONLY-alpha-token", deviceId: "alpha-device"),
            .listeningRegister(pttToken: "0a1b2c"),
            .listeningRegister(pttToken: nil),
            .listeningUnregister,
            .floorRequest(reqId: "11111111-1111-4111-8111-111111111111", conversationId: "lab-1", transmissionId: id),
            .floorRelease(transmissionId: id, aborted: false),
            .floorRelease(transmissionId: id, aborted: true),
            .attach(transmissionId: id),
            .clockPing(clientSentMs: 1234.5),
        ]
        XCTAssertEqual(produced.count, f.client.count, "fixture list and test list must stay in step")
        for (msg, fixture) in zip(produced, f.client) {
            XCTAssertEqual(try normalized(msg.encoded()), fixture as NSDictionary, "\(msg)")
        }
    }

    func testServerFixturesDecode() throws {
        let f = try loadFixtures()
        let id = "22222222-2222-4222-8222-222222222222"
        let req = "11111111-1111-4111-8111-111111111111"
        let expected: [ServerMessage] = [
            .helloOK(participantRef: "abcdef0123", serverTimeMs: 1_700_000_000_000),
            .helloDenied(reason: "bad-token"),
            .listeningOK,
            .floorGranted(reqId: req, transmissionId: id, idleLeaseMs: 2000, maxMs: 30000, reachable: 1),
            .floorDenied(reqId: req, reason: "busy"),
            .floorEnded(transmissionId: id, reason: "idle-lease-expired"),
            .attachOK(transmissionId: id, startSeq: 0, headDropped: false),
            .attachDenied(transmissionId: id),
            .transmissionEnded(transmissionId: id, reason: "released", lastSeq: 41),
            .clockPong(clientSentMs: 1234.5, serverTimeMs: 1_700_000_000_100),
            .error(reason: "bad-json"),
        ]
        XCTAssertEqual(expected.count, f.server.count)
        for (want, fixture) in zip(expected, f.server) {
            let text = String(decoding: try JSONSerialization.data(withJSONObject: fixture), as: UTF8.self)
            XCTAssertEqual(try ServerMessage.decode(text), want)
        }
    }

    func testUnknownServerMessageTypeIsToleratedNotFatal() throws {
        XCTAssertEqual(try ServerMessage.decode(#"{"type":"future.thing","x":1}"#), .unknown(type: "future.thing"))
    }

    func testMalformedServerMessagesThrow() {
        XCTAssertThrowsError(try ServerMessage.decode("[]"))
        XCTAssertThrowsError(try ServerMessage.decode(#"{"type":"floor.granted"}"#))
    }

    func testFramesMatchTheGoldenBytes() throws {
        for fx in try loadFixtures().frames {
            let seq = UInt32((fx["seq"] as! NSNumber).uint64Value)
            let payload = Data(hex: fx["payloadHex"] as! String)
            let wire = FrameCodec.encode(seq: seq, payload: payload)
            XCTAssertEqual(wire.hexString, fx["wireHex"] as! String)
            let back = FrameCodec.decode(wire)
            XCTAssertEqual(back?.seq, seq)
            XCTAssertEqual(back?.payload, payload)
        }
    }

    func testShortFramesAreRejected() {
        XCTAssertNil(FrameCodec.decode(Data([1, 2, 3])))
    }
}

private extension Data {
    init(hex: String) {
        self.init()
        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 2)
            append(UInt8(hex[i..<j], radix: 16)!)
            i = j
        }
    }
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
