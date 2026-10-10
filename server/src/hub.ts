import { FloorController, type FloorEvent } from "./floor.ts";
import type { Identity } from "./identity.ts";
import type { EventLog } from "./instrumentation.ts";
import { ListeningRegistry } from "./listening.ts";
import { PROTOCOL_VERSION, isUuid, type ClientMessage, type ServerMessage } from "./protocol.ts";
import { Relay, type Sink } from "./relay.ts";
import type { ApnsPttSender } from "./apns.ts";

// Connects identity, floor control, the relay, listening registrations and push
// delivery. Transport-agnostic: the WebSocket server and the tests both drive
// it through the Connection interface.

export interface Connection {
  readonly id: string;
  send(msg: ServerMessage): void;
  sendBinary(wire: Uint8Array): void;
  close(): void;
}

class ConnSink implements Sink {
  participantId = "";
  readonly id: string;
  readonly conn: Connection;
  constructor(conn: Connection) {
    this.conn = conn;
    this.id = conn.id;
  }
  sendJson(msg: ServerMessage): void {
    this.conn.send(msg);
  }
  sendFrame(wire: Uint8Array): void {
    this.conn.sendBinary(wire);
  }
}

type ConnState = { sink: ConnSink; authed: boolean; deviceId: string; transmissionId?: string };

export type HubOptions = {
  identity: Identity;
  log: EventLog;
  now?: () => number;
  push?: ApnsPttSender;
  idleLeaseMs?: number;
  maxTransmissionMs?: number;
  bufferMaxMs?: number;
  bufferPostEndExpiryMs?: number;
};

export class Hub {
  readonly identity: Identity;
  readonly log: EventLog;
  readonly floor: FloorController;
  readonly relay: Relay;
  readonly listening: ListeningRegistry;
  readonly #now: () => number;
  readonly #push: ApnsPttSender | undefined;
  readonly #conns = new Map<Connection, ConnState>();
  readonly #holderConn = new Map<string, ConnState>(); // transmissionId -> sender connection
  readonly #reachable = new Map<string, number>();

  constructor(opts: HubOptions) {
    this.identity = opts.identity;
    this.log = opts.log;
    this.#now = opts.now ?? Date.now;
    this.#push = opts.push;
    this.listening = new ListeningRegistry(this.#now);
    this.floor = new FloorController({
      conversations: opts.identity.conversations,
      now: this.#now,
      idleLeaseMs: opts.idleLeaseMs,
      maxTransmissionMs: opts.maxTransmissionMs,
      onEvent: (e) => this.#onFloorEvent(e),
    });
    this.relay = new Relay({
      floor: this.floor,
      log: this.log,
      now: this.#now,
      isBlockedEitherWay: (a, b) => this.identity.isBlockedEitherWay(a, b),
      bufferMaxMs: opts.bufferMaxMs,
      bufferPostEndExpiryMs: opts.bufferPostEndExpiryMs,
    });
  }

  onOpen(conn: Connection): void {
    this.#conns.set(conn, { sink: new ConnSink(conn), authed: false, deviceId: "" });
  }

  onClose(conn: Connection): void {
    const st = this.#conns.get(conn);
    if (!st) return;
    this.relay.detach(st.sink);
    // A dropped sender loses the floor immediately and never resumes it.
    if (st.authed && st.transmissionId) this.floor.endAllFor(st.sink.participantId, "sender-disconnected");
    this.#conns.delete(conn);
  }

  isAuthed(conn: Connection): boolean {
    return this.#conns.get(conn)?.authed ?? false;
  }

  onText(conn: Connection, text: string): void {
    const st = this.#conns.get(conn);
    if (!st) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(text) as ClientMessage;
    } catch {
      conn.send({ type: "error", reason: "bad-json" });
      return;
    }
    if (typeof msg !== "object" || msg === null || typeof (msg as { type?: unknown }).type !== "string") {
      conn.send({ type: "error", reason: "bad-message" });
      return;
    }
    if (!st.authed && msg.type !== "hello") {
      conn.send({ type: "error", reason: "not-authenticated" });
      conn.close();
      return;
    }
    switch (msg.type) {
      case "hello":
        return this.#hello(conn, st, msg);
      case "listening.register":
        return this.#register(conn, st, msg);
      case "listening.unregister":
        this.listening.unregister(st.sink.participantId, st.deviceId);
        return;
      case "floor.request":
        return this.#floorRequest(conn, st, msg);
      case "floor.release":
        return this.#floorRelease(st, msg);
      case "attach":
        if (isUuid(msg.transmissionId)) this.relay.attach(st.sink, msg.transmissionId);
        else conn.send({ type: "attach.denied", transmissionId: String(msg.transmissionId) });
        return;
      case "clock.ping":
        conn.send({ type: "clock.pong", clientSentMs: Number(msg.clientSentMs), serverTimeMs: this.#now() });
        return;
      default:
        conn.send({ type: "error", reason: "unknown-type" });
    }
  }

  onBinary(conn: Connection, wire: Uint8Array): void {
    const st = this.#conns.get(conn);
    if (!st?.authed || !st.transmissionId) return;
    this.relay.acceptFrame(st.sink.participantId, wire);
  }

  // Housekeeping. Call a few times per second.
  tick(): void {
    this.floor.tick();
    this.relay.sweep();
  }

  applyBlock(blocker: string, blocked: string): void {
    this.identity.block(blocker, blocked);
    this.relay.enforceBlocks();
  }

  #hello(conn: Connection, st: ConnState, msg: Extract<ClientMessage, { type: "hello" }>): void {
    if (msg.protocol !== PROTOCOL_VERSION) {
      conn.send({ type: "hello.denied", reason: "bad-protocol" });
      conn.close();
      return;
    }
    const pid = typeof msg.token === "string" ? this.identity.authenticate(msg.token) : undefined;
    if (!pid) {
      this.log.record("conn.auth-failed", {});
      conn.send({ type: "hello.denied", reason: "bad-token" });
      conn.close();
      return;
    }
    st.authed = true;
    st.sink.participantId = pid;
    st.deviceId = typeof msg.deviceId === "string" ? msg.deviceId.slice(0, 64) : "";
    this.log.record("conn.authed", { who: this.identity.refFor(pid) });
    conn.send({ type: "hello.ok", participantRef: this.identity.refFor(pid), serverTimeMs: this.#now() });
  }

  #register(conn: Connection, st: ConnState, msg: Extract<ClientMessage, { type: "listening.register" }>): void {
    const token = msg.pttToken;
    if (token !== undefined && (typeof token !== "string" || !/^[0-9a-fA-F]{1,512}$/.test(token))) {
      conn.send({ type: "error", reason: "bad-push-token" });
      return;
    }
    this.listening.register(st.sink.participantId, st.deviceId, token);
    this.log.record("listening.registered", { who: this.identity.refFor(st.sink.participantId), hasToken: Boolean(token) });
    conn.send({ type: "listening.ok" });
  }

  #floorRequest(conn: Connection, st: ConnState, msg: Extract<ClientMessage, { type: "floor.request" }>): void {
    const reqId = typeof msg.reqId === "string" ? msg.reqId.slice(0, 64) : "";
    if (!isUuid(msg.transmissionId) || typeof msg.conversationId !== "string") {
      conn.send({ type: "floor.denied", reqId, reason: "bad-request" });
      return;
    }
    const pid = st.sink.participantId;
    const who = this.identity.refFor(pid);
    // A connection carries one transmission at a time.
    if (st.transmissionId && st.transmissionId !== msg.transmissionId) {
      this.log.record("floor.denied", { transmissionId: msg.transmissionId, who, reason: "already-transmitting" });
      conn.send({ type: "floor.denied", reqId, reason: "already-transmitting" });
      return;
    }
    this.log.record("floor.requested", { transmissionId: msg.transmissionId, who });
    const result = this.floor.request(msg.conversationId, pid, msg.transmissionId);
    if (!result.ok) {
      this.log.record("floor.denied", { transmissionId: msg.transmissionId, who, reason: result.reason });
      conn.send({ type: "floor.denied", reqId, reason: result.reason });
      return;
    }
    st.transmissionId = msg.transmissionId;
    this.#holderConn.set(msg.transmissionId, st);
    conn.send({
      type: "floor.granted",
      reqId,
      transmissionId: msg.transmissionId,
      idleLeaseMs: result.idleLeaseMs,
      maxMs: result.maxMs,
      reachable: this.#reachable.get(msg.transmissionId) ?? 0,
    });
  }

  #floorRelease(st: ConnState, msg: Extract<ClientMessage, { type: "floor.release" }>): void {
    if (st.transmissionId !== msg.transmissionId) return;
    this.floor.release(msg.transmissionId, st.sink.participantId, msg.reason === "sender-aborted" ? "sender-aborted" : "released");
  }

