import { randomUUID } from "node:crypto";
import { Hub, type Connection, type HubOptions } from "../src/hub.ts";
import { Identity } from "../src/identity.ts";
import { EventLog } from "../src/instrumentation.ts";
import { PROTOCOL_VERSION, decodeFrame, encodeFrame, type ClientMessage, type ServerMessage } from "../src/protocol.ts";

export class FakeConn implements Connection {
  readonly id = randomUUID();
  readonly json: ServerMessage[] = [];
  readonly frames: Uint8Array[] = [];
  closed = false;
  send(msg: ServerMessage): void {
    this.json.push(msg);
  }
  sendBinary(wire: Uint8Array): void {
    this.frames.push(wire);
  }
  close(): void {
    this.closed = true;
  }
  seqs(): number[] {
    return this.frames.map((f) => decodeFrame(f)!.seq);
  }
  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    for (let i = this.json.length - 1; i >= 0; i--) {
      const m = this.json[i]!;
      if (m.type === type) return m as Extract<ServerMessage, { type: T }>;
    }
    return undefined;
  }
  types(): string[] {
    return this.json.map((m) => m.type);
  }
}

export const TOKENS = {
  alpha: "EXAMPLE-ONLY-alpha-token",
  bravo: "EXAMPLE-ONLY-bravo-token",
  charlie: "EXAMPLE-ONLY-charlie-token",
} as const;

export function makeIdentity(extra: { blocks?: [string, string][] } = {}): Identity {
  return new Identity({
    participants: Object.entries(TOKENS).map(([id, token]) => ({ id, token })),
    conversations: [
      { id: "lab-1", members: ["alpha", "bravo"] },
      { id: "lab-2", members: ["alpha", "charlie"] },
    ],
    blocks: extra.blocks ?? [],
  });
}

export function makeHub(opts: Partial<HubOptions> & { blocks?: [string, string][] } = {}) {
  let t = 1_000_000;
  const clock = {
    now: () => t,
    advance(ms: number, hub?: Hub) {
      t += ms;
      hub?.tick();
    },
  };
  const log = new EventLog();
  const hub = new Hub({
    identity: makeIdentity({ blocks: opts.blocks }),
    log,
    now: clock.now,
    ...opts,
  });
  return { hub, clock, log };
}

export function send(hub: Hub, conn: FakeConn, msg: ClientMessage): void {
  hub.onText(conn, JSON.stringify(msg));
}

export function login(hub: Hub, who: keyof typeof TOKENS, deviceId = `${who}-device`): FakeConn {
  const c = new FakeConn();
  hub.onOpen(c);
  send(hub, c, { type: "hello", token: TOKENS[who], deviceId, protocol: PROTOCOL_VERSION });
  if (c.last("hello.ok") === undefined) throw new Error(`login failed for ${who}`);
  return c;
}

export function listen(hub: Hub, conn: FakeConn, pttToken?: string): void {
  send(hub, conn, { type: "listening.register", pttToken });
}

export function requestFloor(hub: Hub, conn: FakeConn, conversationId = "lab-1", transmissionId: string = randomUUID()): string {
  send(hub, conn, { type: "floor.request", reqId: randomUUID(), conversationId, transmissionId });
  return transmissionId;
}

export function frame(seq: number, size = 40): Uint8Array {
  return encodeFrame(seq, new Uint8Array(size).fill(seq & 0xff));
}

export function sendFrames(hub: Hub, conn: FakeConn, from: number, count: number): void {
  for (let i = 0; i < count; i++) hub.onBinary(conn, frame(from + i));
}
