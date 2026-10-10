# Phase 00B: file ownership

To avoid editing the same files, each area has one owner. Propose changes to
another owner's area in review rather than editing it directly.

| Area | Owner |
| --- | --- |
| `server/` (floor control, relay, APNs sender, tests) | Jason |
| `protocol-fixtures/` (shared wire fixtures) | Jason (JD reviews changes) |
| `ios/ChirpCore/` (state machine, Swift wire protocol) | Jason |
| `ios/ChirpLab/ChirpLab/PTT/`, `Net/`, `Audio/`, `LabModel.swift`, `Support/` | Jason |
| `ios/ChirpLab/ChirpLab/Harness/` (user-visible states, interaction harness) | JD |
| Physical-controls experiment (Control widget / App Intent targets, accessory tests) | JD |
| Usability, accessibility and demand-study evidence | JD |

## Interfaces JD can rely on

`LabModel` (main actor, observable) is the only thing the harness needs:

- State: `phase`, `joined`, `connection`, `notice`, `managerStatus`.
- Actions: `connect()`, `disconnect()`, `join()`, `leave()`, `press(_:)`,
  `release(_:)`, `toggle(_:)`, `setMode(_:)`.
- Every entry point (in-app, system UI, intent, accessory) goes through the same
  state machine. For an App Intent or Control, call `LabModel.shared.toggle(.intent)`;
  for an accessory, the framework reports `handsfreeButton` and the model handles it.
- Do not activate or deactivate the audio session, and do not start the microphone
  directly. Only the state machine's effects do that.

Adding a Control widget or intent extension means adding a target to
`ios/ChirpLab/project.yml`. Edit that file only after agreeing with Jason, since
the app target is declared there too.
