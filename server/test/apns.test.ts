import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify as cryptoVerify, type KeyObject } from "node:crypto";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { ApnsPttSender } from "../src/apns.ts";
import { listen, login, makeHub, requestFloor } from "./helpers.ts";

type Seen = { headers: http2.IncomingHttpHeaders; body: string };

async function mockApns(respond: (seen: Seen) => { status: number; reason?: string; delayMs?: number }) {
  const seen: Seen[] = [];
  const sessions = new Set<http2.ServerHttp2Session>();
  const timers = new Set<NodeJS.Timeout>();
  const server = http2.createServer();
  server.on("session", (s) => {
    sessions.add(s);
    s.on("close", () => sessions.delete(s));
  });
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      const s = { headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(s);
      const r = respond(s);
      const reply = () => {
        // The client may have cancelled (timeout test); replying then is moot.
        if (stream.destroyed || stream.closed) return;
        stream.respond({ ":status": r.status, "apns-id": "00000000-0000-4000-8000-000000000000" });
        stream.end(r.reason ? JSON.stringify({ reason: r.reason }) : undefined);
      };
      if (r.delayMs) timers.add(setTimeout(reply, r.delayMs));
      else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const authority = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    seen,
    authority,
    async close() {
      for (const t of timers) clearTimeout(t);
      for (const s of sessions) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function throwawayKey(): { pem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey };
}

test("sends the documented PTT headers and a verifiable ES256 provider token", async () => {
  const apns = await mockApns(() => ({ status: 200 }));
  const { pem, publicKey } = throwawayKey();
  const sender = new ApnsPttSender({
    mode: "mock",
    authority: apns.authority,
    bundleId: "com.example.chirplab",
    teamId: "TEAM123456",
    keyId: "KEY1234567",
    keyPem: pem,
  });
  try {
    const res = await sender.send("0AbC12", { transmissionId: "11111111-1111-4111-8111-111111111111", senderRef: "abc123" });
    assert.equal(res.status, 200);
    assert.equal(res.tokenInvalid, false);
    const { headers, body } = apns.seen[0]!;
    assert.equal(headers[":path"], "/3/device/0abc12");
    assert.equal(headers["apns-push-type"], "pushtotalk");
    assert.equal(headers["apns-topic"], "com.example.chirplab.voip-ptt");
    assert.equal(headers["apns-priority"], "10");
    assert.equal(headers["apns-expiration"], "0");
    assert.deepEqual(JSON.parse(body), { transmissionId: "11111111-1111-4111-8111-111111111111", senderRef: "abc123" });

    const auth = String(headers["authorization"]);
    assert.ok(auth.startsWith("bearer "));
    const [h, c, s] = auth.slice(7).split(".") as [string, string, string];
    assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "ES256", kid: "KEY1234567" });
    const claims = JSON.parse(Buffer.from(c, "base64url").toString()) as { iss: string; iat: number };
    assert.equal(claims.iss, "TEAM123456");
    assert.ok(Math.abs(claims.iat - Date.now() / 1000) < 5);
    const ok = cryptoVerify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    assert.equal(ok, true, "provider token signature must verify");
  } finally {
    sender.close();
    await apns.close();
  }
});

test("the provider token is reused rather than regenerated on every push", async () => {
  const apns = await mockApns(() => ({ status: 200 }));
  const { pem } = throwawayKey();
  let nowMs = Date.now();
  const sender = new ApnsPttSender({
    mode: "mock", authority: apns.authority, bundleId: "com.example.chirplab",
    teamId: "T", keyId: "K", keyPem: pem, now: () => nowMs,
  });
  try {
    await sender.send("aa", { transmissionId: "t", senderRef: "r" });
    nowMs += 10 * 60_000;
    await sender.send("aa", { transmissionId: "t", senderRef: "r" });
    nowMs += 40 * 60_000; // past the 40 minute refresh point
    await sender.send("aa", { transmissionId: "t", senderRef: "r" });
    const tokens = apns.seen.map((s) => String(s.headers["authorization"]));
    assert.equal(tokens[0], tokens[1]);
    assert.notEqual(tokens[1], tokens[2]);
  } finally {
    sender.close();
    await apns.close();
  }
});