  #onFloorEvent(e: FloorEvent): void {
    if (e.type === "granted") {
      const recipients = this.#authorizedListeners(e.conversationId, e.holder);
      this.#reachable.set(e.transmissionId, recipients.length);
      this.relay.open(e.transmissionId, e.conversationId, e.holder, recipients);
      this.log.record("floor.granted", { transmissionId: e.transmissionId, who: this.identity.refFor(e.holder), recipients: recipients.length });
      this.#dispatchPush(e.transmissionId, e.holder, recipients);
      return;
    }
    this.log.record("floor.ended", { transmissionId: e.transmissionId, reason: e.reason, who: this.identity.refFor(e.holder) });
    this.relay.onFloorEnded(e.transmissionId, e.reason);
    const holder = this.#holderConn.get(e.transmissionId);
    this.#holderConn.delete(e.transmissionId);
    this.#reachable.delete(e.transmissionId);
    if (holder) {
      holder.transmissionId = undefined;
      holder.sink.sendJson({ type: "floor.ended", transmissionId: e.transmissionId, reason: e.reason });
    }
  }

  // Conversation members, minus the sender, minus anyone blocked in either
  // direction, who have explicitly registered to listen.
  #authorizedListeners(conversationId: string, sender: string): string[] {
    const out: string[] = [];
    for (const m of this.floor.members(conversationId) ?? []) {
      if (m === sender) continue;
      if (this.identity.isBlockedEitherWay(sender, m)) continue;
      if (!this.listening.isListening(m)) continue;
      out.push(m);
    }
    return out;
  }

  #dispatchPush(transmissionId: string, sender: string, recipients: string[]): void {
    const push = this.#push;
    if (!push) return;
    for (const r of recipients) {
      const l = this.listening.get(r);
      if (!l?.pttToken || !l.tokenValid) continue;
      const token = l.pttToken;
      const who = this.identity.refFor(r);
      this.log.record("apns.submitted", { transmissionId, who });
      push
        .send(token, { transmissionId, senderRef: this.identity.refFor(sender) })
        .then((res) => {
          this.log.record("apns.response", {
            transmissionId,
            who,
            status: res.status,
            reason: res.reason,
            elapsedMs: Math.round(res.elapsedMs),
            dryRun: res.dryRun,
            tokenInvalid: res.tokenInvalid,
          });
          if (res.tokenInvalid) this.listening.invalidateToken(r, token);
        })
        .catch(() => this.log.record("apns.response", { transmissionId, who, status: -1, reason: "send-threw" }));
    }
  }
}
