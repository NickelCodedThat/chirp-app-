// Shared wire protocol for the Phase 00B lab. Platform-neutral: nothing here
// refers to Apple APIs. Control messages are JSON text frames. Audio is carried
// in binary frames: a 4-byte big-endian sequence number followed by the codec
// payload. A connection is bound to at most one transmission at a time, so
// audio frames need no transmission ID on the wire.

export const PROTOCOL_VERSION = 1;

// Experimental parameters. These are lab values, not product requirements.
export const DEFAULTS = {
  // Maximum length of a single transmission (provisional, Phase 00B brief).
  maxTransmissionMs: 30_000,
  // A floor holder that sends no audio frame for this long loses the floor.
  idleLeaseMs: 2_000,
  // Nominal audio frame duration used to bound the startup buffer.
  frameMs: 20,
  // Startup buffer: RAM only, bounded in duration and lifetime.
  bufferMaxMs: 5_000,
  bufferPostEndExpiryMs: 10_000,
  // Frame sanity limits.
  maxFrameBytes: 1_200,
  maxFramesPerSecond: 100,
  // How many ended transmission IDs we remember to reject replays.
  seenTransmissionIdLimit: 2_048,
} as const;

export const FRAME_HEADER_BYTES = 4;

export type FloorDenyReason =
  | "busy"
  | "not-member"
  | "unknown-conversation"
  | "duplicate-transmission-id"
  | "already-transmitting"
  | "bad-request";

export type FloorEndReason =
  | "released"
  | "idle-lease-expired"
  | "max-duration"
  | "sender-disconnected"
  | "sender-aborted"
  | "revoked";

export type ClientMessage =
  | { type: "hello"; token: string; deviceId: string; protocol: number }
  | { type: "listening.register"; pttToken?: string }
  | { type: "listening.unregister" }
  | { type: "floor.request"; reqId: string; conversationId: string; transmissionId: string }
  | { type: "floor.release"; transmissionId: string; reason?: "released" | "sender-aborted" }
  | { type: "attach"; transmissionId: string }
  | { type: "clock.ping"; clientSentMs: number };

export type ServerMessage =
  | { type: "hello.ok"; participantRef: string; serverTimeMs: number }
  | { type: "hello.denied"; reason: "bad-token" | "bad-protocol" }
  | { type: "listening.ok" }
  // reachable counts authorized recipients currently registered to listen. It
  // deliberately cannot distinguish "not listening" from "blocked".
  | { type: "floor.granted"; reqId: string; transmissionId: string; idleLeaseMs: number; maxMs: number; reachable: number }
  | { type: "floor.denied"; reqId: string; reason: FloorDenyReason }
  | { type: "floor.ended"; transmissionId: string; reason: FloorEndReason }
  // Sent to a recipient attached to a transmission. startSeq is the first
  // sequence number the relay can still supply; startSeq > 0 means the head of
  // the transmission was no longer buffered (first-word loss is measurable).
  | { type: "attach.ok"; transmissionId: string; startSeq: number; headDropped: boolean }
  | { type: "attach.denied"; transmissionId: string }
  | { type: "transmission.ended"; transmissionId: string; reason: FloorEndReason; lastSeq: number }
  | { type: "clock.pong"; clientSentMs: number; serverTimeMs: number }
  | { type: "error"; reason: string };

export function encodeFrame(seq: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  new DataView(out.buffer).setUint32(0, seq >>> 0, false);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

export function decodeFrame(buf: Uint8Array): { seq: number; payload: Uint8Array } | null {
  if (buf.byteLength < FRAME_HEADER_BYTES) return null;
  const seq = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false);
  return { seq, payload: buf.subarray(FRAME_HEADER_BYTES) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}
