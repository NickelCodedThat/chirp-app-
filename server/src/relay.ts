import type { FloorController } from "./floor.ts";
import type { EventLog } from "./instrumentation.ts";
import { DEFAULTS, FRAME_HEADER_BYTES, decodeFrame, type FloorEndReason, type ServerMessage } from "./protocol.ts";

// Media relay with a bounded, volatile startup buffer.
//
// Security properties enforced here:
//   - Audio is forwarded only to sinks that attached successfully, whose
//     participant is in the transmission's recipient set, and who are not
//     blocked either way with the sender. The set is re-checked per frame.
//   - Only the current floor holder's frames are accepted.
//   - Attach failures are indistinguishable from each other (no oracle for
//     "exists but you are not allowed").
//
// Buffer properties (Phase 00B experiment, not a product feature):
//   - RAM only. Nothing is written to disk and nothing is logged.
//   - At most bufferMaxMs of audio per transmission (sliding window).
//   - Used only to serve a recipient's FIRST attach. A re-attach never
//     replays: it joins at the live edge. There is no replay history.
//   - Dropped once every authorized recipient has attached, otherwise at
//     transmission end plus a short expiry.

export interface Sink {
  readonly id: string;
  readonly participantId: string;
  sendJson(msg: ServerMessage): void;
  sendFrame(wire: Uint8Array): void;
}

export type FrameResult = "ok" | "no-transmission" | "malformed" | "too-large" | "rate-limited" | "duplicate" | "lease-lost";

type BufferedFrame = { seq: number; wire: Uint8Array };

type Session = {
  id: string;
  conversationId: string;
  sender: string;
  recipients: Set<string>;
  startedAtMs: number;
  frames: BufferedFrame[];
  bufferedBytes: number;
  headDropped: boolean;
  nextSeq: number;
  lastSeq: number;
  attached: Map<string, Sink>;
  everAttached: Set<string>;
  firstFrameSent: Set<string>;
  endedAtMs?: number;
  endReason?: FloorEndReason;
  purgeAtMs?: number;
  rateWindowStartMs: number;
  rateCount: number;
  stats: { accepted: number; duplicates: number; oversize: number; rateLimited: number };
};

export type RelayOptions = {
  floor: FloorController;
  log: EventLog;
  now: () => number;
  isBlockedEitherWay: (a: string, b: string) => boolean;
  bufferMaxMs?: number;
  bufferPostEndExpiryMs?: number;
  frameMs?: number;
  maxFrameBytes?: number;
  maxFramesPerSecond?: number;
};

export class Relay {
  readonly #floor: FloorController;
  readonly #log: EventLog;
  readonly #now: () => number;
  readonly #blocked: (a: string, b: string) => boolean;
  readonly #maxBufferFrames: number;
  readonly #postEndExpiryMs: number;
  readonly #maxFrameBytes: number;
  readonly #maxFps: number;
  readonly #sessions = new Map<string, Session>();
  readonly #bySender = new Map<string, Session>();
  readonly #sinkTransmission = new Map<Sink, string>();

  constructor(opts: RelayOptions) {
    this.#floor = opts.floor;
    this.#log = opts.log;
    this.#now = opts.now;
    this.#blocked = opts.isBlockedEitherWay;
    this.#maxBufferFrames = Math.ceil((opts.bufferMaxMs ?? DEFAULTS.bufferMaxMs) / (opts.frameMs ?? DEFAULTS.frameMs));
    this.#postEndExpiryMs = opts.bufferPostEndExpiryMs ?? DEFAULTS.bufferPostEndExpiryMs;
    this.#maxFrameBytes = opts.maxFrameBytes ?? DEFAULTS.maxFrameBytes;
    this.#maxFps = opts.maxFramesPerSecond ?? DEFAULTS.maxFramesPerSecond;
  }

  // Called when the floor is granted. `recipients` must already be filtered by
  // the caller to explicit listeners who are authorized and not blocked.
  open(transmissionId: string, conversationId: string, sender: string, recipients: Iterable<string>): void {
    const now = this.#now();
    const s: Session = {
      id: transmissionId,
      conversationId,
      sender,
      recipients: new Set(recipients),
      startedAtMs: now,
      frames: [],
      bufferedBytes: 0,
      headDropped: false,
      nextSeq: 0,
      lastSeq: -1,
      attached: new Map(),
      everAttached: new Set(),
      firstFrameSent: new Set(),
      rateWindowStartMs: now,
      rateCount: 0,
      stats: { accepted: 0, duplicates: 0, oversize: 0, rateLimited: 0 },
    };
    s.recipients.delete(sender);
    this.#sessions.set(transmissionId, s);
    this.#bySender.set(sender, s);
    this.#log.record("relay.open", { transmissionId, recipients: s.recipients.size });
  }

