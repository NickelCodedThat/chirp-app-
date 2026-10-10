import { DEFAULTS, type FloorDenyReason, type FloorEndReason } from "./protocol.ts";

// Server-authoritative floor control. Pure logic: no I/O, no timers. Time comes
// from an injected clock and expiry is driven by tick(), so behavior is
// deterministic under test.
//
// Invariants this class owns:
//   1. At most one active transmission per conversation.
//   2. A participant holds at most one floor at a time.
//   3. A transmission ID is never granted twice (replays are rejected).
//   4. Every active transmission eventually ends: release, disconnect,
//      idle-lease expiry or max duration. Nothing can stay busy forever.

export type FloorEvent =
  | { type: "granted"; conversationId: string; transmissionId: string; holder: string; startedAtMs: number }
  | { type: "ended"; conversationId: string; transmissionId: string; holder: string; reason: FloorEndReason; endedAtMs: number };

export type RequestResult =
  | { ok: true; transmissionId: string; repeat: boolean; idleLeaseMs: number; maxMs: number }
  | { ok: false; reason: FloorDenyReason };

type Active = {
  conversationId: string;
  transmissionId: string;
  holder: string;
  startedAtMs: number;
  lastActivityMs: number;
};

export type FloorOptions = {
  // conversationId -> member participant IDs. The only source of truth for who
  // may speak in a conversation.
  conversations: ReadonlyMap<string, ReadonlySet<string>>;
  now: () => number;
  onEvent: (e: FloorEvent) => void;
  idleLeaseMs?: number;
  maxTransmissionMs?: number;
  seenLimit?: number;
};

export class FloorController {
  readonly #conversations: ReadonlyMap<string, ReadonlySet<string>>;
  readonly #now: () => number;
  readonly #onEvent: (e: FloorEvent) => void;
  readonly #idleLeaseMs: number;
  readonly #maxMs: number;
  readonly #seenLimit: number;
  readonly #byConversation = new Map<string, Active>();
  readonly #byTransmission = new Map<string, Active>();
  readonly #byHolder = new Map<string, Active>();
  // Insertion-ordered so the oldest entries are evicted first.
  readonly #seen = new Set<string>();

  constructor(opts: FloorOptions) {
    this.#conversations = opts.conversations;
    this.#now = opts.now;
    this.#onEvent = opts.onEvent;
    this.#idleLeaseMs = opts.idleLeaseMs ?? DEFAULTS.idleLeaseMs;
    this.#maxMs = opts.maxTransmissionMs ?? DEFAULTS.maxTransmissionMs;
    this.#seenLimit = opts.seenLimit ?? DEFAULTS.seenTransmissionIdLimit;
  }

  request(conversationId: string, participantId: string, transmissionId: string): RequestResult {
    this.tick();
    if (!transmissionId) return { ok: false, reason: "bad-request" };
    const members = this.#conversations.get(conversationId);
    if (!members) return { ok: false, reason: "unknown-conversation" };
    if (!members.has(participantId)) return { ok: false, reason: "not-member" };

    const existing = this.#byTransmission.get(transmissionId);
    if (existing) {
      // Idempotent retry of the same request by the same holder.
      if (existing.holder === participantId && existing.conversationId === conversationId) {
        return { ok: true, transmissionId, repeat: true, idleLeaseMs: this.#idleLeaseMs, maxMs: this.#maxMs };
      }
      return { ok: false, reason: "duplicate-transmission-id" };
    }
    if (this.#seen.has(transmissionId)) return { ok: false, reason: "duplicate-transmission-id" };

    if (this.#byHolder.has(participantId)) return { ok: false, reason: "already-transmitting" };
    if (this.#byConversation.has(conversationId)) return { ok: false, reason: "busy" };

    const now = this.#now();
    const a: Active = { conversationId, transmissionId, holder: participantId, startedAtMs: now, lastActivityMs: now };
    this.#byConversation.set(conversationId, a);
    this.#byTransmission.set(transmissionId, a);
    this.#byHolder.set(participantId, a);
    this.#remember(transmissionId);
    this.#onEvent({ type: "granted", conversationId, transmissionId, holder: participantId, startedAtMs: now });
    return { ok: true, transmissionId, repeat: false, idleLeaseMs: this.#idleLeaseMs, maxMs: this.#maxMs };
  }

  // Called for every audio frame accepted from the holder. Keeps the lease
  // alive. Returns false if the sender no longer holds the floor.
  touch(transmissionId: string, participantId: string): boolean {
    this.tick();
    const a = this.#byTransmission.get(transmissionId);
    if (!a || a.holder !== participantId) return false;
    a.lastActivityMs = this.#now();
    return true;
  }

  release(transmissionId: string, participantId: string, reason: "released" | "sender-aborted" = "released"): boolean {
    const a = this.#byTransmission.get(transmissionId);
    if (!a || a.holder !== participantId) return false;
    this.#end(a, reason);
    return true;
  }

  // The holder's connection dropped. There is deliberately no resume: the user
  // must start a new transmission with a fresh action and a fresh ID.
  endAllFor(participantId: string, reason: FloorEndReason = "sender-disconnected"): void {
    const a = this.#byHolder.get(participantId);
    if (a) this.#end(a, reason);
  }

  // Administrative cut, for example when a block takes effect.
  revoke(transmissionId: string): boolean {
    const a = this.#byTransmission.get(transmissionId);
    if (!a) return false;
    this.#end(a, "revoked");
    return true;
  }

  // Expire stale leases. Safe to call as often as desired.
  tick(): void {
    const now = this.#now();
    for (const a of [...this.#byTransmission.values()]) {
      if (now - a.startedAtMs >= this.#maxMs) this.#end(a, "max-duration");
      else if (now - a.lastActivityMs >= this.#idleLeaseMs) this.#end(a, "idle-lease-expired");
    }
  }

  holderOf(conversationId: string): string | undefined {
    this.tick();
    return this.#byConversation.get(conversationId)?.holder;
  }

  isActive(transmissionId: string): boolean {
    this.tick();
    return this.#byTransmission.has(transmissionId);
  }

  get activeCount(): number {
    return this.#byTransmission.size;
  }

  members(conversationId: string): ReadonlySet<string> | undefined {
    return this.#conversations.get(conversationId);
  }

  #end(a: Active, reason: FloorEndReason): void {
    this.#byConversation.delete(a.conversationId);
    this.#byTransmission.delete(a.transmissionId);
    this.#byHolder.delete(a.holder);
    this.#onEvent({
      type: "ended",
      conversationId: a.conversationId,
      transmissionId: a.transmissionId,
      holder: a.holder,
      reason,
      endedAtMs: this.#now(),
    });
  }

  #remember(transmissionId: string): void {
    this.#seen.add(transmissionId);
    while (this.#seen.size > this.#seenLimit) {
      const oldest = this.#seen.values().next().value;
      if (oldest === undefined) break;
      this.#seen.delete(oldest);
    }
  }
}
