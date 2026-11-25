// The "Reply alerts" Control UI page in the web Dashboard: one switch per iPhone or iPad of the
// signed-in person. (The iOS app's Settings cannot show plugin pages.)
// The browser module is driven with a fake Control UI host (its `request` is the Gateway RPC
// seam) and a minimal fake DOM; it is never loaded into a real Control UI here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FakeDocument, type FakeElement } from "./support/fake-dom.ts";

const fakeDocument = new FakeDocument();
(globalThis as { document?: unknown }).document = fakeDocument;
const { default: plugin } = await import("../dist/control-ui/index.js");

type Call = { method: string; params: Record<string, unknown> | undefined };

function fakeHost(answer: (call: Call) => Promise<unknown>) {
  const calls: Call[] = [];
  const pages: { id: string; label: string; mount: Function }[] = [];
  const navigation: { id: string; label: string; page: { id: string } }[] = [];
  const host = {
    pluginId: "ios-reply-alerts",
    signal: new AbortController().signal,
    request: async (method: string, params?: Record<string, unknown>) => {
      const call = { method, params };
      calls.push(call);
      return answer(call);
    },
    ui: {
      registerPage: (page: (typeof pages)[number]) => { pages.push(page); return () => {}; },
      registerNavigation: (item: (typeof navigation)[number]) => { navigation.push(item); return () => {}; },
    },
  };
  return { host, calls, pages, navigation };
}

async function mountPage(answer: (call: Call) => Promise<unknown>) {
  const env = fakeHost(answer);
  await plugin.activate(env.host);
  const container = fakeDocument.createElement("div");
  const controller = new AbortController();
  const view = env.pages[0]!.mount(container, { host: env.host, signal: controller.signal, props: {}, presented: true });
  await settle();
  return { ...env, container, view, controller };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const toggle = (root: FakeElement) => root.find((e) => e.tagName === "input" && e.type === "checkbox");
const status = (root: FakeElement) => root.find((e) => e.dataset.role === "status")?.textContent ?? "";

test("the browser module matches the manifest and adds a Reply alerts page with navigation", async () => {
  const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const env = fakeHost(async () => ({}));

  await plugin.activate(env.host);

  assert.equal(plugin.id, manifest.id);
  assert.equal(manifest.controlUi.entry, "dist/control-ui/index.js");
  assert.deepEqual(env.pages.map((p) => [p.id, p.label]), [["reply-alerts", "Reply alerts"]]);
  assert.deepEqual(env.navigation.map((n) => [n.id, n.page.id]), [["reply-alerts", "reply-alerts"]]);
});

const IPHONE = { deviceId: "node:iphone", displayName: "iPhone", deviceFamily: "iPhone", enabled: false, current: false };
const IPAD = { deviceId: "node:ipad", displayName: "Alex's iPad", deviceFamily: "iPad", enabled: true, current: true };
const toggles = (root: FakeElement) => root.findAll((e) => e.tagName === "input" && e.type === "checkbox");
const labels = (root: FakeElement) => root.findAll((e) => e.tagName === "label").map((e) => e.textContent);

test("the page lists the owner's iPhone and iPad with their current state, marking this device", async () => {
  const page = await mountPage(async () => ({ devices: [IPHONE, IPAD] }));

  assert.deepEqual(page.calls, [{ method: "replyAlerts.devices.list", params: {} }]);
  assert.deepEqual(labels(page.container), ["iPhone", "Alex's iPad (this device)"]);
  assert.deepEqual(toggles(page.container).map((t) => [t.checked, t.disabled]), [[false, false], [true, false]]);
});

test("switching one device saves that device by id and leaves the other alone", async () => {
  const page = await mountPage(async ({ method, params }) => {
    if (method === "replyAlerts.devices.list") return { devices: [IPHONE, IPAD] };
    return { enabled: params?.enabled === true };
  });

  const [iphone] = toggles(page.container);
  iphone!.checked = true;
  iphone!.dispatch("change");
  await settle();

  assert.deepEqual(page.calls.at(-1), { method: "replyAlerts.device.set", params: { deviceId: "node:iphone", enabled: true } });
  assert.deepEqual(toggles(page.container).map((t) => [t.checked, t.disabled]), [[true, false], [true, false]]);
});

test("a failed save restores that device's previous state and says so", async () => {
  const page = await mountPage(async ({ method }) => {
    if (method === "replyAlerts.devices.list") return { devices: [IPHONE] };
    throw new Error("UNAVAILABLE");
  });

  const [iphone] = toggles(page.container);
  iphone!.checked = true;
  iphone!.dispatch("change");
  await settle();

  assert.deepEqual(toggles(page.container).map((t) => [t.checked, t.disabled]), [[false, false]]);
  assert.match(status(page.container), /couldn.t save/i);
});

test("with no iPhone or iPad of yours paired, the page explains and offers no toggle", async () => {
  const page = await mountPage(async () => ({ devices: [] }));

  assert.equal(toggle(page.container), undefined);
  assert.match(status(page.container), /iPhone or iPad/);
});

test("a failed load shows an error instead of a guessed state", async () => {
  const page = await mountPage(async () => { throw new Error("UNAVAILABLE"); });

  assert.equal(toggle(page.container), undefined);
  assert.match(status(page.container), /couldn.t load/i);
});

test("nothing renders after the view is disposed mid-request", async () => {
  let release!: (value: unknown) => void;
  const env = fakeHost(() => new Promise((resolve) => { release = resolve; }));
  await plugin.activate(env.host);
  const container = fakeDocument.createElement("div");
  const controller = new AbortController();
  const view = env.pages[0]!.mount(container, { host: env.host, signal: controller.signal, props: {}, presented: true });
  const before = container.children.length;

  view.dispose?.();
  controller.abort();
  release({ devices: [IPHONE] });
  await settle();

  assert.equal(toggle(container), undefined);
  assert.ok(container.children.length <= before);
});
