import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ApnsPttSender } from "../src/apns.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { FakeConn, frame, listen, login, makeHub, requestFloor, send, sendFrames } from "./helpers.ts";

test("a bad token is refused and the connection closed", () => {
  const { hub } = makeHub();
  const c = new FakeConn();
  hub.onOpen(c);
  send(hub, c, { type: "hello", token: "nope", deviceId: "d", protocol: PROTOCOL_VERSION });
  assert.deepEqual(c.last("hello.denied"), { type: "hello.denied", reason: "bad-token" });
  assert.equal(c.closed, true);
  assert.equal(hub.isAuthed(c), false);
});

test("a wrong protocol version is refused", () => {
  const { hub } = makeHub();
  const c = new FakeConn();
  hub.onOpen(c);
  send(hub, c, { type: "hello", token: "EXAMPLE-ONLY-alpha-token", deviceId: "d", protocol: 99 });
  assert.equal(c.last("hello.denied")?.reason, "bad-protocol");
});

test("anything before hello is refused and closes the connection", () => {
  const { hub } = makeHub();
  const c = new FakeConn();
  hub.onOpen(c);
  send(hub, c, { type: "floor.request", reqId: "r", conversationId: "lab-1", transmissionId: randomUUID() });
  assert.equal(c.closed, true);
  assert.equal(c.last("floor.granted"), undefined);
});

test("audio from an unauthenticated connection is ignored", () => {
  const { hub } = makeHub();
  const c = new FakeConn();
  hub.onOpen(c);
  hub.onBinary(c, frame(0));
  assert.equal(hub.relay.sessionCount, 0);
});

test("authorized flow: first attach replays the head so the first word survives", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  const id = requestFloor(hub, alpha);
  assert.equal(alpha.last("floor.granted")?.reachable, 1);

  // The sender speaks before the recipient has woken up.
  sendFrames(hub, alpha, 0, 10);
  send(hub, bravo, { type: "attach", transmissionId: id });
  const ok = bravo.last("attach.ok");
  assert.deepEqual(ok, { type: "attach.ok", transmissionId: id, startSeq: 0, headDropped: false });
  assert.deepEqual(bravo.seqs(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  // Live frames follow.
  sendFrames(hub, alpha, 10, 3);
  assert.deepEqual(bravo.seqs().slice(-3), [10, 11, 12]);

  send(hub, alpha, { type: "floor.release", transmissionId: id });
  assert.equal(bravo.last("transmission.ended")?.reason, "released");
  assert.equal(alpha.last("floor.ended")?.reason, "released");
});

test("a non-member never receives audio, even if listening and attaching", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  const charlie = login(hub, "charlie");
  listen(hub, bravo);
  listen(hub, charlie);
  const id = requestFloor(hub, alpha, "lab-1");
  sendFrames(hub, alpha, 0, 5);
  send(hub, charlie, { type: "attach", transmissionId: id });
  assert.equal(charlie.last("attach.denied")?.transmissionId, id);
  sendFrames(hub, alpha, 5, 5);
  assert.equal(charlie.frames.length, 0);
  assert.equal(charlie.last("attach.ok"), undefined);
});

test("a member who has not registered to listen cannot attach", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo"); // authenticated but not listening
  const id = requestFloor(hub, alpha);
  sendFrames(hub, alpha, 0, 3);
  send(hub, bravo, { type: "attach", transmissionId: id });
  assert.equal(bravo.last("attach.denied")?.transmissionId, id);
  assert.equal(bravo.frames.length, 0);
});

test("the sender cannot attach to their own transmission", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  listen(hub, alpha);
  const id = requestFloor(hub, alpha);
  send(hub, alpha, { type: "attach", transmissionId: id });
  assert.equal(alpha.last("attach.denied")?.transmissionId, id);
});

test("attach to an unknown or malformed transmission gets the same denial", () => {
  const { hub } = makeHub();
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  send(hub, bravo, { type: "attach", transmissionId: randomUUID() });
  send(hub, bravo, { type: "attach", transmissionId: "not-a-uuid" });
  assert.deepEqual(bravo.types().filter((t) => t.startsWith("attach")), ["attach.denied", "attach.denied"]);
});

