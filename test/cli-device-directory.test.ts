// Paired-device directory over the authenticated CLI: `openclaw gateway call node.list`.
// node.list carries no per-device owner, so the directory is valid only for a Gateway whose
// administrator declared one owner for every paired device; any other owner sees no devices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCliDeviceDirectory } from "../src/host/cli-device-directory.ts";

const STUB = fileURLToPath(new URL("./fixtures/stub-openclaw-cli.mjs", import.meta.url));
const IDENTITY = "/private/reply-alerts/cli-identity";
const OWNER = "profile:alice";

const NODES = {
  ts: 1,
  nodes: [
    { nodeId: "node:iphone", platform: "iOS 26.2", deviceFamily: "iPhone", paired: true, approvedAtMs: 1700000000000, connected: false },
    { nodeId: "node:ipad", platform: "iPadOS 26.2", deviceFamily: "iPad", paired: true, approvedAtMs: 1700000005000, connected: true },
    { nodeId: "node:pending", platform: "iOS 26.2", deviceFamily: "iPhone", paired: false, connected: true },
    { nodeId: "node:mac", platform: "macOS 26.2", deviceFamily: "Mac", paired: true, approvedAtMs: 1700000009000 },
    { nodeId: "node:no-approval", platform: "iOS 26.2", deviceFamily: "iPhone", paired: true },
    // The iOS share extension pairs as its own iPhone-family node, with no commands and no push registration.
    { nodeId: "node:share", displayName: "OpenClaw Share", platform: "iOS 26.2", deviceFamily: "iPhone", paired: true, approvedAtMs: 1700000006000, commands: [], permissions: null },
  ],
};

async function setup(t: { after(fn: () => unknown): void }, nodes: unknown | null = NODES) {
  const home = await mkdtemp(join(tmpdir(), "cli-dir-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  if (nodes !== null) await writeFile(join(home, "nodes.json"), typeof nodes === "string" ? nodes : JSON.stringify(nodes));
  const directory = createCliDeviceDirectory({ cliPath: STUB, url: "ws://127.0.0.1:18789", identityDir: IDENTITY, ownerId: OWNER, baseEnv: { HOME: home } });
  const record = async () => JSON.parse(await readFile(join(home, "record.json"), "utf8"));
  return { directory, record };
}

test("lists the declared owner's paired nodes with platform, family and pairing incarnation", async (t) => {
  const { directory } = await setup(t);

  assert.deepEqual(await directory.listForOwner(OWNER), [
    { deviceId: "node:iphone", ownerId: OWNER, platform: "iOS 26.2", deviceFamily: "iPhone", paired: true, incarnation: "approved:1700000000000" },
    { deviceId: "node:ipad", ownerId: OWNER, platform: "iPadOS 26.2", deviceFamily: "iPad", paired: true, incarnation: "approved:1700000005000" },
    { deviceId: "node:mac", ownerId: OWNER, platform: "macOS 26.2", deviceFamily: "Mac", paired: true, incarnation: "approved:1700000009000" },
  ]);
});

test("unpaired nodes and nodes without an approval time are left out (fail closed)", async (t) => {
  const { directory } = await setup(t);

  assert.equal(await directory.get("node:pending"), undefined);
  assert.equal(await directory.get("node:no-approval"), undefined);
});

test("a node that advertises no commands (the iOS share extension) is not a device", async (t) => {
  const { directory } = await setup(t);

  assert.equal(await directory.get("node:share"), undefined);
  assert.ok(!(await directory.listForOwner(OWNER)).some((d) => d.deviceId === "node:share"));
});

test("any other profile owns no devices", async (t) => {
  const { directory } = await setup(t);

  assert.deepEqual(await directory.listForOwner("profile:bob"), []);
});

test("looks up one device by node id", async (t) => {
  const { directory } = await setup(t);

  assert.deepEqual(await directory.get("node:ipad"), { deviceId: "node:ipad", ownerId: OWNER, platform: "iPadOS 26.2", deviceFamily: "iPad", paired: true, incarnation: "approved:1700000005000" });
  assert.equal(await directory.get("node:unknown"), undefined);
});

test("calls node.list as the dedicated paired identity, without any shared token", async (t) => {
  const { directory, record } = await setup(t);

  await directory.listForOwner(OWNER);

  const { argv, env } = await record();
  assert.deepEqual(argv.slice(0, 3), ["gateway", "call", "node.list"]);
  assert.equal(env.stateDir, IDENTITY);
  assert.equal(env.token, undefined);
});

test("a failed or malformed listing is an error, never an empty directory", async (t) => {
  const missing = await setup(t, null);
  await assert.rejects(missing.directory.listForOwner(OWNER), /device-directory-unavailable/);
  const garbled = await setup(t, "not json");
  await assert.rejects(garbled.directory.get("node:ipad"), /device-directory-unavailable/);
  const wrongShape = await setup(t, { nodes: "nope" });
  await assert.rejects(wrongShape.directory.listForOwner(OWNER), /device-directory-unavailable/);
});

test("construction requires a declared owner and a safe Gateway URL", () => {
  assert.throws(() => createCliDeviceDirectory({ cliPath: STUB, url: "ws://127.0.0.1:18789", identityDir: IDENTITY, ownerId: "" }), /owner/);
  assert.throws(() => createCliDeviceDirectory({ cliPath: STUB, url: "ws://gateway.example:18789", identityDir: IDENTITY, ownerId: OWNER }), /url/);
});
