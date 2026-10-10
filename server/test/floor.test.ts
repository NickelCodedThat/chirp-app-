import { test } from "node:test";
import assert from "node:assert/strict";
import { FloorController, type FloorEvent } from "../src/floor.ts";

const CONV = "lab-1";
const OTHER_CONV = "lab-2";

function setup(opts: { idleLeaseMs?: number; maxTransmissionMs?: number; seenLimit?: number } = {}) {
  let t = 1_000;
  const events: FloorEvent[] = [];
  const floor = new FloorController({
    conversations: new Map([
      [CONV, new Set(["alpha", "bravo"])],
      [OTHER_CONV, new Set(["alpha", "charlie"])],
    ]),
    now: () => t,
    onEvent: (e) => events.push(e),
    ...opts,
  });
  return { floor, events, advance: (ms: number) => { t += ms; }, now: () => t };
}

test("grants the floor to a member and reports busy to the other", () => {
  const { floor } = setup();
  const a = floor.request(CONV, "alpha", "t-1");
  assert.equal(a.ok, true);
  const b = floor.request(CONV, "bravo", "t-2");
  assert.deepEqual(b, { ok: false, reason: "busy" });
  assert.equal(floor.holderOf(CONV), "alpha");
});

test("rejects non-members and unknown conversations", () => {
  const { floor } = setup();
  assert.deepEqual(floor.request(CONV, "charlie", "t-1"), { ok: false, reason: "not-member" });
  assert.deepEqual(floor.request("nope", "alpha", "t-2"), { ok: false, reason: "unknown-conversation" });
  assert.equal(floor.activeCount, 0);
});

test("rejects an empty transmission ID", () => {
  const { floor } = setup();
  assert.deepEqual(floor.request(CONV, "alpha", ""), { ok: false, reason: "bad-request" });
});

test("a retry of the same request by the same holder is idempotent", () => {
  const { floor, events } = setup();
  const first = floor.request(CONV, "alpha", "t-1");
  const again = floor.request(CONV, "alpha", "t-1");
  assert.equal(first.ok && again.ok && again.repeat, true);
  assert.equal(events.filter((e) => e.type === "granted").length, 1);
});

test("a transmission ID can never be granted again, even after it ended", () => {
  const { floor } = setup();
  floor.request(CONV, "alpha", "t-1");
  assert.equal(floor.release("t-1", "alpha"), true);
  assert.deepEqual(floor.request(CONV, "alpha", "t-1"), { ok: false, reason: "duplicate-transmission-id" });
  assert.deepEqual(floor.request(CONV, "bravo", "t-1"), { ok: false, reason: "duplicate-transmission-id" });
});

test("another participant cannot reuse an active transmission ID", () => {
  const { floor } = setup();
  floor.request(CONV, "alpha", "t-1");
  assert.deepEqual(floor.request(OTHER_CONV, "charlie", "t-1"), { ok: false, reason: "duplicate-transmission-id" });
});

test("a participant cannot hold two floors at once", () => {
  const { floor } = setup();
  floor.request(CONV, "alpha", "t-1");
  assert.deepEqual(floor.request(OTHER_CONV, "alpha", "t-2"), { ok: false, reason: "already-transmitting" });
});

test("release by a non-holder is refused and the floor stays held", () => {
  const { floor } = setup();
  floor.request(CONV, "alpha", "t-1");
  assert.equal(floor.release("t-1", "bravo"), false);
  assert.equal(floor.holderOf(CONV), "alpha");
});

test("release frees the floor and emits one ended event", () => {
  const { floor, events } = setup();
  floor.request(CONV, "alpha", "t-1");
  floor.release("t-1", "alpha");
  assert.equal(floor.holderOf(CONV), undefined);
  const ended = events.filter((e) => e.type === "ended");
  assert.equal(ended.length, 1);
  assert.equal(ended[0]?.type === "ended" && ended[0].reason, "released");
  // Releasing again is a no-op, not a second event.
  assert.equal(floor.release("t-1", "alpha"), false);
  assert.equal(events.filter((e) => e.type === "ended").length, 1);
});

test("idle lease expires when no frames arrive, and frames keep it alive", () => {
  const { floor, events, advance } = setup({ idleLeaseMs: 2_000 });
  floor.request(CONV, "alpha", "t-1");
  advance(1_500);
  assert.equal(floor.touch("t-1", "alpha"), true);
  advance(1_500);
  assert.equal(floor.holderOf(CONV), "alpha");
  advance(2_000);
  assert.equal(floor.holderOf(CONV), undefined);
  const last = events.at(-1);
  assert.equal(last?.type === "ended" && last.reason, "idle-lease-expired");
});

test("max duration ends a transmission even if frames keep arriving", () => {
  const { floor, events, advance } = setup({ idleLeaseMs: 2_000, maxTransmissionMs: 30_000 });
  floor.request(CONV, "alpha", "t-1");
  for (let i = 0; i < 29; i++) {
    advance(1_000);
    assert.equal(floor.touch("t-1", "alpha"), true);
  }
  advance(1_000);
  assert.equal(floor.touch("t-1", "alpha"), false);
  const last = events.at(-1);
  assert.equal(last?.type === "ended" && last.reason, "max-duration");
  assert.equal(floor.holderOf(CONV), undefined);
});

