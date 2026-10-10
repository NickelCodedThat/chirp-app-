import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { Hub } from "../src/hub.ts";
import { EventLog } from "../src/instrumentation.ts";
import { PROTOCOL_VERSION, decodeFrame, encodeFrame, type ServerMessage } from "../src/protocol.ts";
import { startLabServer } from "../src/server.ts";
import { TOKENS, makeIdentity } from "./helpers.ts";

class Client {
  readonly ws: WebSocket;
  readonly json: ServerMessage[] = [];
  readonly frames: { seq: number; atMs: number }[] = [];
  closed = false;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (data, isBinary) => {
      const buf = data as Buffer;
      if (isBinary) {
        const f = decodeFrame(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        if (f) this.frames.push({ seq: f.seq, atMs: performance.now() });
      } else this.json.push(JSON.parse(buf.toString("utf8")) as ServerMessage);
    });
    this.ws.on("close", () => (this.closed = true));
    this.ws.on("error", () => {});
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }
  send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }
  sendFrame(seq: number): void {
    this.ws.send(encodeFrame(seq, new Uint8Array(40).fill(seq & 0xff)), { binary: true });
  }
  async waitFor<T extends ServerMessage["type"]>(type: T, timeoutMs = 2_000): Promise<Extract<ServerMessage, { type: T }>> {
    const start = Date.now();
    for (;;) {
      const m = this.json.find((x) => x.type === type);
      if (m) return m as Extract<ServerMessage, { type: T }>;
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${type}`);
      await new Promise((r) => setTimeout(r, 2));
    }
  }
  async hello(who: keyof typeof TOKENS): Promise<void> {
    await this.open();
    this.send({ type: "hello", token: TOKENS[who], deviceId: `${who}-d`, protocol: PROTOCOL_VERSION });
    await this.waitFor("hello.ok");
  }
  close(): void {
    this.ws.terminate();
  }
}

async function boot(opts: { authTimeoutMs?: number } = {}) {
  const log = new EventLog();
  const hub = new Hub({ identity: makeIdentity(), log });
  const server = await startLabServer({ hub, host: "127.0.0.1", port: 0, tickMs: 20, ...opts });
  return { hub, log, server, url: `ws://127.0.0.1:${server.port}` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("end to end over real sockets: authorized listener hears it, outsider does not", async () => {
  const { server, url } = await boot();
  const alpha = new Client(url);
  const bravo = new Client(url);
  const charlie = new Client(url);
  try {
    await Promise.all([alpha.hello("alpha"), bravo.hello("bravo"), charlie.hello("charlie")]);
    bravo.send({ type: "listening.register" });
    charlie.send({ type: "listening.register" });
    await bravo.waitFor("listening.ok");

    const id = randomUUID();
    alpha.send({ type: "floor.request", reqId: "r1", conversationId: "lab-1", transmissionId: id });
    const granted = await alpha.waitFor("floor.granted");
    assert.equal(granted.reachable, 1);

    // The sender talks before the recipient attaches (simulating a wake).
    for (let i = 0; i < 10; i++) {
      alpha.sendFrame(i);
      await sleep(20);
    }
    bravo.send({ type: "attach", transmissionId: id });
    charlie.send({ type: "attach", transmissionId: id });
    assert.equal((await bravo.waitFor("attach.ok")).headDropped, false);
    assert.equal((await charlie.waitFor("attach.denied")).transmissionId, id);

    for (let i = 10; i < 20; i++) {
      alpha.sendFrame(i);
      await sleep(20);
    }
    alpha.send({ type: "floor.release", transmissionId: id });
    await bravo.waitFor("transmission.ended");
    assert.deepEqual(bravo.frames.map((f) => f.seq), Array.from({ length: 20 }, (_, i) => i));
    assert.equal(charlie.frames.length, 0, "unauthorized listener must hear nothing");
  } finally {
    [alpha, bravo, charlie].forEach((c) => c.close());
    await server.close();
  }
});

test("a connection that never authenticates is dropped", async () => {
  const { server, url } = await boot({ authTimeoutMs: 100 });
  const c = new Client(url);
  try {
    await c.open();
    await sleep(300);
    assert.equal(c.closed, true);
  } finally {
    c.close();
    await server.close();
  }
});

test("an oversize control message is refused by the transport", async () => {
  const { server, url } = await boot();
  const c = new Client(url);
  try {
    await c.hello("alpha");
    c.ws.send(JSON.stringify({ type: "hello", token: "x".repeat(10_000), deviceId: "d", protocol: PROTOCOL_VERSION }));
    await sleep(150);
    assert.equal(c.closed, true);
  } finally {
    c.close();
    await server.close();
  }
});

test("a server restart mid-transmission leaves no stuck floor and no resumed audio", async () => {
  const first = await boot();
  const alpha = new Client(first.url);
  const bravo = new Client(first.url);
  try {
    await Promise.all([alpha.hello("alpha"), bravo.hello("bravo")]);
    bravo.send({ type: "listening.register" });
    await bravo.waitFor("listening.ok");
    const id = randomUUID();
    alpha.send({ type: "floor.request", reqId: "r1", conversationId: "lab-1", transmissionId: id });
    await alpha.waitFor("floor.granted");
    bravo.send({ type: "attach", transmissionId: id });
    await bravo.waitFor("attach.ok");
    alpha.sendFrame(0);
    await sleep(30);
  } finally {
    await first.server.close();
  }
  await sleep(50);
  assert.equal(alpha.closed, true);
  assert.equal(bravo.closed, true);
  alpha.close();
  bravo.close();

  // A fresh process: nothing is held, clients must reconnect and ask again.
  const second = await boot();
  const alpha2 = new Client(second.url);
  const bravo2 = new Client(second.url);
  try {
    await Promise.all([alpha2.hello("alpha"), bravo2.hello("bravo")]);
    bravo2.send({ type: "listening.register" });
    await bravo2.waitFor("listening.ok");
    alpha2.send({ type: "floor.request", reqId: "r2", conversationId: "lab-1", transmissionId: randomUUID() });
    assert.equal((await alpha2.waitFor("floor.granted")).reachable, 1);
    assert.equal(bravo2.frames.length, 0, "nothing is replayed after a restart");
  } finally {
    alpha2.close();
    bravo2.close();
    await second.server.close();
  }
});

test("sender socket loss mid-transmission frees the floor for the other party", async () => {
  const { server, url } = await boot();
  const alpha = new Client(url);
  const bravo = new Client(url);
  try {
    await Promise.all([alpha.hello("alpha"), bravo.hello("bravo")]);
    bravo.send({ type: "listening.register" });
    await bravo.waitFor("listening.ok");
    const id = randomUUID();
    alpha.send({ type: "floor.request", reqId: "r1", conversationId: "lab-1", transmissionId: id });
    await alpha.waitFor("floor.granted");
    bravo.send({ type: "attach", transmissionId: id });
    await bravo.waitFor("attach.ok");
    alpha.sendFrame(0);
    await sleep(30);
    alpha.close(); // abrupt loss, no release message
    const ended = await bravo.waitFor("transmission.ended");
    assert.equal(ended.reason, "sender-disconnected");
    bravo.send({ type: "floor.request", reqId: "r2", conversationId: "lab-1", transmissionId: randomUUID() });
    await bravo.waitFor("floor.granted");
  } finally {
    alpha.close();
    bravo.close();
    await server.close();
  }
});
