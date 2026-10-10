import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

// Experimental identity and authorization data. This is a lab fixture, not an
// account system: a handful of pre-provisioned test participants, one or more
// private test conversations and an optional block list. Real participant
// identities and real tokens belong only in a gitignored local file.

export type ParticipantConfig = { id: string; token: string };
export type LabConfig = {
  participants: ParticipantConfig[];
  conversations: { id: string; members: string[] }[];
  blocks?: [blocker: string, blocked: string][];
};

export class Identity {
  readonly #byTokenHash = new Map<string, string>();
  readonly #participants = new Set<string>();
  readonly #conversations = new Map<string, Set<string>>();
  readonly #blocks = new Set<string>();

  constructor(cfg: LabConfig) {
    for (const p of cfg.participants) {
      if (!p.id || !p.token) throw new Error("participant requires id and token");
      this.#participants.add(p.id);
      this.#byTokenHash.set(hash(p.token), p.id);
    }
    for (const c of cfg.conversations) {
      for (const m of c.members) {
        if (!this.#participants.has(m)) throw new Error(`conversation ${c.id}: unknown member ${m}`);
      }
      this.#conversations.set(c.id, new Set(c.members));
    }
    for (const [a, b] of cfg.blocks ?? []) this.block(a, b);
  }

  static fromFile(path: string): Identity {
    return new Identity(JSON.parse(readFileSync(path, "utf8")) as LabConfig);
  }

  // Returns the participant ID for a presented bearer token, or undefined.
  authenticate(token: string): string | undefined {
    const presented = Buffer.from(hash(token), "hex");
    let found: string | undefined;
    for (const [h, id] of this.#byTokenHash) {
      // Compare against every stored hash so timing does not reveal a match position.
      if (timingSafeEqual(presented, Buffer.from(h, "hex"))) found = id;
    }
    return found;
  }

  get conversations(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.#conversations;
  }

  block(blocker: string, blocked: string): void {
    this.#blocks.add(`${blocker}>${blocked}`);
  }

  // A block in either direction prevents audio flowing between the two.
  isBlockedEitherWay(a: string, b: string): boolean {
    return this.#blocks.has(`${a}>${b}`) || this.#blocks.has(`${b}>${a}`);
  }

  // Short opaque reference for push payloads and logs, so neither carries an
  // account identifier.
  refFor(participantId: string): string {
    return createHash("sha256").update(`ref:${participantId}`).digest("hex").slice(0, 10);
  }
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