test("a second speaker is told the conversation is busy and their audio goes nowhere", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  const a = login(hub, "alpha", "alpha-second-device");
  listen(hub, bravo);
  const id = requestFloor(hub, alpha);
  const second = requestFloor(hub, bravo);
  assert.equal(bravo.last("floor.denied")?.reason, "busy");
  // The denied party streams anyway. Nothing is relayed.
  sendFrames(hub, bravo, 0, 5);
  send(hub, a, { type: "attach", transmissionId: second });
  assert.equal(alpha.frames.length, 0);
  assert.equal(hub.floor.holderOf("lab-1"), "alpha");
  assert.ok(id);
});

test("only the connection that holds the floor can send audio", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  const alphaOther = login(hub, "alpha", "other-device");
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  const id = requestFloor(hub, alpha);
  send(hub, bravo, { type: "attach", transmissionId: id });
  sendFrames(hub, alphaOther, 0, 5); // same account, different connection
  assert.equal(bravo.frames.length, 0);
  sendFrames(hub, alpha, 0, 2);
  assert.equal(bravo.frames.length, 2);
});

test("the startup buffer is bounded to five seconds and reports a dropped head", () => {
  const { hub, clock } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  const id = requestFloor(hub, alpha);
  // 400 frames x 20 ms = 8 s of speech at a realistic cadence.
  for (let i = 0; i < 400; i++) {
    hub.onBinary(alpha, frame(i));
    clock.advance(20, hub);
  }
  assert.equal(hub.relay.bufferedFrames(id), 250);
  assert.ok(hub.relay.bufferedBytes() <= 250 * 44);
  send(hub, bravo, { type: "attach", transmissionId: id });
  const ok = bravo.last("attach.ok");
  assert.equal(ok?.startSeq, 150);
  assert.equal(ok?.headDropped, true);
  assert.equal(bravo.frames.length, 250);
});

test("nothing is buffered when no authorized recipient is listening", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  login(hub, "bravo"); // not listening
  const id = requestFloor(hub, alpha);
  sendFrames(hub, alpha, 0, 50);
  assert.equal(hub.relay.bufferedFrames(id), 0);
  assert.equal(hub.relay.bufferedBytes(), 0);
  assert.equal(alpha.last("floor.granted")?.reachable, 0);
});

test("the buffer is dropped as soon as every recipient has attached", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  const id = requestFloor(hub, alpha);
  sendFrames(hub, alpha, 0, 20);
  assert.ok(hub.relay.bufferedBytes() > 0);
  send(hub, bravo, { type: "attach", transmissionId: id });
  assert.equal(hub.relay.bufferedBytes(), 0);
  sendFrames(hub, alpha, 20, 5);
  assert.equal(hub.relay.bufferedBytes(), 0);
});

test("a re-attach never replays: it joins at the live edge", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  const id = requestFloor(hub, alpha);
  sendFrames(hub, alpha, 0, 10);
  send(hub, bravo, { type: "attach", transmissionId: id });
  assert.equal(bravo.frames.length, 10);
  // Connection blip: the recipient reconnects and attaches again.
  hub.onClose(bravo);
  const bravo2 = login(hub, "bravo", "bravo-device");
  send(hub, bravo2, { type: "attach", transmissionId: id });
  const ok = bravo2.last("attach.ok");
  assert.equal(ok?.startSeq, 10);
  assert.equal(ok?.headDropped, true);
  assert.equal(bravo2.frames.length, 0);
  sendFrames(hub, alpha, 10, 2);
  assert.deepEqual(bravo2.seqs(), [10, 11]);
});

test("buffer memory is released after the transmission plus a short expiry", () => {
  const { hub, clock } = makeHub({ bufferPostEndExpiryMs: 10_000 });
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  const id = requestFloor(hub, alpha);
  sendFrames(hub, alpha, 0, 100);
  send(hub, alpha, { type: "floor.release", transmissionId: id });
  // A late waker can still attach within the expiry...
  clock.advance(5_000, hub);
  assert.ok(hub.relay.bufferedBytes() > 0);
  // ...and nothing remains afterwards.
  clock.advance(5_001, hub);
  assert.equal(hub.relay.bufferedBytes(), 0);
  assert.equal(hub.relay.sessionCount, 0);
  send(hub, bravo, { type: "attach", transmissionId: id });
  assert.equal(bravo.last("attach.denied")?.transmissionId, id);
  assert.equal(bravo.frames.length, 0);
});

