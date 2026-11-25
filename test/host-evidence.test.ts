// Evidence as the live Gateway (OpenClaw 2026.11.6, Codex runtime) actually reports it, observed on
// 2026-11-25 with logEvidenceShape: the turn's origin is only on the `agent_end` hook context, the
// terminal facts are on the lifecycle end event, and ownership is on the session entry
// (`owner.actor` / `createdActor`). The shared main session records no owner at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OWNER, PHONE, startHarness } from "./support/harness.ts";

async function optedIn(options: Parameters<typeof startHarness>[0] = {}) {
  const h = await startHarness(options);
  await h.optIn();
  return h;
}

test("an app/web turn with a visible reply alerts, whichever of the two host signals arrives first", async (t) => {
  const h = await optedIn();
  t.after(() => h.dispose());

  await h.completeRun({ runId: "hook-first" });
  await h.completeRun({ runId: "lifecycle-first", lifecycleFirst: true });

  assert.equal(h.transport.pushes.length, 2);
  assert.deepEqual(h.transport.pushes.map((p) => p.deviceId), [PHONE, PHONE]);
});

test("a Telegram turn, a heartbeat and a turn relayed from another session do not alert", async (t) => {
  const h = await optedIn();
  t.after(() => h.dispose());

  await h.completeRun({ channel: "telegram" });
  await h.completeRun({ trigger: "heartbeat" });
  await h.completeRun({ hookContext: { inputProvenance: { kind: "inter_session" } } });

  assert.equal(h.transport.pushes.length, 0);
  assert.deepEqual(h.codes(), ["ineligible-channel", "not-user-turn", "not-user-turn"]);
});

test("a cancelled run does not alert", async (t) => {
  const h = await optedIn();
  t.after(() => h.dispose());

  await h.completeRun({ wait: { stopReason: "cancelled" } });

  assert.equal(h.transport.pushes.length, 0);
  assert.deepEqual(h.codes(), ["run-unsuccessful"]);
});

test("a session that names no owner (the shared main session) belongs to the declared single owner", async (t) => {
  const declared = await optedIn({ declaredOwnerId: OWNER });
  t.after(() => declared.dispose());
  await declared.completeRun({ sessionKey: "agent:main:main", entry: {} });
  assert.equal(declared.transport.pushes.length, 1);

  const undeclared = await optedIn();
  t.after(() => undeclared.dispose());
  await undeclared.completeRun({ sessionKey: "agent:main:main", entry: {} });
  assert.equal(undeclared.transport.pushes.length, 0);
  assert.deepEqual(undeclared.codes(), ["owner-unverified"]);
});

test("a session created by the owner's profile alerts; one created by someone else or by the system does not", async (t) => {
  const h = await optedIn({ declaredOwnerId: OWNER });
  t.after(() => h.dispose());

  await h.completeRun({ sessionKey: "s:owner", entry: { createdActor: { type: "human", source: "profile", id: OWNER } } });
  await h.completeRun({ sessionKey: "s:other", entry: { createdActor: { type: "human", source: "profile", id: "profile:bob" } } });
  await h.completeRun({ sessionKey: "s:system", entry: { createdActor: { type: "system" } } });
  await h.completeRun({ sessionKey: "s:assigned", entry: { createdActor: { type: "human", source: "profile", id: OWNER }, owner: { actor: { type: "human", id: "profile:bob" } } } });

  assert.equal(h.transport.pushes.length, 1);
  // Bob's devices are not this owner's: his sessions resolve to him and find no opted-in device.
  assert.deepEqual(h.codes(), ["submitted-accepted", "owner-has-no-devices", "owner-unverified", "owner-has-no-devices"]);
});

test("a terminal event whose agent_end never arrives is reported, never alerted", async (t) => {
  const h = await startHarness({ joinTimeoutMs: 20 });
  t.after(() => h.dispose());
  await h.optIn();

  await h.host.emit({ runId: "lonely", sessionKey: "agent:main:webchat:c", stream: "lifecycle", ts: 1, data: { phase: "end", endedAt: h.clock.now(), executionSettled: true, aborted: false, stopReason: "stop", terminalReply: { disposition: "visible" } } });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(h.transport.pushes.length, 0);
  assert.deepEqual(h.codes(), ["origin-missing"]);
});

test("the agent_end hook never reads the conversation's messages", async (t) => {
  const h = await optedIn();
  t.after(() => h.dispose());
  const event = { runId: "r-private", success: true };
  Object.defineProperty(event, "messages", { enumerable: true, get() { throw new Error("messages were read"); } });

  await h.host.fireHook("agent_end", event, { runId: "r-private", sessionKey: "agent:main:webchat:conversation-1", channel: "webchat", trigger: "user" });
  h.host.entries.set("agent:main:webchat:conversation-1", { owner: { actor: { type: "human", id: OWNER } } });
  await h.host.emit({ runId: "r-private", sessionKey: "agent:main:webchat:conversation-1", stream: "lifecycle", ts: 1, data: { phase: "end", endedAt: h.clock.now(), executionSettled: true, aborted: false, stopReason: "stop", terminalReply: { disposition: "visible" } } });

  assert.equal(h.transport.pushes.length, 1);
});

test("a thread the owner started under the main session alerts; spawned sessions stay children", async (t) => {
  const h = await optedIn({ declaredOwnerId: OWNER });
  t.after(() => h.dispose());
  const creator = { createdActor: { type: "human", source: "profile", id: OWNER } };

  // As the iOS app creates them (observed live): parent link, operator-created, depth 0.
  await h.completeRun({ sessionKey: "agent:main:dashboard:thread-1", entry: { ...creator, parentSessionKey: "agent:main:main", createdVia: "operator", spawnDepth: 0 } });
  assert.equal(h.transport.pushes.length, 1);

  await h.completeRun({ sessionKey: "agent:main:dashboard:spawned", entry: { ...creator, parentSessionKey: "agent:main:main", createdVia: "spawn" } });
  await h.completeRun({ sessionKey: "agent:main:dashboard:deep", entry: { ...creator, parentSessionKey: "agent:main:main", spawnDepth: 1 } });
  await h.completeRun({ sessionKey: "agent:main:dashboard:spawnedBy", entry: { ...creator, spawnedBy: "agent:main:main" } });
  assert.equal(h.transport.pushes.length, 1);
  assert.deepEqual(h.codes(), ["submitted-accepted", "child-run", "child-run", "child-run"]);
});
