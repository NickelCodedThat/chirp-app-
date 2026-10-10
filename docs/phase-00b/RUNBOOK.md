# Phase 00B runbook

## Prerequisites

- macOS with Xcode 26 or later, Node 24 or later, and XcodeGen (`brew install xcodegen`).
- For device work: an Apple Developer team signed in to Xcode, two registered
  iPhones with Developer Mode on, and an APNs auth key. See `EVIDENCE.md`, blockers.

## Automated tests (no devices needed)

```bash
cd server && npm install && npm test && npx tsc --noEmit
cd ios/ChirpCore && swift test
```

## Run the lab server

The server binds to loopback by default and uses fake example participants
(`server/participants.example.json`). To reach it from a phone on your Wi-Fi, copy
that file to `server/participants.local.json` (gitignored), replace the tokens with
random test values, and bind to your LAN address:

```bash
cd server
CHIRP_PARTICIPANTS=participants.local.json CHIRP_HOST=<mac-lan-ip> CHIRP_PORT=8787 \
  CHIRP_EVENT_LOG=../results/raw/server-events.jsonl npm start
```

The server refuses a non-loopback bind while the public example tokens are in use.
APNs defaults to dry-run (builds requests, sends nothing). To send real pushes, set
`CHIRP_APNS_MODE=live` with `CHIRP_APNS_BUNDLE_ID`, `CHIRP_APNS_TEAM_ID`,
`CHIRP_APNS_KEY_ID` and `CHIRP_APNS_KEY_PATH` (a path outside the repository), and
never commit the key.

## Build the lab app

```bash
cd ios/ChirpLab && xcodegen generate
open ChirpLab.xcodeproj    # set your Team under Signing & Capabilities
```

The bundle ID `com.example.chirplab` is a placeholder; it must be changed to the
founder-approved identifier before signing. Enable the Push to Talk and Push
Notifications capabilities and the Push to Talk background mode (already declared in
`Info.plist` and the entitlements file).

Unsigned compile check (what has been verified so far):

```bash
xcodebuild -project ios/ChirpLab/ChirpLab.xcodeproj -scheme ChirpLab \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

## Simulator check

```bash
xcodebuild -project ios/ChirpLab/ChirpLab.xcodeproj -scheme ChirpLab \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath /tmp/chirp-dd \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
xcrun simctl boot "iPhone 17"
xcrun simctl install booted /tmp/chirp-dd/Build/Products/Debug-iphonesimulator/ChirpLab.app
xcrun simctl launch booted com.example.chirplab
cat "$(xcrun simctl get_app_container booted com.example.chirplab data)/Documents/lab-events.jsonl"
```

Expected: `ptt.manager-failed` with `instantiation.invalidPlatform`.

## Device test procedure (once B1 and B2 are cleared)

1. Run the server on the LAN. Install the app on two phones. On each, enter the
   server URL (`ws://<mac-lan-ip>:8787`), that phone's test token and the
   conversation (`lab-1`). Tap Connect.
2. Tap Join in the foreground. Confirm in the log: `ptt.did-join`,
   `ptt.ephemeral-token`, `net.listening-register-sent`.
3. For each receiver state in the matrix (foreground, backgrounded, locked,
   force-quit while joined, after reboot before and after first unlock, Low Power
   Mode): from the other phone, hold the talk button for a fixed test phrase.
   Record the server log and both phones' logs.
4. Pull logs. Phones: Files app, On My iPhone, Chirp Lab, `lab-events.jsonl`
   (or Finder file sharing). Server: the `CHIRP_EVENT_LOG` file.
5. Correlate by `tx` / `transmissionId`. Device `mono` timestamps are only comparable
   within one device; use `wall` plus a clock offset (`clock.ping`) for cross-device
   intervals, and calibrate against an acoustic recording.

### Acoustic latency

Use equipment already on hand; do not purchase a rig. Record both the source
speaker and the receiving phone's speaker on one multichannel recorder (or a Mac
with a stereo input), and find the lag by cross-correlating onsets. Keep the phones
acoustically isolated. Use synthetic speech or consenting adults only, and do not
commit recordings (`.gitignore` excludes common audio formats).

### Sample sizes

Report p50/p95 only where the sample supports it. About 30 trials per primary cell
and 10 per secondary cell is the working guideline. Smaller samples are
**preliminary** and must be labeled so. With zero failures in n trials the 95% upper
bound on the failure rate is roughly 3/n.
