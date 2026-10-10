import { createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import http2 from "node:http2";

// APNs delivery for Push to Talk, following Apple's "Sending notification
// requests to APNs" and "Creating a Push to Talk app":
//   apns-push-type: pushtotalk
//   apns-topic:     <bundle id>.voip-ptt
//   apns-priority:  10
//   apns-expiration: 0   (one delivery attempt, never stored)
// Authentication is token-based (a .p8 key). The key is read from a path given
// by the environment and is never logged or placed in the repository.
//
// Modes:
//   dry-run  default. Builds the exact request but sends nothing.
//   live     requires explicit opt-in and credentials. Sends to APNs.
//   mock     tests only: sends to a local HTTP/2 server given by `authority`.

export type ApnsMode = "dry-run" | "live" | "mock";

export type ApnsRequestRecord = {
  path: string;
  headers: Record<string, string>;
  body: string;
};

export type ApnsResult = {
  status: number; // 0 for dry-run
  apnsId?: string;
  reason?: string;
  elapsedMs: number;
  dryRun: boolean;
  // True when the response means this token can never work again.
  tokenInvalid: boolean;
};

export type PttPushPayload = {
  transmissionId: string;
  // Opaque sender reference. The app maps it to a name from its local cache, so
  // no account identifier or display name transits APNs.
  senderRef: string;
};

export type ApnsOptions = {
  mode?: ApnsMode;
  teamId?: string;
  keyId?: string;
  bundleId: string;
  // PEM contents of the .p8 key. Prefer loadApnsKey().
  keyPem?: string;
  // Defaults to the development (sandbox) server.
  authority?: string;
  timeoutMs?: number;
  now?: () => number;
};

export const APNS_SANDBOX = "https://api.sandbox.push.apple.com";
export const APNS_PRODUCTION = "https://api.push.apple.com";

export function loadApnsKey(path: string): string {
  return readFileSync(path, "utf8");
}

export class ApnsPttSender {
  readonly mode: ApnsMode;
  readonly #opts: ApnsOptions;
  readonly #key: KeyObject | undefined;
  readonly #now: () => number;
  #jwt: { token: string; issuedAtMs: number } | undefined;
  #session: http2.ClientHttp2Session | undefined;
  readonly requests: ApnsRequestRecord[] = [];

  constructor(opts: ApnsOptions) {
    this.#opts = opts;
    this.mode = opts.mode ?? "dry-run";
    this.#now = opts.now ?? Date.now;
    if (this.mode === "live") {
      if (!opts.teamId || !opts.keyId || !opts.keyPem) {
        throw new Error("live APNs mode requires teamId, keyId and keyPem");
      }
    }
    if (opts.keyPem) this.#key = createPrivateKey(opts.keyPem);
    if (this.mode === "mock" && !opts.authority) throw new Error("mock mode requires an authority");
  }

  get topic(): string {
    return `${this.#opts.bundleId}.voip-ptt`;
  }

  buildRequest(pttTokenHex: string, payload: PttPushPayload): ApnsRequestRecord {
    if (!/^[0-9a-fA-F]+$/.test(pttTokenHex)) throw new TypeError("push token must be hex");
    const body = JSON.stringify(payload);
    // Apple documents a 4 KB limit for standard payloads.
    if (Buffer.byteLength(body) > 4096) throw new RangeError("payload exceeds 4 KB");
    const headers: Record<string, string> = {
      "apns-push-type": "pushtotalk",
      "apns-topic": this.topic,
      "apns-priority": "10",
      "apns-expiration": "0",
      "content-type": "application/json",
    };
    return { path: `/3/device/${pttTokenHex.toLowerCase()}`, headers, body };
  }

  async send(pttTokenHex: string, payload: PttPushPayload): Promise<ApnsResult> {
    const started = performance.now();
    const req = this.buildRequest(pttTokenHex, payload);
    this.requests.push({ ...req, headers: { ...req.headers } });
    if (this.requests.length > 1_000) this.requests.shift();

    if (this.mode === "dry-run") {
      return { status: 0, elapsedMs: performance.now() - started, dryRun: true, tokenInvalid: false };
    }
    if (this.#key) req.headers["authorization"] = `bearer ${this.#providerToken()}`;

    const authority = this.#opts.authority ?? APNS_SANDBOX;
    const result = await this.#post(authority, req);
    const tokenInvalid =
      result.status === 410 ||
      (result.status === 400 && (result.reason === "BadDeviceToken" || result.reason === "DeviceTokenNotForTopic"));
    return { ...result, elapsedMs: performance.now() - started, dryRun: false, tokenInvalid };
  }

  close(): void {
    this.#session?.close();
    this.#session = undefined;
  }

  // ES256 provider token. Apple asks providers not to refresh more often than
  // every 20 minutes, and rejects tokens older than 60 minutes.
  #providerToken(): string {
    const now = this.#now();
    if (this.#jwt && now - this.#jwt.issuedAtMs < 40 * 60_000) return this.#jwt.token;
    const header = b64url(JSON.stringify({ alg: "ES256", kid: this.#opts.keyId }));
    const claims = b64url(JSON.stringify({ iss: this.#opts.teamId, iat: Math.floor(now / 1000) }));
    const signingInput = `${header}.${claims}`;
    const sig = cryptoSign("sha256", Buffer.from(signingInput), { key: this.#key!, dsaEncoding: "ieee-p1363" });
    this.#jwt = { token: `${signingInput}.${b64url(sig)}`, issuedAtMs: now };
    return this.#jwt.token;
  }

  #connect(authority: string): http2.ClientHttp2Session {
    if (this.#session && !this.#session.closed && !this.#session.destroyed) return this.#session;
    const s = http2.connect(authority);
    s.on("error", () => {
      this.#session = undefined;
    });
    s.on("close", () => {
      if (this.#session === s) this.#session = undefined;
    });
    this.#session = s;
    return s;
  }

  #post(authority: string, req: ApnsRequestRecord): Promise<{ status: number; apnsId?: string; reason?: string }> {
    const timeoutMs = this.#opts.timeoutMs ?? 5_000;
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: { status: number; apnsId?: string; reason?: string }) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      try {
        const session = this.#connect(authority);
        const stream = session.request({ ":method": "POST", ":path": req.path, ...req.headers });
        stream.setTimeout(timeoutMs, () => {
          stream.close(http2.constants.NGHTTP2_CANCEL);
          done({ status: -1, reason: "timeout" });
        });
        let status = 0;
        let apnsId: string | undefined;
        const chunks: Buffer[] = [];
        stream.on("response", (h) => {
          status = Number(h[":status"] ?? 0);
          const id = h["apns-id"];
          apnsId = Array.isArray(id) ? id[0] : id;
        });
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => {
          let reason: string | undefined;
          if (chunks.length) {
            try {
              reason = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { reason?: string }).reason;
            } catch {
              reason = "unparseable-response";
            }
          }
          done({ status, apnsId, reason });
        });
        stream.on("error", () => done({ status: -1, reason: "stream-error" }));
        stream.end(req.body);
      } catch {
        done({ status: -1, reason: "connect-error" });
      }
    });
  }
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}
