import { test } from "node:test";
import assert from "node:assert/strict";
import { GENERIC, OWNER, PHONE, startHarness } from "./support/harness.ts";

test("child-run completion alone never alerts", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun({ sessionKey: "agent:main:subagent:helper", entry: { owner: { actor: { type: "human", id: OWNER } }, spawnedBy: "agent:main:webchat:conversation-1" } });

  assert.equal(h.transport.pushes.length, 0);
  assert.deepEqual(h.codes(), ["child-run"]);
});

test("a yielded parent does not alert; its resumed final reply alerts exactly once", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun({ runId: "parent-1", wait: { yielded: true, terminalReply: { disposition: "empty" } } });
  await h.completeRun({ sessionKey: "agent:main:subagent:helper", entry: { owner: { actor: { type: "human", id: OWNER } }, parentSessionKey: "agent:main:webchat:conversation-1" } });
  assert.equal(h.transport.pushes.length, 0);

  await h.completeRun({ runId: "parent-1-resumed" });

  assert.deepEqual(h.transport.pushes, [{ deviceId: PHONE, ...GENERIC }]);
  assert.deepEqual(h.codes(), ["run-yielded", "child-run", "submitted-accepted"]);
});

test("a yielded run is never treated as final even if it reports visible text", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun({ wait: { yielded: true } });

  assert.equal(h.transport.pushes.length, 0);
  assert.deepEqual(h.codes(), ["run-yielded"]);
});

test("an authoritatively delivered source reply still alerts when a later silent marker ends the run", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun({ wait: { terminalReply: { disposition: "silent" }, sourceReplyDelivered: true } });

  assert.deepEqual(h.transport.pushes, [{ deviceId: PHONE, ...GENERIC }]);
});

test("source delivery never overrides failure or cancellation", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun({ wait: { status: "error", sourceReplyDelivered: true } });
  await h.completeRun({ wait: { stopReason: "cancelled", sourceReplyDelivered: true } });

  assert.equal(h.transport.pushes.length, 0);
  assert.deepEqual(h.codes(), ["run-unsuccessful", "run-unsuccessful"]);
});