  acceptFrame(sender: string, wire: Uint8Array): FrameResult {
    const s = this.#bySender.get(sender);
    if (!s || s.endedAtMs !== undefined) return "no-transmission";
    const decoded = decodeFrame(wire);
    if (!decoded) return "malformed";
    if (wire.byteLength > this.#maxFrameBytes + FRAME_HEADER_BYTES) {
      s.stats.oversize++;
      return "too-large";
    }
    const now = this.#now();
    if (now - s.rateWindowStartMs >= 1_000) {
      s.rateWindowStartMs = now;
      s.rateCount = 0;
    }
    if (++s.rateCount > this.#maxFps) {
      s.stats.rateLimited++;
      return "rate-limited";
    }
    // Sequence numbers must increase strictly: duplicates and reordered frames are dropped.
    if (decoded.seq <= s.lastSeq) {
      s.stats.duplicates++;
      return "duplicate";
    }
    // Renew the lease. If the lease already lapsed, the floor reports false and
    // the frame is not relayed.
    if (!this.#floor.touch(s.id, sender)) return "lease-lost";

    s.lastSeq = decoded.seq;
    s.nextSeq = decoded.seq + 1;
    s.stats.accepted++;
    if (s.stats.accepted === 1) this.#log.record("relay.first-frame-from-sender", { transmissionId: s.id });

    const frame: BufferedFrame = { seq: decoded.seq, wire };
    if (this.#needsBuffer(s)) {
      s.frames.push(frame);
      s.bufferedBytes += wire.byteLength;
      while (s.frames.length > this.#maxBufferFrames) {
        const dropped = s.frames.shift()!;
        s.bufferedBytes -= dropped.wire.byteLength;
        s.headDropped = true;
      }
    } else if (s.frames.length) {
      this.#clearBuffer(s);
    }

    for (const [participant, sink] of s.attached) {
      // Defense in depth: re-verify authorization on every frame.
      if (!s.recipients.has(participant) || this.#blocked(s.sender, participant)) continue;
      sink.sendFrame(wire);
      if (!s.firstFrameSent.has(participant)) {
        s.firstFrameSent.add(participant);
        this.#log.record("relay.first-frame-to-recipient", { transmissionId: s.id, seq: decoded.seq });
      }
    }
    return "ok";
  }

  // A recipient attaches (typically right after being woken). Returns true if
  // attached. Every refusal sends the same response.
  attach(sink: Sink, transmissionId: string): boolean {
    const s = this.#sessions.get(transmissionId);
    const now = this.#now();
    const allowed =
      s !== undefined &&
      s.recipients.has(sink.participantId) &&
      sink.participantId !== s.sender &&
      !this.#blocked(s.sender, sink.participantId) &&
      !(s.purgeAtMs !== undefined && now >= s.purgeAtMs);
    if (!allowed) {
      sink.sendJson({ type: "attach.denied", transmissionId });
      this.#log.record("relay.attach-denied", { transmissionId });
      return false;
    }

    this.detach(sink);
    const first = !s.everAttached.has(sink.participantId);
    s.attached.set(sink.participantId, sink);
    s.everAttached.add(sink.participantId);
    this.#sinkTransmission.set(sink, transmissionId);

    // Only a first attach is served from the startup buffer.
    const replay = first ? s.frames : [];
    const startSeq = first ? (s.frames[0]?.seq ?? s.nextSeq) : s.nextSeq;
    const headDropped = first ? s.headDropped : s.nextSeq > 0;
    sink.sendJson({ type: "attach.ok", transmissionId, startSeq, headDropped });
    for (const f of replay) sink.sendFrame(f.wire);
    this.#log.record("relay.attach", {
      transmissionId,
      first,
      startSeq,
      headDropped,
      replayFrames: replay.length,
      ageMs: now - s.startedAtMs,
      ended: s.endedAtMs !== undefined,
    });
    if (replay.length) {
      s.firstFrameSent.add(sink.participantId);
      this.#log.record("relay.first-frame-to-recipient", { transmissionId, seq: replay[0]!.seq });
    }

    if (s.endedAtMs !== undefined) {
      sink.sendJson({ type: "transmission.ended", transmissionId, reason: s.endReason ?? "released", lastSeq: s.lastSeq });
      s.attached.delete(sink.participantId);
      this.#sinkTransmission.delete(sink);
    }
    this.#maybeDropBuffer(s);
    return true;
  }

