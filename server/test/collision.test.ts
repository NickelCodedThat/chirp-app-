import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { Hub } from "../src/hub.ts";
import { EventLog } from "../src/instrumentation.ts";
import { PROTOCOL_VERSION, type ServerMessage } from "../src/protocol.ts";
import { startLabServer } from "../src/server.ts";
import { TOKENS, makeIdentity } from "./helpers.ts";

// Simultaneous presses over real sockets. Two members request the same
// conversation's floor back to back. Exactly one must win, every time, and the
// loser must be told "busy".
//
// What this shows: the one-speaker invariant holds over real sockets under
// repeated contention. What it does not show: true parallelism. The server
// handles messages on one event loop, which is what makes the guarantee simple;
// a multi-process deployment would need a shared arbiter and fresh tests.

function connect(url: string, who: keyof typeof TOKENS): Promise<{ ws: WebSocket; msgs: ServerMessage[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const msgs: ServerMessage[] = [];
    ws.on("message", (d, bin) => {
      if (!bin) {
        const m = JSON.parse((d as Buffer).toString("utf8")) as ServerMessage;
        msgs.push(m);
        if (m.type === "hello.ok") resolve({ ws, msgs });
      }
    });
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: TOKENS[who], deviceId: who, protocol: PROTOCOL_VERSION })));
    ws.on("error", reject);
  });
}

const tick = () => new Promise((r) => setTimeout(r, 4));
const active = (hub: Hub): number => hub.floor.activeCount;

test("300 simultaneous-press trials produce exactly one speaker each time", async () => {
  const hub = new Hub({ identity: makeIdentity(), log: new EventLog({ keepInMemory: false }) });
  const server = await startLabServer({ hub, host: "127.0.0.1", port: 0, tickMs: 20 });
  const url = `ws://127.0.0.1:${server.port}`;
  const [a, b] = await Promise.all([connect(url, "alpha"), connect(url, "bravo")]);
  const trials = 300;
  let aWins = 0;
  let bWins = 0;
  try {
    for (let i = 0; i < trials; i++) {
      a.msgs.length = 0;
      b.msgs.length = 0;
      const idA = randomUUID();
      const idB = randomUUID();
      // Fire both back to back with no await between them, in a random order. The
      // server is single-threaded, so "simultaneous" really means arrival order at
      // one event loop; randomizing the send order varies who arrives first.
      const sendA = () => a.ws.send(JSON.stringify({ type: "floor.request", reqId: "a", conversationId: "lab-1", transmissionId: idA }));
      const sendB = () => b.ws.send(JSON.stringify({ type: "floor.request", reqId: "b", conversationId: "lab-1", transmissionId: idB }));
      if (Math.random() < 0.5) { sendA(); sendB(); } else { sendB(); sendA(); }
      const deadline = Date.now() + 2_000;
      while ((a.msgs.length < 1 || b.msgs.length < 1) && Date.now() < deadline) await tick();

      const aGranted = a.msgs.some((m) => m.type === "floor.granted");
      const bGranted = b.msgs.some((m) => m.type === "floor.granted");
      assert.equal(Number(aGranted) + Number(bGranted), 1, `trial ${i}: exactly one grant (a=${aGranted}, b=${bGranted})`);
      const loser = aGranted ? b : a;
      assert.equal(loser.msgs.find((m) => m.type === "floor.denied")?.type, "floor.denied", `trial ${i}: loser is told`);
      assert.equal(
        (loser.msgs.find((m) => m.type === "floor.denied") as { reason: string }).reason,
        "busy",
        `trial ${i}: loser sees busy`,
      );
      assert.equal(active(hub), 1, `trial ${i}: one active transmission`);
      if (aGranted) aWins++; else bWins++;

      // Winner releases; the floor must be free again.
      const winner = aGranted ? a : b;
      winner.ws.send(JSON.stringify({ type: "floor.release", transmissionId: aGranted ? idA : idB }));
      const free = Date.now() + 2_000;
      while (active(hub) !== 0 && Date.now() < free) await tick();
      assert.equal(active(hub), 0, `trial ${i}: floor freed after release`);
    }
    // Both sides should win sometimes; otherwise the test is not really racing.
    assert.ok(aWins > 0 && bWins > 0, `both parties should win some trials (alpha ${aWins}, bravo ${bWins})`);
    console.log(`collision trials: ${trials}, alpha won ${aWins}, bravo won ${bWins}`);
  } finally {
    a.ws.terminate();
    b.ws.terminate();
    await server.close();
  }
});