test("a late waker that attaches after the end still receives the audio and the end marker", () => {
  const { hub, clock } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  const id = requestFloor(hub, alpha);
  sendFrames(hub, alpha, 0, 30);
  send(hub, alpha, { type: "floor.release", transmissionId: id });
  clock.advance(3_000, hub);
  send(hub, bravo, { type: "attach", transmissionId: id });
  assert.equal(bravo.last("attach.ok")?.headDropped, false);
  assert.equal(bravo.frames.length, 30);
  assert.equal(bravo.last("transmission.ended")?.lastSeq, 29);
});

test("duplicate and reordered frames are dropped, never relayed twice", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  const id = requestFloor(hub, alpha);
  send(hub, bravo, { type: "attach", transmissionId: id });
  for (const s of [0, 1, 1, 0, 2, 5, 4, 6]) hub.onBinary(alpha, frame(s));
  assert.deepEqual(bravo.seqs(), [0, 1, 2, 5, 6]);
});

test("oversize frames and floods are rejected", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  const id = requestFloor(hub, alpha);
  send(hub, bravo, { type: "attach", transmissionId: id });
  hub.onBinary(alpha, frame(0, 5_000));
  assert.equal(bravo.frames.length, 0);
  // 150 frames within one second: only the first 100 pass.
  for (let i = 1; i <= 150; i++) hub.onBinary(alpha, frame(i));
  assert.equal(bravo.frames.length, 100);
});

test("a dropped sender loses the floor at once, recipients are told, and nothing resumes", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  const id = requestFloor(hub, alpha);
  send(hub, bravo, { type: "attach", transmissionId: id });
  sendFrames(hub, alpha, 0, 3);
  hub.onClose(alpha);
  assert.equal(bravo.last("transmission.ended")?.reason, "sender-disconnected");
  assert.equal(hub.floor.holderOf("lab-1"), undefined);
  // The same device reconnects. The old ID cannot be resumed, even with a new connection.
  const alpha2 = login(hub, "alpha");
  send(hub, alpha2, { type: "floor.request", reqId: "r", conversationId: "lab-1", transmissionId: id });
  assert.equal(alpha2.last("floor.denied")?.reason, "duplicate-transmission-id");
  sendFrames(hub, alpha2, 3, 3);
  assert.equal(bravo.frames.length, 3);
  // A fresh, explicit request is the only way back.
  requestFloor(hub, alpha2);
  assert.ok(alpha2.last("floor.granted"));
});

test("an idle sender is cut off and the conversation never stays busy", () => {
  const { hub, clock } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  const id = requestFloor(hub, alpha);
  send(hub, bravo, { type: "attach", transmissionId: id });
  sendFrames(hub, alpha, 0, 2);
  clock.advance(2_100, hub);
  assert.equal(alpha.last("floor.ended")?.reason, "idle-lease-expired");
  assert.equal(bravo.last("transmission.ended")?.reason, "idle-lease-expired");
  // Late frames from the stale sender are ignored.
  sendFrames(hub, alpha, 2, 2);
  assert.equal(bravo.frames.length, 2);
  // Someone else can now speak.
  requestFloor(hub, bravo);
  assert.ok(bravo.last("floor.granted"));
});

test("the 30 second maximum cuts a continuous speaker", () => {
  const { hub, clock } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  const id = requestFloor(hub, alpha);
  send(hub, bravo, { type: "attach", transmissionId: id });
  let seq = 0;
  for (let s = 0; s < 31; s++) {
    hub.onBinary(alpha, frame(seq++));
    clock.advance(1_000, hub);
  }
  assert.equal(alpha.last("floor.ended")?.reason, "max-duration");
  assert.equal(bravo.last("transmission.ended")?.reason, "max-duration");
});

