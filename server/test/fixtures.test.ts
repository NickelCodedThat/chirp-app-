import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROTOCOL_VERSION, decodeFrame, encodeFrame } from "../src/protocol.ts";
import { FakeConn, login, makeHub } from "./helpers.ts";

const fixtures = JSON.parse(
  readFileSync(new URL("../../protocol-fixtures/messages.json", import.meta.url), "utf8"),
) as {
  client: Record<string, unknown>[];
  server: { type: string }[];
  frames: { seq: number; payloadHex: string; wireHex: string }[];
};

const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

test("every client fixture is understood by the server", () => {
  for (const msg of fixtures.client) {
    const { hub } = makeHub();
    const c = login(hub, "alpha");
    c.json.length = 0;
    hub.onText(c, JSON.stringify(msg));
    if (msg["type"] === "hello") continue; // re-auth on an authed connection is a no-op reply
    const unknown = c.json.find((m) => m.type === "error" && m.reason === "unknown-type");
    assert.equal(unknown, undefined, `server does not recognize client message ${String(msg["type"])}`);
  }
});

test("the protocol version in the fixtures matches the server", () => {
  const hello = fixtures.client.find((m) => m["type"] === "hello");
  assert.equal(hello?.["protocol"], PROTOCOL_VERSION);
});

test("server fixtures are the shapes the server actually emits", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  hub.onText(bravo, JSON.stringify({ type: "listening.register" }));
  const id = "22222222-2222-4222-8222-222222222222";
  hub.onText(alpha, JSON.stringify({ type: "floor.request", reqId: "r", conversationId: "lab-1", transmissionId: id }));
  hub.onText(bravo, JSON.stringify({ type: "attach", transmissionId: id }));
  hub.onText(alpha, JSON.stringify({ type: "floor.release", transmissionId: id }));
  hub.onText(bravo, JSON.stringify({ type: "clock.ping", clientSentMs: 1 }));
  const emitted = new Map<string, Record<string, unknown>>();
  for (const c of [alpha, bravo] as FakeConn[]) for (const m of c.json) emitted.set(m.type, m as Record<string, unknown>);
  for (const fx of fixtures.server) {
    const real = emitted.get(fx.type);
    if (!real) continue; // shapes that need a failure scenario are covered by other tests
    assert.deepEqual(Object.keys(real).sort(), Object.keys(fx).sort(), `field set differs for ${fx.type}`);
  }
  assert.ok(emitted.size >= 5, "scenario should have exercised several message types");
});

test("frame encoding matches the golden bytes in both directions", () => {
  for (const f of fixtures.frames) {
    const payload = Buffer.from(f.payloadHex, "hex");
    assert.equal(hex(encodeFrame(f.seq, payload)), f.wireHex);
    const d = decodeFrame(Buffer.from(f.wireHex, "hex"));
    assert.equal(d?.seq, f.seq);
    assert.equal(hex(d!.payload), f.payloadHex);
  }
});
