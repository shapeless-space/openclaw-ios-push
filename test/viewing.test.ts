import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDevices, FakeViewing, OWNER, PHONE, startHarness } from "./support/harness.ts";
import type { ViewingPresence } from "../src/reply-alerts.ts";

const SECOND = "node:alice-second-iphone";
const DESTINATION = "agent:main:webchat:conversation-1";

async function setup() {
  const devices = new FakeDevices();
  devices.devices.push({ deviceId: SECOND, ownerId: OWNER, platform: "ios", paired: true, incarnation: "p2" });
  const viewing = new FakeViewing();
  const h = await startHarness({ devices, viewing });
  await h.optIn(PHONE);
  await h.optIn(SECOND);
  const fresh = (overrides: Partial<ViewingPresence> = {}): ViewingPresence =>
    ({ sessionKey: DESTINATION, foreground: true, authenticated: true, observedAt: h.clock.now(), ...overrides });
  return { h, viewing, fresh };
}

test("a phone visibly reading the destination is suppressed; the other phone is notified", async (t) => {
  const { h, viewing, fresh } = await setup();
  t.after(() => h.dispose());
  viewing.views.set(PHONE, fresh());

  await h.completeRun({ sessionKey: DESTINATION });

  assert.deepEqual(h.transport.pushes.map((p) => p.deviceId), [SECOND]);
  assert.deepEqual(h.codes(), ["suppressed-active-view", "submitted-accepted"]);
});

test("a suppression is final for that run and device, even after leaving the conversation", async (t) => {
  const { h, viewing, fresh } = await setup();
  t.after(() => h.dispose());
  viewing.views.set(PHONE, fresh());
  await h.completeRun({ runId: "run-a", sessionKey: DESTINATION });
  viewing.views.delete(PHONE);

  await h.completeRun({ runId: "run-a", sessionKey: DESTINATION });

  assert.deepEqual(h.transport.pushes.map((p) => p.deviceId), [SECOND]);
});

const uncertain: [string, (fresh: (o?: Partial<ViewingPresence>) => ViewingPresence) => ViewingPresence | undefined][] = [
  ["viewing a different conversation", (f) => f({ sessionKey: "agent:main:webchat:other" })],
  ["app open but backgrounded", (f) => f({ foreground: false })],
  ["stale presence", (f) => f({ observedAt: 0 })],
  ["presence not authenticated to this device", (f) => f({ authenticated: false })],
  ["no presence at all", () => undefined],
];

for (const [name, view] of uncertain) {
  test(`unknown or non-destination viewing sends: ${name}`, async (t) => {
    const { h, viewing, fresh } = await setup();
    t.after(() => h.dispose());
    const presence = view(fresh);
    if (presence) viewing.views.set(PHONE, presence);

    await h.completeRun({ sessionKey: DESTINATION });

    assert.deepEqual(h.transport.pushes.map((p) => p.deviceId), [PHONE, SECOND]);
  });
}

test("a failing presence lookup counts as unknown and sends", async (t) => {
  const { h, viewing } = await setup();
  t.after(() => h.dispose());
  viewing.failing = true;

  await h.completeRun({ sessionKey: DESTINATION });

  assert.equal(h.transport.pushes.length, 2);
});

test("viewing evidence never turns an ineligible run into an alert", async (t) => {
  const { h, viewing, fresh } = await setup();
  t.after(() => h.dispose());
  viewing.views.set(PHONE, fresh());

  await h.completeRun({ sessionKey: DESTINATION, channel: "telegram" });

  assert.equal(h.transport.pushes.length, 0);
});
