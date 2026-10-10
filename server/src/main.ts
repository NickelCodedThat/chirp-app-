import { resolve } from "node:path";
import { ApnsPttSender, loadApnsKey } from "./apns.ts";
import { Hub } from "./hub.ts";
import { Identity } from "./identity.ts";
import { EventLog } from "./instrumentation.ts";
import { startLabServer } from "./server.ts";

// Lab entrypoint. Configuration comes from the environment; nothing secret has
// a default and nothing is read from the repository except the fake example
// participants.

const env = process.env;
const host = env["CHIRP_HOST"] ?? "127.0.0.1";
const port = Number(env["CHIRP_PORT"] ?? 8787);
const usingExample = !env["CHIRP_PARTICIPANTS"];
const participantsPath = resolve(env["CHIRP_PARTICIPANTS"] ?? "participants.example.json");

const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
if (usingExample && !loopback) {
  console.error("Refusing to bind a non-loopback address with the example participants (their tokens are public).");
  console.error("Set CHIRP_PARTICIPANTS to a local, gitignored file (for example participants.local.json).");
  process.exit(2);
}

const mode = (env["CHIRP_APNS_MODE"] ?? "dry-run") as "dry-run" | "live";
let push: ApnsPttSender | undefined;
const bundleId = env["CHIRP_APNS_BUNDLE_ID"];
if (bundleId) {
  if (mode === "live") {
    const keyPath = env["CHIRP_APNS_KEY_PATH"];
    if (!keyPath || !env["CHIRP_APNS_KEY_ID"] || !env["CHIRP_APNS_TEAM_ID"]) {
      console.error("live APNs mode requires CHIRP_APNS_KEY_PATH, CHIRP_APNS_KEY_ID and CHIRP_APNS_TEAM_ID");
      process.exit(2);
    }
    push = new ApnsPttSender({
      mode: "live",
      bundleId,
      teamId: env["CHIRP_APNS_TEAM_ID"],
      keyId: env["CHIRP_APNS_KEY_ID"],
      keyPem: loadApnsKey(keyPath),
      authority: env["CHIRP_APNS_AUTHORITY"],
    });
  } else {
    push = new ApnsPttSender({ mode: "dry-run", bundleId });
  }
}

const hub = new Hub({
  identity: Identity.fromFile(participantsPath),
  log: new EventLog({ path: env["CHIRP_EVENT_LOG"] }),
  push,
});

const server = await startLabServer({ hub, host, port });
console.log(`chirp lab server listening on ${host}:${server.port} (apns: ${push ? push.mode : "off"})`);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void server.close().then(() => process.exit(0)));
}