test("touch after the lease expired is rejected", () => {
  const { floor, advance } = setup({ idleLeaseMs: 2_000 });
  floor.request(CONV, "alpha", "t-1");
  advance(2_500);
  assert.equal(floor.touch("t-1", "alpha"), false);
});

test("touch by a non-holder is rejected and does not extend the lease", () => {
  const { floor, advance } = setup({ idleLeaseMs: 2_000 });
  floor.request(CONV, "alpha", "t-1");
  advance(1_500);
  assert.equal(floor.touch("t-1", "bravo"), false);
  advance(600);
  assert.equal(floor.holderOf(CONV), undefined);
});

test("disconnect ends the transmission immediately and never resumes it", () => {
  const { floor, events } = setup();
  floor.request(CONV, "alpha", "t-1");
  floor.endAllFor("alpha");
  assert.equal(floor.holderOf(CONV), undefined);
  const last = events.at(-1);
  assert.equal(last?.type === "ended" && last.reason, "sender-disconnected");
  // The same ID cannot be resumed after reconnecting.
  assert.deepEqual(floor.request(CONV, "alpha", "t-1"), { ok: false, reason: "duplicate-transmission-id" });
  // A fresh ID works.
  assert.equal(floor.request(CONV, "alpha", "t-2").ok, true);
});

test("a stale holder cannot block the conversation forever", () => {
  const { floor, advance } = setup({ idleLeaseMs: 2_000 });
  floor.request(CONV, "alpha", "t-1");
  advance(2_001);
  assert.equal(floor.request(CONV, "bravo", "t-2").ok, true);
  assert.equal(floor.holderOf(CONV), "bravo");
});

test("revoke cuts an active transmission", () => {
  const { floor, events } = setup();
  floor.request(CONV, "alpha", "t-1");
  assert.equal(floor.revoke("t-1"), true);
  const last = events.at(-1);
  assert.equal(last?.type === "ended" && last.reason, "revoked");
  assert.equal(floor.revoke("t-1"), false);
});

test("seen-ID memory is bounded", () => {
  const { floor } = setup({ seenLimit: 3 });
  for (let i = 0; i < 6; i++) {
    floor.request(CONV, "alpha", `t-${i}`);
    floor.release(`t-${i}`, "alpha");
  }
  // Old IDs fall out of memory; recent ones are still rejected.
  assert.deepEqual(floor.request(CONV, "alpha", "t-5"), { ok: false, reason: "duplicate-transmission-id" });
  assert.equal(floor.request(CONV, "alpha", "t-0").ok, true);
});

// Seeded randomized check of the core invariants under arbitrary interleavings.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("randomized operations never yield two speakers or an unbounded floor", () => {
  for (const seed of [1, 7, 42, 1337, 99991]) {
    const rnd = mulberry32(seed);
    const { floor, events, advance } = setup({ idleLeaseMs: 500, maxTransmissionMs: 5_000 });
    const people = ["alpha", "bravo", "charlie"];
    const convs = [CONV, OTHER_CONV];
    let n = 0;
    const issued: string[] = [];
    for (let step = 0; step < 4_000; step++) {
      const op = rnd();
      const who = people[Math.floor(rnd() * people.length)]!;
      if (op < 0.35) {
        const id = `s${seed}-${n++}`;
        issued.push(id);
        floor.request(convs[Math.floor(rnd() * convs.length)]!, who, id);
      } else if (op < 0.55 && issued.length) {
        floor.touch(issued[Math.floor(rnd() * issued.length)]!, who);
      } else if (op < 0.7 && issued.length) {
        floor.release(issued[Math.floor(rnd() * issued.length)]!, who);
      } else if (op < 0.75) {
        floor.endAllFor(who);
      } else {
        advance(Math.floor(rnd() * 400));
        floor.tick();
      }
      // Invariants, evaluated after every operation.
      const holders = new Set<string>();
      for (const c of convs) {
        const h = floor.holderOf(c);
        if (h) {
          assert.ok(floor.members(c)?.has(h), "holder must be a member");
          assert.ok(!holders.has(h), "a participant holds at most one floor");
          holders.add(h);
        }
      }
      assert.ok(floor.activeCount <= convs.length, "at most one active transmission per conversation");
    }
    // Everything ends given enough time with no activity.
    advance(10_000);
    floor.tick();
    assert.equal(floor.activeCount, 0, "no transmission can outlive its lease");
    // Every grant ended at most once and every ID was granted at most once.
    const granted = events.filter((e) => e.type === "granted").map((e) => e.transmissionId);
    assert.equal(new Set(granted).size, granted.length);
    const ended = events.filter((e) => e.type === "ended").map((e) => e.transmissionId);
    assert.equal(new Set(ended).size, ended.length);
    assert.equal(ended.length, granted.length);
  }
});
