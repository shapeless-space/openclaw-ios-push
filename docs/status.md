# Status and evidence (2026-11-25)

Reply alerts work end to end on one live Gateway (OpenClaw 2026.11.6, Codex agent runtime) with one iPhone and one iPad owned by one person. App conversations started on each device alerted both opted-in devices, and the tester confirmed receipt with the generic text and with previews. 127 automated tests cover the policy at the plugin-host seam.

## What has been checked

| Claim | Evidence |
| --- | --- |
| A conversation started on the iPhone or the iPad alerts every opted-in device of the owner | Live, confirmed on both devices (generic, then preview) |
| `push.test` through the plugin's identity reaches the iPhone and the iPad | Live, direct test alert on both |
| The web Dashboard page lists only the caller's own iPhones and iPads, and switches them | Live, plus tests |
| The plugin's identity can call `node.list` and `push.test`, and is refused admin and pairing methods | Live (`users.setRole` and `device.pair.approve` refused with a scope mismatch); `scripts/pair-cli-identity.mjs` run against a throwaway identity |
| Telegram turns do not alert | Live (`ineligible-channel`), plus tests |
| The iOS share extension (an iPhone-family node with no commands) is not a target | Live (its push was rejected before the fix), plus tests |
| Eligibility, consent, per-device independence, deduplication, crash and timeout handling, stored-state privacy, preview formatting | Automated tests (fake host, stub CLI, fake DOM, temp state dir, injected clock) |
| The manifest passes OpenClaw's static checks | `openclaw plugins lint`: 0 warnings |

## How the Gateway reports a run

Observed live with `logEvidenceShape` on.

- **Origin** is only on the `agent_end` hook context: `channel` (`webchat` for the iOS app and the Dashboard, `telegram` for Telegram), `trigger` (`user`), and `inputProvenance` when the producer sets it. Agent events and `model_call_started` carry no origin, and the Codex runtime does not fire `model_call_started`. A non-bundled plugin needs `hooks.allowConversationAccess: true` to receive `agent_end`. The plugin reads only the context.
- **Terminal facts** are on the lifecycle `end` event: `endedAt`, `aborted`, `executionSettled`, `stopReason` (`stop`), `terminalReply.disposition` (`visible`, `silent`, `empty`), `terminalReply.text`, and `terminalReceipt` (including `sourceReplyDelivered`). `runtime.subagent.waitForRun` fails for chat runs, so the plugin does not use it.
- **Order:** the two signals arrive in either order. The plugin joins them by run id and reports `origin-missing` if `agent_end` does not follow an end event within 120 s.
- **Ownership** is on the session entry: `owner.actor` when assigned, otherwise `createdActor` (`type: "human"`, `source: "profile"`). The shared main session records no owner and is attributed to the declared owner.
- **Threads started in the iOS app** have the main session as `parentSessionKey`, `createdVia: "operator"` and `spawnDepth: 0`. They are not sub-agent runs. Spawned work has `spawnedBy`, `subagentRole`, `spawnDepth > 0`, or a parent link not created by a person.
- **Device id:** the iOS app's operator connection and its push node share one device id.
- **iOS Settings** embeds only Dashboard settings routes, so plugin pages are unreachable from the app. Devices are switched on from the web Dashboard instead.

## Known limits

1. **Single owner only.** `node.list` has no per-device owner, so every paired node is attributed to the declared `owner.profileId`. Do not use the plugin on a Gateway where other people pair devices.
2. **Re-pairing turns a device off.** Consent is bound to the node's `approvedAtMs`. That a re-pair changes it is inferred from the code, not observed.
3. **No "already reading" suppression.** No iPhone or iPad presence signal has been found, so every eligible reply alerts. Suppression exists only behind an injected viewing source.
4. **Identity setup depends on CLI internals.** `scripts/pair-cli-identity.mjs` writes the narrowed token into the identity's `credentials.sqlite`, because the CLI does not save a self-rotated token. The identity's approved baseline keeps the paired scopes, so reconnecting it with the shared token widens it again.
5. **Overlap with the Control UI's "Agent finished" Web Push** has not been examined.
6. **Tested on one Gateway, one iPhone and one iPad.**

## Behaviour choices

- An unclear outcome (timeout, unknown error, APNs or relay 5xx, unreadable output, crash after reservation) is recorded as `unknown` and never resent. An alert can be lost; a duplicate cannot occur.
- Ledger records never expire, because the host documents no finite replay horizon.
- Replies that ended before plugin start, or before a device was switched on, are never sent.
- Switching a device off does not recall alerts already accepted or in flight.
- Preview text goes only into the push request, never into the ledger, the consent store or the log.
