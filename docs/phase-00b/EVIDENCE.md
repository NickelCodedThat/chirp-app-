# Phase 00B evidence log

Status labels used throughout:

- **Tested**: automated tests ran and passed (commands below).
- **Simulated**: exercised only against local fakes or the iOS Simulator.
- **Built, not device-tested**: compiles for the iPhone SDK, never run on a device.
- **Blocked**: cannot proceed without something outside engineering's authority.
- **Proposed**: designed, not built.

Nothing in this file is a performance claim. No latency, wake, reliability or
battery measurement has been taken, because no physical device has been
available. Those entries stay empty until real data exists.

## Environment (2026-10-10)

| Item | Value |
| --- | --- |
| Xcode / iOS SDK | 26.6 / iOS 26.5 (simulator runtime 26.5 only) |
| Swift | 6.3.3 |
| Node | 24.3.0 |
| Apple signing identities in the keychain | 0 |
| Apple ID / team configured in Xcode | none found |
| Provisioning profiles installed | none |
| Physical iPhones visible to Xcode (`devicectl`, `xctrace`) | 0 |
| Remote repository on first contact | existed, empty, public |

## Experiment status

| Experiment | Status | Detail |
| --- | --- | --- |
| A. Apple PTT foundation | Built, not device-tested. Partly simulated. | App compiles for simulator and iPhone SDK against the real PushToTalk framework. See evidence 1. Entitlement, provisioning, join, token and restoration need a device and an Apple team. **Blocked (B1, B2).** |
| B. Background / locked reception | Server side tested; device side blocked. | APNs request builder and sender tested against a local HTTP/2 mock (headers, ES256 token, token invalidation). No push has reached a device. **Blocked (B1, B2, B3).** |
| C. Audio lifecycle | State machine tested; audio built, not device-tested. | See evidence 2. Capture/playback code exists but has never run in a PTT-owned session. **Blocked (B1, B2).** |
| D. Transport comparison | Not started. | Custom relay exists (PCM stand-in codec). No managed-WebRTC comparison, no Opus, no measurements. LiveKit free tier needs an external account. **Blocked (B4).** |
| Buffer experiment | Server logic tested. | Bounds, first-attach-only replay, release after end, and "nothing buffered when nobody listens" are covered by tests. First-word preservation on real audio is unmeasured. |
| Floor control and authorization | Tested. | See evidence 2. |
| E. Physical controls | Not started. | JD's experiment. Needs devices and iOS 18+. **Blocked (B1, B2).** |
| F. Recovery | Server side tested over real local sockets; device side blocked. | Server restart, sender socket loss and idle-lease expiry covered. Wi-Fi/cellular, Bluetooth routes and background changes untested. |

## Evidence 1: PTChannelManager on the iOS Simulator (Simulated)

Unsigned debug build, iPhone 17 simulator, iOS 26.5. The app calls
`PTChannelManager.channelManager(delegate:restorationDelegate:)` at launch.
Recorded lifecycle line:

```
ptt.manager-failed  error="instantiation.invalidPlatform com.apple.pushtotalk.instantiation#1"
```

Apple documents `invalidPlatform` as "the API isn't available on the simulator or
macOS devices". This confirms that the Push to Talk framework cannot be exercised
on the simulator: **every PTT experiment requires a physical iPhone.** (The build
was unsigned, so this run says nothing about the entitlement.)

Reproduce: see `RUNBOOK.md`, "Simulator check".

## Evidence 2: automated tests (Tested)

| Suite | Command | Result |
| --- | --- | --- |
| Server (floor control, relay, authorization, buffer, APNs, WebSocket, collisions) | `cd server && npm test` | 66 passed, 0 failed |
| Server typecheck | `cd server && npx tsc --noEmit` | clean |
| Swift core (state machine, protocol, fixtures) | `cd ios/ChirpCore && swift test` | 29 passed, 0 failed |

What these establish, and what they do not:

