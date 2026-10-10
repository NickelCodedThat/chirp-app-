import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Structured experiment events as JSON lines. Fields are restricted to
// primitives, so audio payloads (byte arrays) cannot be logged by accident.
// Every event carries a monotonic timestamp for intervals and a wall-clock
// timestamp for correlation with device logs.

export type EventFields = Record<string, string | number | boolean | null | undefined>;
export type LabEvent = { mono: number; wall: number; event: string } & EventFields;

export class EventLog {
  readonly events: LabEvent[] = [];
  readonly #path: string | undefined;
  readonly #keep: boolean;

  constructor(opts: { path?: string; keepInMemory?: boolean } = {}) {
    this.#path = opts.path;
    if (opts.path) mkdirSync(dirname(opts.path), { recursive: true });
    this.#keep = opts.keepInMemory ?? true;
  }

  record(event: string, fields: EventFields = {}): void {
    for (const [k, v] of Object.entries(fields)) {
      if (v !== null && v !== undefined && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        throw new TypeError(`event field ${k} must be a primitive`);
      }
    }
    const e: LabEvent = { mono: performance.now(), wall: Date.now(), event, ...fields };
    if (this.#keep) {
      this.events.push(e);
      if (this.events.length > 50_000) this.events.splice(0, 10_000);
    }
    if (this.#path) appendFileSync(this.#path, JSON.stringify(e) + "\n");
  }

  named(name: string): LabEvent[] {
    return this.events.filter((e) => e.event === name);
  }
}
