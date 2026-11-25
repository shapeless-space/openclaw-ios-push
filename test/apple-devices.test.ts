// Native push targets: iPhone and iPad nodes, recognised the way the host itself classifies the
// iOS app (platform label "iOS x.y" / "iPadOS x.y", device family iPhone / iPad / iOS).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDevices, GENERIC, OWNER, PHONE, startHarness } from "./support/harness.ts";

const IPAD = "node:alice-ipad";

function withDevices(...extra: { deviceId: string; platform: string; deviceFamily?: string }[]) {
  const devices = new FakeDevices();
  for (const d of extra) devices.devices.push({ ownerId: OWNER, paired: true, incarnation: `${d.deviceId}-1`, ...d });
  return devices;
}

test("an opted-in iPad receives the generic native alert", async (t) => {
  const devices = withDevices({ deviceId: IPAD, platform: "iPadOS 26.2", deviceFamily: "iPad" });
  const h = await startHarness({ devices });
  t.after(() => h.dispose());
  assert.deepEqual(await h.optIn(IPAD), { ok: true, enabled: true });

  await h.completeRun();

  assert.deepEqual(h.transport.pushes, [{ deviceId: IPAD, ...GENERIC }]);
});

test("an iPhone reporting its native platform label is eligible", async (t) => {
  const devices = new FakeDevices();
  devices.devices = [{ deviceId: PHONE, ownerId: OWNER, platform: "iOS 18.4.0", deviceFamily: "iPhone", paired: true, incarnation: "pair-1" }];
  const h = await startHarness({ devices });
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun();

  assert.deepEqual(h.transport.pushes, [{ deviceId: PHONE, ...GENERIC }]);
});

test("an iOS node with a blank device family is eligible, as the host allows", async (t) => {
  const devices = new FakeDevices();
  devices.devices = [{ deviceId: PHONE, ownerId: OWNER, platform: "iOS 26.2", deviceFamily: "", paired: true, incarnation: "pair-1" }];
  const h = await startHarness({ devices });
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun();

  assert.deepEqual(h.transport.pushes, [{ deviceId: PHONE, ...GENERIC }]);
});

test("an iPhone and an iPad that both opted in each get exactly one alert", async (t) => {
  const devices = withDevices({ deviceId: IPAD, platform: "iPadOS 26.2", deviceFamily: "iPad" });
  const h = await startHarness({ devices });
  t.after(() => h.dispose());
  await h.optIn(PHONE);
  await h.optIn(IPAD);

  const runId = await h.completeRun({ runId: "run-both" });
  await h.completeRun({ runId });

  assert.deepEqual(h.transport.pushes.map((p) => p.deviceId).sort(), [IPAD, PHONE].sort());
});

test("an iPad that did not opt in stays silent while the iPhone is alerted", async (t) => {
  const devices = withDevices({ deviceId: IPAD, platform: "iPadOS 26.2", deviceFamily: "iPad" });
  const h = await startHarness({ devices });
  t.after(() => h.dispose());
  await h.optIn(PHONE);

  await h.completeRun();

  assert.deepEqual(h.transport.pushes.map((p) => p.deviceId), [PHONE]);
});

for (const [label, platform, deviceFamily] of [
  ["Apple Watch", "watchOS 26.0", "Apple Watch"],
  ["Mac", "macOS 26.2", "Mac"],
  ["Android phone", "Android 16 (SDK 36)", "Android"],
  ["iPadOS label on a non-iOS family", "iPadOS 26.2", "Mac"],
  ["look-alike platform prefix", "iosx 1.0", "iPhone"],
  ["blank platform", "", "iPad"],
] as const) {
  test(`a ${label} node is not a native push target`, async (t) => {
    const devices = withDevices({ deviceId: "node:other", platform, deviceFamily });
    const h = await startHarness({ devices });
    t.after(() => h.dispose());

    assert.deepEqual(await h.optIn("node:other"), { ok: false, error: "device-not-eligible" });
    await h.optIn(PHONE);
    await h.completeRun();

    assert.deepEqual(h.transport.pushes.map((p) => p.deviceId), [PHONE]);
  });
}