- Floor control: at most one speaker per conversation; a participant holds one floor
  at a time; transmission IDs are never granted twice; idle (2 s) and maximum (30 s)
  leases always end a transmission; a dropped sender never resumes. Includes seeded
  randomized runs.
- Authorization: a non-member, a non-listener and a blocked party never receive
  audio or an attach acknowledgement, and denials are indistinguishable. A mid-
  transmission block cuts the blocked recipient. Audio is accepted only from the
  floor holder's own connection.
- Buffer: RAM only, at most 5 s per transmission, replayed only on a recipient's
  first attach, dropped once every recipient has attached, and removed after the
  transmission ends plus a 10 s expiry. No audio reaches the event log (the log
  rejects non-primitive fields).
- State machine: capture starts only when the floor is granted, the system has
  begun, and the audio session is active; it is on only in the `live` phase. A
  release during startup cannot be undone by any ordering of late callbacks (all
  orderings tested). After a forced stop nothing resumes. A randomized run covers
  every phase (coverage thresholds are asserted so it cannot pass vacuously).
- Simultaneous presses: 300 trials over real WebSockets, two members requesting the
  same conversation's floor back to back in random order (alpha won 160, bravo 140).
  Every trial had exactly one grant, a "busy" answer for the other party, and a free
  floor after release. This shows the one-speaker invariant under repeated contention
  on a single event loop. It is not a test of true parallelism; a multi-process
  deployment would need a shared arbiter and fresh tests.
- These are logic tests against fakes. They do not prove behavior inside Apple's
  framework, over cellular, or with real audio.

## Evidence 3: relay forwarding cost on loopback (Simulated, preliminary)

Command: `cd server && npm run bench` (synthetic frames, one process, loopback).
The sender and receiver share a clock, so these isolate what the relay itself adds.
They are **not** end-to-end, **not** acoustic, and say nothing about cellular, Wi-Fi,
APNs wake time or codec delay.

| Measurement | n | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| Relay hop, 20 ms paced frames, receiver already attached | 1000 frames | 0.41 ms | 0.66 ms | 1.76 ms |
| Attach to first replayed frame, 250 buffered frames (5 s) | 20 trials | 4.66 ms | (preliminary) | 5.53 ms |
| Attach to all 250 replayed frames | 20 trials | 5.16 ms | (preliminary) | 6.13 ms |

The replay sample is small, so only p50 and max are meaningful. Relay process memory
during the run was about 103 MB RSS, and buffered audio bytes returned to 0 afterward.
One practical finding: a sender faster than 100 frames per second is throttled by
design, so a benchmark (or a buggy client) cannot burst a whole buffer in at once.
Conclusion for Experiment D: on loopback the relay hop is not a latency concern. The
open questions are connection setup from a cold wake, audio-session coexistence and
network behavior, none of which this measures.

## Blockers

| ID | Blocker | What is needed | Experiments affected |
| --- | --- | --- | --- |
| B1 | No Apple Developer team or signing identity is configured on this machine. | Founder decision on the Apple account to use (existing paid membership, or enrollment, which needs payment). Sign-in to Xcode must be done by the founder. | A, B, C, E, F |
| B2 | No physical iPhone is connected or paired. | A device with a USB connection and Developer Mode enabled; an iPhone 15 Pro or later (Action Button) and a second device for two-phone tests. | A, B, C, D, E, F |
| B3 | No APNs authentication key. | A `.p8` key created in the Apple developer portal under the founder's team. It must never be committed (the repository is public). | B |
| B4 | No LiveKit account. | Creating an account requires personal information and acceptance of a commercial agreement, so the founder decides. Only a plan with no payment method and no overage is acceptable. | D (managed side) |
| B5 | Cellular testing needs a publicly reachable server. | Either a free tunnel the founder approves, or testing on Wi-Fi only. Not a purchase. | B, D, F (cellular rows) |

Open question B1 will also settle whether `com.apple.developer.push-to-talk` needs
a manual Apple approval; the entitlement reference page is empty and the answer
cannot be verified without a team.

## Costs incurred

$0. No purchases, enrollments, subscriptions, domains or billable services.
