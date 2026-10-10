// Loopback benchmark of the relay hop. NOT end-to-end latency: sender and receiver
// share one process (one clock), the network is loopback, and the codec is raw
// bytes. It isolates what the relay itself adds, and how long a startup-buffer
// replay takes to start. Synthetic data only.
//
//   node bench/relay-latency.ts [frames=1000] [replayTrials=20]

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { Hub } from "../src/hub.ts";
import { EventLog } from "../src/instrumentation.ts";
import { PROTOCOL_VERSION, decodeFrame, encodeFrame, type ServerMessage } from "../src/protocol.ts";
import { startLabServer } from "../src/server.ts";
import { TOKENS, makeIdentity } from "../test/helpers.ts";

const frames = Number(process.argv[2] ?? 1000);
const replayTrials = Number(process.argv[3] ?? 20);

type Client = { ws: WebSocket; msgs: ServerMessage[]; frames: { seq: number; t: number; sentAt: number }[] };

function connect(url: string, who: keyof typeof TOKENS): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c: Client = { ws: new WebSocket(url), msgs: [], frames: [] };
    c.ws.on("message", (d, bin) => {
      const now = performance.now();
      if (bin) {
        const buf = d as Buffer;
        const f = decodeFrame(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        if (f) c.frames.push({ seq: f.seq, t: now, sentAt: new DataView(f.payload.buffer, f.payload.byteOffset).getFloat64(0) });
      } else {
        const m = JSON.parse((d as Buffer).toString("utf8")) as ServerMessage;
        c.msgs.push(m);
        if (m.type === "hello.ok") resolve(c);
      }
    });
    c.ws.on("open", () => c.ws.send(JSON.stringify({ type: "hello", token: TOKENS[who], deviceId: who, protocol: PROTOCOL_VERSION })));
    c.ws.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await sleep(1);
  }
}
function pct(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}
function summarize(label: string, xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  console.log(
    `${label}: n=${s.length} p50=${pct(s, 50).toFixed(2)}ms p95=${pct(s, 95).toFixed(2)}ms p99=${pct(s, 99).toFixed(2)}ms max=${s.at(-1)!.toFixed(2)}ms`,
  );
}
function frameWith(seq: number): Uint8Array {
  const p = new Uint8Array(40);
  new DataView(p.buffer).setFloat64(0, performance.now());
  return encodeFrame(seq, p);
}

const hub = new Hub({ identity: makeIdentity(), log: new EventLog({ keepInMemory: false }) });
const server = await startLabServer({ hub, host: "127.0.0.1", port: 0, tickMs: 50 });
const url = `ws://127.0.0.1:${server.port}`;
const [a, b] = await Promise.all([connect(url, "alpha"), connect(url, "bravo")]);
b.ws.send(JSON.stringify({ type: "listening.register" }));
await until(() => b.msgs.some((m) => m.type === "listening.ok"));

// 1. Steady-state relay hop with 20 ms pacing, receiver already attached.
{
  const id = randomUUID();
  a.ws.send(JSON.stringify({ type: "floor.request", reqId: "r", conversationId: "lab-1", transmissionId: id }));
  await until(() => a.msgs.some((m) => m.type === "floor.granted"));
  b.ws.send(JSON.stringify({ type: "attach", transmissionId: id }));
  await until(() => b.msgs.some((m) => m.type === "attach.ok"));
  const start = performance.now();
  for (let i = 0; i < frames; i++) {
    a.ws.send(frameWith(i), { binary: true });
    const next = start + (i + 1) * 20;
    await sleep(Math.max(0, next - performance.now()));
  }
  await until(() => b.frames.length >= frames, 3_000).catch(() => {});
  a.ws.send(JSON.stringify({ type: "floor.release", transmissionId: id }));
  await sleep(100);
  summarize(`steady-state relay hop (paced 20 ms, ${frames} frames sent, ${b.frames.length} received)`, b.frames.map((f) => f.t - f.sentAt));
}

// 2. Startup-buffer replay: sender talks 5 s (250 frames) before the receiver attaches.
{
  const attachToFirst: number[] = [];
  const attachToAll: number[] = [];
  for (let t = 0; t < replayTrials; t++) {
    b.frames.length = 0;
    b.msgs.length = 0;
    a.msgs.length = 0;
    const id = randomUUID();
    a.ws.send(JSON.stringify({ type: "floor.request", reqId: "r", conversationId: "lab-1", transmissionId: id }));
    await until(() => a.msgs.some((m) => m.type === "floor.granted"));
    // Paced just under the relay's 100 frames/second flood limit (4x real time is not
    // possible without tripping it, which is the limiter working as intended).
    for (let i = 0; i < 250; i++) {
      a.ws.send(frameWith(i), { binary: true });
      await sleep(11);
    }
    await sleep(60);
    const sentAt = performance.now();
    b.ws.send(JSON.stringify({ type: "attach", transmissionId: id }));
    await until(() => b.frames.length >= 100);
    attachToFirst.push(b.frames[0]!.t - sentAt);
    await until(() => b.frames.length >= 250);
    attachToAll.push(b.frames.at(-1)!.t - sentAt);
    a.ws.send(JSON.stringify({ type: "floor.release", transmissionId: id }));
    await sleep(30);
  }
  summarize(`attach -> first replayed frame (250 buffered frames, ${replayTrials} trials)`, attachToFirst);
  summarize(`attach -> all 250 replayed frames`, attachToAll);
}

a.ws.terminate();
b.ws.terminate();
await server.close();
const mem = process.memoryUsage();
console.log(`relay process rss=${(mem.rss / 1048576).toFixed(0)}MB heapUsed=${(mem.heapUsed / 1048576).toFixed(0)}MB; buffered bytes after run=${hub.relay.bufferedBytes()}`);
