# Status and evidence (2026-11-25)

**Summary:** reply alerts work end to end on one live Gateway (OpenClaw 2026.11.6, Codex agent runtime) with one iPhone and one iPad, both owned by the same person. Real app conversations started on the iPhone and on the iPad each produced an alert on both opted-in devices. The tester confirmed receipt, first with the generic text and then with previews. The policy is also covered by 127 automated tests at the plugin-host seam.

## What has been checked, and how

| Claim | Evidence |
| --- | --- |
| An app conversation started on the iPhone, and one started on the iPad, each alert every opted-in iPhone/iPad of the owner | Live, confirmed by the person on both devices (generic text, then preview text) |
| `push.test` through the plugin's own identity reaches an iPhone and an iPad | Live, both received a direct test alert |
| Devices are switched on from the web Dashboard's Reply alerts page; the list shows only the caller's own iPhones and iPads | Live, plus tests |
| The plugin's identity (`identityDir`) can call `node.list` and `push.test`, and is refused admin and pairing methods | Live (`users.setRole` and `device.pair.approve` refused with a scope mismatch), plus `scripts/pair-cli-identity.mjs` run against a throwaway identity |
| Telegram turns do not alert | Live (`ineligible-channel` for a Telegram group turn), plus tests |
| The iOS share extension (a separate iPhone-family node with no commands) is not a target | Live (its push was rejected before the fix), plus tests |
| Eligibility, consent, per-device independence, durable deduplication, crash and timeout handling, privacy of stored state, preview formatting | Automated tests (fake host, stub CLI, fake DOM, temp state dir, injected clock) |
| The manifest passes OpenClaw's static checks | `openclaw plugins lint`: 0 warnings |

## How the Gateway reports a run (observed live)

These were found with `logEvidenceShape` on. They replace guesses that were made from the docs earlier.

- **Origin is only on the `agent_end` hook context:** `channel` (`webchat` for the iOS app and Dashboard, `telegram` for Telegram) and `trigger` (`user`), with `inputProvenance` when the producer sets it. Agent events and `model_call_started` carry no origin, and the Codex runtime does not fire `model_call_started`. A non-bundled plugin needs `hooks.allowConversationAccess: true` to receive `agent_end`. The plugin reads only the context.
- **Terminal facts are on the lifecycle `end` event:** `endedAt`, `aborted`, `executionSettled`, `stopReason` (`stop`), `terminalReply.disposition` (`visible` / `silent` / `empty`) and `terminalReply.text`, plus `terminalReceipt` (with `sourceReplyDelivered`). `runtime.subagent.waitForRun` fails for chat runs, so the plugin does not use it.
- **The two signals arrive in no fixed order.** The plugin joins them by run id. If an end event's `agent_end` does not arrive within 120 s, the plugin reports `origin-missing`.
- **Ownership is on the session entry:** `owner.actor` when assigned, otherwise `createdActor` (`type: "human"`, `source: "profile"`). The shared main session records no owner, so it is attributed to the declared single owner.
- **Threads started in the iOS app** carry `parentSessionKey` of the main session with `createdVia: "operator"` and `spawnDepth: 0`. They are not sub-agent runs. Spawned work has `spawnedBy`, `subagentRole`, `spawnDepth > 0` or a parent link not created by a person.
- **The iOS app's operator connection and its push node share one device id,** so the device the Dashboard sees is the device that receives the push.
- **The iOS app's Settings screen embeds only Dashboard settings routes,** so plugin pages are not reachable from the app. That is why devices are switched on from the web Dashboard.

## Known limits

1. **Single owner only.** `node.list` carries no per-device owner. The administrator declares `owner.profileId`, and every paired node is attributed to that person. Do not use this plugin on a Gateway where other people pair devices.
2. **Re-pairing a device turns it off.** Consent is bound to the node's `approvedAtMs`. That a re-pair changes this value is inferred from the code, not observed.
3. **No "already reading" suppression yet.** No iPhone or iPad presence signal has been found. Every eligible reply alerts, even when you are looking at it. Suppression exists only behind an injected viewing source.
4. **Identity setup depends on CLI internals.** `scripts/pair-cli-identity.mjs` writes the narrowed token into the identity's `credentials.sqlite`, because the CLI does not save a self-rotated token. Its approved baseline stays at the paired scopes. Reconnecting that identity with the shared token would widen it again.
5. **Overlap with the Control UI's own "Agent finished" Web Push** has not been examined.
6. **Tested on one Gateway, one iPhone and one iPad only.**

## Deliberate behaviour choices

- An unclear outcome is recorded as `unknown` and never resent. This covers a timeout, an unrecognised error, an APNs or relay 5xx, unreadable output, or a crash after reservation. An alert can be lost; a duplicate cannot occur.
- Ledger records are never expired, because the host documents no finite replay horizon.
- Replies that ended before plugin start, or before a device was switched on, are never sent (no backlog).
- Alerts already accepted or in flight cannot be recalled by switching a device off.
- Preview text is used only for the push request. It is never written to the ledger, the consent store or the log.
