// Device opt-in. From the web Dashboard the owner lists their own iPhones and iPads and switches
// one by id. From the device's own Gateway connection no id is needed, and it switches only itself.
// Either way a device that is not the caller's reads as not found.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDevices, GENERIC, OWNER, PHONE, startHarness } from "./support/harness.ts";

const IPAD = "node:alice-ipad";
const OTHER_OWNER = "profile:bob";

function devicesWithIpad() {
  const devices = new FakeDevices();
  devices.devices.push({ deviceId: IPAD, ownerId: OWNER, platform: "iPadOS 26.2", deviceFamily: "iPad", paired: true, incarnation: "ipad-1" });
  return devices;
}

test("an iPad opts itself in from its own connection and then receives alerts", async (t) => {
  const h = await startHarness({ devices: devicesWithIpad() });
  t.after(() => h.dispose());

  assert.deepEqual(await h.optInFromDevice(IPAD), { ok: true, enabled: true });
  await h.completeRun();

  assert.deepEqual(h.transport.pushes, [{ deviceId: IPAD, ...GENERIC }]);
});

test("a device's toggle state reads back for that device only", async (t) => {
  const h = await startHarness({ devices: devicesWithIpad() });
  t.after(() => h.dispose());

  assert.deepEqual(await h.statusFromDevice(IPAD), { ok: true, eligible: true, enabled: false });
  await h.optInFromDevice(IPAD);
  assert.deepEqual(await h.statusFromDevice(IPAD), { ok: true, eligible: true, enabled: true });
  assert.deepEqual(await h.statusFromDevice(PHONE), { ok: true, eligible: true, enabled: false });
  await h.optInFromDevice(IPAD, false);
  assert.deepEqual(await h.statusFromDevice(IPAD), { ok: true, eligible: true, enabled: false });
});

test("a non-push device reads as ineligible instead of failing, so a toggle can hide itself", async (t) => {
  const devices = new FakeDevices();
  devices.devices.push({ deviceId: "node:alice-mac", ownerId: OWNER, platform: "macOS 26.2", deviceFamily: "Mac", paired: true, incarnation: "m-1" });
  const h = await startHarness({ devices });
  t.after(() => h.dispose());

  assert.deepEqual(await h.statusFromDevice("node:alice-mac"), { ok: true, eligible: false, enabled: false });
  assert.deepEqual(await h.optInFromDevice("node:alice-mac"), { ok: false, error: "device-not-eligible" });
});

test("a connection without a device identity must name the device explicitly", async (t) => {
  const h = await startHarness({ devices: devicesWithIpad() });
  t.after(() => h.dispose());

  const response = await h.host.call("replyAlerts.device.set", { enabled: true }, { profileId: OWNER });

  assert.deepEqual(response, { ok: false, payload: undefined, error: { code: "INVALID_REQUEST", message: "device-required", details: { reason: "device-required" } } });
});

test("another account's connection cannot read or switch the device", async (t) => {
  const h = await startHarness({ devices: devicesWithIpad() });
  t.after(() => h.dispose());

  assert.deepEqual(await h.optInFromDevice(IPAD, true, OTHER_OWNER), { ok: false, error: "device-not-found" });
  assert.deepEqual(await h.statusFromDevice(IPAD, OTHER_OWNER), { ok: false, error: "device-not-found" });
  await h.completeRun();
  assert.deepEqual(h.transport.pushes, []);
});

test("refusals use the Gateway's error codes with the reason in details", async (t) => {
  const devices = devicesWithIpad();
  const h = await startHarness({ devices });
  t.after(() => h.dispose());

  assert.deepEqual(await h.host.call("replyAlerts.device.set", { enabled: true }, { deviceId: IPAD }),
    { ok: false, payload: undefined, error: { code: "FORBIDDEN", message: "unauthenticated", details: { reason: "unauthenticated" } } });
  devices.failing = true;
  assert.deepEqual(await h.host.call("replyAlerts.device.get", {}, { profileId: OWNER, deviceId: IPAD }),
    { ok: false, payload: undefined, error: { code: "UNAVAILABLE", message: "devices-unavailable", details: { reason: "devices-unavailable" } } });
});

test("from the web Dashboard, the owner lists their iPhone and iPad and switches one by id", async (t) => {
  const devices = devicesWithIpad();
  devices.devices[1]!.displayName = "Alice's iPad";
  devices.devices.push({ deviceId: "node:alice-mac", ownerId: OWNER, platform: "macOS 26.2", deviceFamily: "Mac", paired: true, incarnation: "mac-1" });
  const h = await startHarness({ devices });
  t.after(() => h.dispose());
  const fromBrowser = { profileId: OWNER, deviceId: "browser:desktop" };

  assert.deepEqual(flattenList(await h.host.call("replyAlerts.devices.list", {}, fromBrowser)), {
    ok: true,
    devices: [
      { deviceId: PHONE, enabled: false, current: false },
      { deviceId: IPAD, displayName: "Alice's iPad", deviceFamily: "iPad", enabled: false, current: false },
    ],
  });
  assert.deepEqual(flattenList(await h.host.call("replyAlerts.device.set", { deviceId: IPAD, enabled: true }, fromBrowser)), { ok: true, enabled: true });
  assert.deepEqual(
    (flattenList(await h.host.call("replyAlerts.devices.list", {}, { profileId: OWNER, deviceId: IPAD })) as unknown as { devices: { deviceId: string; enabled: boolean; current: boolean }[] }).devices.map((d) => [d.deviceId, d.enabled, d.current]),
    [[PHONE, false, false], [IPAD, true, true]],
  );
});

test("another account lists none of my devices, and an anonymous caller is refused", async (t) => {
  const h = await startHarness({ devices: devicesWithIpad() });
  t.after(() => h.dispose());

  assert.deepEqual(flattenList(await h.host.call("replyAlerts.devices.list", {}, { profileId: OTHER_OWNER })), { ok: true, devices: [] });
  const anonymous = await h.host.call("replyAlerts.devices.list", {}, {});
  assert.equal(anonymous.ok, false);
  assert.equal(anonymous.error?.code, "FORBIDDEN");
});

function flattenList(response: { ok: boolean; payload?: unknown; error?: { details?: Record<string, unknown> } }) {
  return response.ok ? { ok: true, ...(response.payload as Record<string, unknown>) } : { ok: false, error: response.error?.details?.reason };
}
