import { test } from "node:test";
import assert from "node:assert/strict";
import { GENERIC, PHONE, startHarness } from "./support/harness.ts";

test("a successful app/web reply notifies the opted-in iPhone once with generic text", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun();

  assert.deepEqual(h.transport.pushes, [{ deviceId: PHONE, ...GENERIC }]);
  assert.deepEqual(h.codes(), ["submitted-accepted"]);
});

const ineligible: [string, Parameters<Awaited<ReturnType<typeof startHarness>>["completeRun"]>[0], string][] = [
  ["Telegram conversation", { channel: "telegram" }, "ineligible-channel"],
  ["unknown non-app channel", { channel: "discord" }, "ineligible-channel"],
  ["missing origin channel", { channel: undefined }, "origin-unverified"],
  ["Telegram turn in a web conversation", { channel: "telegram" }, "ineligible-channel"],
  ["Telegram turn in the shared main session", { sessionKey: "agent:main:main", channel: "telegram" }, "ineligible-channel"],
  ["turn with no channel on its hook context", { channel: undefined }, "origin-unverified"],
  ["missing owner", { ownerId: undefined }, "owner-unverified"],
  ["heartbeat", { trigger: "heartbeat" }, "not-user-turn"],
  ["cron/automation", { trigger: "cron" }, "not-user-turn"],
  ["missing trigger", { trigger: undefined }, "not-user-turn"],
  ["failed run", { wait: { status: "error" } }, "run-unsuccessful"],
  ["timed-out run", { wait: { status: "timeout" } }, "run-unsuccessful"],
  ["still pending", { wait: { status: "pending" } }, "run-unsuccessful"],
  ["cancelled run with partial output", { wait: { status: "ok", stopReason: "cancelled" } }, "run-unsuccessful"],
  ["silent / NO_REPLY result", { wait: { terminalReply: { disposition: "silent" } } }, "reply-not-visible"],
  ["final envelope with no visible answer", { wait: { terminalReply: { disposition: "empty" } } }, "reply-not-visible"],
  ["no terminal reply snapshot", { wait: { terminalReply: undefined as never } }, "reply-not-visible"],
];

for (const [name, spec, code] of ineligible) {
  test(`no alert: ${name}`, async (t) => {
    const h = await startHarness();
    t.after(() => h.dispose());
    await h.optIn();

    await h.completeRun(spec);

    assert.equal(h.transport.pushes.length, 0);
    assert.deepEqual(h.codes(), [code]);
  });
}