test("a block applied mid-transmission cuts the blocked recipient immediately", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  const id = requestFloor(hub, alpha);
  send(hub, bravo, { type: "attach", transmissionId: id });
  sendFrames(hub, alpha, 0, 3);
  hub.applyBlock("bravo", "alpha");
  assert.equal(bravo.last("transmission.ended")?.reason, "revoked");
  sendFrames(hub, alpha, 3, 3);
  assert.equal(bravo.frames.length, 3);
});

test("a recipient who blocked the sender is never offered the transmission", () => {
  const { hub } = makeHub({ blocks: [["bravo", "alpha"]] });
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  const id = requestFloor(hub, alpha);
  assert.equal(alpha.last("floor.granted")?.reachable, 0);
  send(hub, bravo, { type: "attach", transmissionId: id });
  assert.equal(bravo.last("attach.denied")?.transmissionId, id);
  sendFrames(hub, alpha, 0, 5);
  assert.equal(bravo.frames.length, 0);
});

test("a malformed floor request is denied without touching state", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  send(hub, alpha, { type: "floor.request", reqId: "r", conversationId: "lab-1", transmissionId: "short" });
  assert.equal(alpha.last("floor.denied")?.reason, "bad-request");
  assert.equal(hub.floor.activeCount, 0);
});

test("a connection carries one transmission at a time", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  requestFloor(hub, alpha, "lab-1");
  requestFloor(hub, alpha, "lab-2");
  assert.equal(alpha.last("floor.denied")?.reason, "already-transmitting");
  assert.equal(hub.floor.activeCount, 1);
});

test("unregistering stops delivery to that account", () => {
  const { hub } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  send(hub, bravo, { type: "listening.unregister" });
  const id = requestFloor(hub, alpha);
  assert.equal(alpha.last("floor.granted")?.reachable, 0);
  send(hub, bravo, { type: "attach", transmissionId: id });
  assert.equal(bravo.last("attach.denied")?.transmissionId, id);
});

test("a push is submitted once per authorized listener with a token, carrying no identity", async () => {
  const push = new ApnsPttSender({ mode: "dry-run", bundleId: "com.example.chirplab" });
  const { hub, log } = makeHub({ push });
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  listen(hub, bravo, "ab12cd34");
  const id = requestFloor(hub, alpha);
  await new Promise((r) => setImmediate(r));
  assert.equal(push.requests.length, 1);
  const req = push.requests[0]!;
  assert.equal(req.path, "/3/device/ab12cd34");
  assert.equal(req.headers["apns-push-type"], "pushtotalk");
  assert.equal(req.headers["apns-topic"], "com.example.chirplab.voip-ptt");
  assert.equal(req.headers["apns-priority"], "10");
  assert.equal(req.headers["apns-expiration"], "0");
  const body = JSON.parse(req.body) as Record<string, string>;
  assert.equal(body["transmissionId"], id);
  assert.ok(!req.body.includes("alpha") && !req.body.includes("bravo"), "payload must not carry account names");
  assert.equal(log.named("apns.submitted").length, 1);
});

test("no push is sent to blocked, non-listening or token-less recipients", async () => {
  const push = new ApnsPttSender({ mode: "dry-run", bundleId: "com.example.chirplab" });
  const { hub } = makeHub({ push, blocks: [["bravo", "alpha"]] });
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  const charlie = login(hub, "charlie");
  listen(hub, bravo, "aa11"); // blocked the sender
  listen(hub, charlie); // not a lab-1 member, and no token
  requestFloor(hub, alpha, "lab-1");
  await new Promise((r) => setImmediate(r));
  assert.equal(push.requests.length, 0);
});

test("event log records no audio and rejects non-primitive fields", () => {
  const { hub, log } = makeHub();
  const alpha = login(hub, "alpha");
  const bravo = login(hub, "bravo");
  listen(hub, bravo);
  const id = requestFloor(hub, alpha);
  send(hub, bravo, { type: "attach", transmissionId: id });
  sendFrames(hub, alpha, 0, 20);
  for (const e of log.events) {
    for (const v of Object.values(e)) assert.ok(typeof v !== "object" || v === null, "log values are primitives");
  }
  assert.throws(() => log.record("x", { audio: new Uint8Array(4) as unknown as string }), TypeError);
});