test("responses that mean a token is dead are flagged; transient failures are not", async () => {
  const responses = [
    { status: 410, reason: "Unregistered" },
    { status: 400, reason: "BadDeviceToken" },
    { status: 400, reason: "DeviceTokenNotForTopic" },
    { status: 429, reason: "TooManyRequests" },
    { status: 500, reason: "InternalServerError" },
    { status: 200 },
  ];
  let i = 0;
  const apns = await mockApns(() => responses[i++]!);
  const sender = new ApnsPttSender({ mode: "mock", authority: apns.authority, bundleId: "com.example.chirplab" });
  try {
    const flags: boolean[] = [];
    for (let n = 0; n < responses.length; n++) {
      flags.push((await sender.send("aa", { transmissionId: "t", senderRef: "r" })).tokenInvalid);
    }
    assert.deepEqual(flags, [true, true, true, false, false, false]);
  } finally {
    sender.close();
    await apns.close();
  }
});

test("a server that never answers produces a timeout result, not a hang", async () => {
  const apns = await mockApns(() => ({ status: 200, delayMs: 2_000 }));
  const sender = new ApnsPttSender({ mode: "mock", authority: apns.authority, bundleId: "com.example.chirplab", timeoutMs: 150 });
  try {
    const res = await sender.send("aa", { transmissionId: "t", senderRef: "r" });
    assert.equal(res.status, -1);
    assert.equal(res.reason, "timeout");
    assert.equal(res.tokenInvalid, false);
  } finally {
    sender.close();
    await apns.close();
  }
});

test("dry-run mode records the request and contacts nothing", async () => {
  const sender = new ApnsPttSender({ bundleId: "com.example.chirplab" });
  const res = await sender.send("ab", { transmissionId: "t", senderRef: "r" });
  assert.equal(res.dryRun, true);
  assert.equal(res.status, 0);
  assert.equal(sender.requests.length, 1);
});

test("live mode refuses to start without credentials", () => {
  assert.throws(() => new ApnsPttSender({ mode: "live", bundleId: "com.example.chirplab" }), /requires teamId, keyId and keyPem/);
  assert.throws(() => new ApnsPttSender({ mode: "mock", bundleId: "com.example.chirplab" }), /requires an authority/);
});

test("a malformed token or oversize payload is rejected before any network use", () => {
  const sender = new ApnsPttSender({ bundleId: "com.example.chirplab" });
  assert.throws(() => sender.buildRequest("not-hex!", { transmissionId: "t", senderRef: "r" }), TypeError);
  assert.throws(() => sender.buildRequest("ab", { transmissionId: "x".repeat(5_000), senderRef: "r" }), RangeError);
});

test("an invalid-token response stops further pushes to that device but keeps it listening", async () => {
  const apns = await mockApns(() => ({ status: 410, reason: "Unregistered" }));
  const push = new ApnsPttSender({ mode: "mock", authority: apns.authority, bundleId: "com.example.chirplab" });
  const { hub, log } = makeHub({ push });
  try {
    const alpha = login(hub, "alpha");
    const bravo = login(hub, "bravo");
    listen(hub, bravo, "dead01");
    const first = requestFloor(hub, alpha);
    await waitFor(() => log.named("apns.response").length === 1);
    assert.equal(hub.listening.get("bravo")?.tokenValid, false);
    assert.equal(hub.listening.isListening("bravo"), true);
    assert.equal(log.named("apns.response")[0]?.["tokenInvalid"], true);

    hub.floor.release(first, "alpha");
    requestFloor(hub, alpha);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(apns.seen.length, 1, "no second push to a token APNs rejected");

    // Registering a fresh token (a new join) makes the device pushable again.
    listen(hub, bravo, "beef02");
    assert.equal(hub.listening.get("bravo")?.tokenValid, true);
  } finally {
    push.close();
    await apns.close();
  }
});

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}
