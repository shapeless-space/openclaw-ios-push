import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeDevices, FakeViewing, GENERIC, OWNER, PHONE, startHarness } from "./support/harness.ts";

const SECOND = "node:alice-ipad-mini";
const OTHER_OWNER = "profile:bob";

function twoPhones() {
  const devices = new FakeDevices();
  devices.devices.push({ deviceId: SECOND, ownerId: OWNER, platform: "ios", paired: true, incarnation: "pair-9" });
  return devices;
}

test("a device that never opted in gets nothing", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());

  await h.completeRun();

  assert.equal(h.transport.pushes.length, 0);
  assert.deepEqual(h.codes(), ["not-opted-in"]);
});

test("opting out stops later alerts", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn(PHONE, true);
  assert.deepEqual(await h.optIn(PHONE, false), { ok: true, enabled: false });

  await h.completeRun();

  assert.equal(h.transport.pushes.length, 0);
});

test("consent survives a restart", async (t) => {
  const first = await startHarness();
  await first.optIn();
  const second = await first.restart();
  t.after(() => second.dispose());

  await second.completeRun();

  assert.equal(second.transport.pushes.length, 1);
});

test("opting in one phone does not enroll the owner's other phone", async (t) => {
  const h = await startHarness({ devices: twoPhones() });
  t.after(() => h.dispose());
  await h.optIn(PHONE);

  await h.completeRun();

  assert.deepEqual(h.transport.pushes.map((p) => p.deviceId), [PHONE]);
});

test("another account cannot change consent for my phone", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());

  assert.deepEqual(await h.optIn(PHONE, true, OTHER_OWNER), { ok: false, error: "device-not-found" });
  assert.deepEqual(await h.optIn(PHONE, true, null), { ok: false, error: "unauthenticated" });
  await h.completeRun();

  assert.equal(h.transport.pushes.length, 0);
});

test("another account's conversation never reaches my phone", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun({ ownerId: OTHER_OWNER, sessionKey: "agent:main:webchat:bob-chat" });

  assert.equal(h.transport.pushes.length, 0);
  // Visible in the log, so a wrongly configured owner is diagnosable.
  assert.deepEqual(h.codes(), ["owner-has-no-devices"]);
});

test("a re-paired phone starts opted out", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();
  h.devices.devices[0]!.incarnation = "pair-2";

  await h.completeRun();

  assert.equal(h.transport.pushes.length, 0);
  assert.deepEqual(h.codes(), ["not-opted-in"]);
});

test("unpaired and non-iPhone devices can neither opt in nor receive alerts", async (t) => {
  const devices = new FakeDevices();
  devices.devices.push({ deviceId: "node:alice-mac", ownerId: OWNER, platform: "macos", paired: true, incarnation: "m-1" });
  const h = await startHarness({ devices });
  t.after(() => h.dispose());

  assert.deepEqual(await h.optIn("node:alice-mac"), { ok: false, error: "device-not-eligible" });
  await h.optIn(PHONE);
  devices.devices[0]!.paired = false;
  assert.deepEqual(await h.optIn(PHONE), { ok: false, error: "device-not-eligible" });
  await h.completeRun();

  assert.equal(h.transport.pushes.length, 0);
});

test("malformed consent state is treated as off", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();
  await writeFile(join(h.stateDir, "consent.json"), "{not json");

  await h.completeRun();

  assert.equal(h.transport.pushes.length, 0);
  assert.deepEqual(h.codes(), ["consent-unavailable"]);
});

test("revoking consent while a candidate is in flight prevents the submission", async (t) => {
  const viewing = new FakeViewing();
  const h = await startHarness({ viewing });
  t.after(() => h.dispose());
  await h.optIn();
  viewing.onLookup = async () => { await h.optIn(PHONE, false); };

  await h.completeRun();

  assert.equal(h.transport.pushes.length, 0);
  assert.deepEqual(h.codes(), ["revoked-before-dispatch"]);
});

test("unpairing while a candidate is in flight prevents the submission", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();
  h.devices.afterList = async () => { h.devices.devices[0]!.paired = false; };

  await h.completeRun();

  assert.equal(h.transport.pushes.length, 0);
  assert.deepEqual(h.codes(), ["revoked-before-dispatch"]);
});

test("opting in does not replay replies that finished earlier", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  const before = h.clock.now();
  h.clock.advance(1_000);
  await h.optIn();

  await h.completeRun({ endedAt: before });

  assert.equal(h.transport.pushes.length, 0);
  assert.deepEqual(h.codes(), ["historical"]);
});

test("each opted-in phone is evaluated independently; one failure does not block another", async (t) => {
  const devices = twoPhones();
  devices.devices.push({ deviceId: "node:alice-old-phone", ownerId: OWNER, platform: "ios", paired: true, incarnation: "old" });
  const h = await startHarness({ devices });
  t.after(() => h.dispose());
  await h.optIn(PHONE);
  await h.optIn(SECOND);
  h.transport.respond = async (r) => (r.deviceId === PHONE ? { status: "rejected", code: "no-registration" } : { status: "accepted" });

  await h.completeRun();

  assert.deepEqual(h.transport.pushes, [{ deviceId: PHONE, ...GENERIC }, { deviceId: SECOND, ...GENERIC }]);
  assert.deepEqual(h.codes(), ["submitted-rejected", "submitted-accepted", "not-opted-in"]);
});

test("a device directory failure means no submission", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();
  h.devices.failing = true;

  await h.completeRun();

  assert.equal(h.transport.pushes.length, 0);
  assert.deepEqual(h.codes(), ["devices-unavailable"]);
});