  detach(sink: Sink): void {
    const id = this.#sinkTransmission.get(sink);
    if (id === undefined) return;
    this.#sinkTransmission.delete(sink);
    this.#sessions.get(id)?.attached.delete(sink.participantId);
  }

  // The floor ended for any reason. Notify recipients and schedule the purge.
  onFloorEnded(transmissionId: string, reason: FloorEndReason): void {
    const s = this.#sessions.get(transmissionId);
    if (!s || s.endedAtMs !== undefined) return;
    const now = this.#now();
    s.endedAtMs = now;
    s.endReason = reason;
    s.purgeAtMs = now + this.#postEndExpiryMs;
    this.#bySender.delete(s.sender);
    for (const [, sink] of s.attached) {
      sink.sendJson({ type: "transmission.ended", transmissionId, reason, lastSeq: s.lastSeq });
      this.#sinkTransmission.delete(sink);
    }
    s.attached.clear();
    this.#log.record("relay.ended", {
      transmissionId,
      reason,
      durationMs: now - s.startedAtMs,
      accepted: s.stats.accepted,
      duplicates: s.stats.duplicates,
      oversize: s.stats.oversize,
      rateLimited: s.stats.rateLimited,
    });
    this.#maybeDropBuffer(s);
    if (this.#allAttached(s)) this.#purge(s);
  }

  // Remove one recipient from an active transmission, for example because a
  // block took effect mid-transmission.
  revokeRecipient(transmissionId: string, participantId: string): void {
    const s = this.#sessions.get(transmissionId);
    if (!s || !s.recipients.delete(participantId)) return;
    const sink = s.attached.get(participantId);
    if (sink) {
      sink.sendJson({ type: "transmission.ended", transmissionId, reason: "revoked", lastSeq: s.lastSeq });
      s.attached.delete(participantId);
      this.#sinkTransmission.delete(sink);
    }
    this.#log.record("relay.recipient-revoked", { transmissionId });
  }

  // Re-evaluate blocks for all live transmissions.
  enforceBlocks(): void {
    for (const s of this.#sessions.values()) {
      if (s.endedAtMs !== undefined) continue;
      for (const r of [...s.recipients]) {
        if (this.#blocked(s.sender, r)) this.revokeRecipient(s.id, r);
      }
    }
  }

  // Drop buffers whose lifetime has passed. Call periodically.
  sweep(): void {
    const now = this.#now();
    for (const s of [...this.#sessions.values()]) {
      if (s.purgeAtMs !== undefined && now >= s.purgeAtMs) this.#purge(s);
    }
  }

  bufferedBytes(): number {
    let n = 0;
    for (const s of this.#sessions.values()) n += s.bufferedBytes;
    return n;
  }

  bufferedFrames(transmissionId: string): number {
    return this.#sessions.get(transmissionId)?.frames.length ?? 0;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  #needsBuffer(s: Session): boolean {
    for (const r of s.recipients) if (!s.everAttached.has(r)) return true;
    return false;
  }

  #allAttached(s: Session): boolean {
    return !this.#needsBuffer(s);
  }

  #maybeDropBuffer(s: Session): void {
    if (s.frames.length && this.#allAttached(s)) this.#clearBuffer(s);
  }

  #clearBuffer(s: Session): void {
    s.frames = [];
    s.bufferedBytes = 0;
    s.headDropped = true;
  }

  #purge(s: Session): void {
    this.#clearBuffer(s);
    this.#sessions.delete(s.id);
    this.#bySender.delete(s.sender);
    for (const sink of s.attached.values()) this.#sinkTransmission.delete(sink);
    s.attached.clear();
    this.#log.record("relay.purged", { transmissionId: s.id });
  }
}
