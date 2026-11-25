import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCliPushTransport } from "../src/host/cli-push-transport.ts";

const STUB = fileURLToPath(new URL("./fixtures/stub-openclaw-cli.mjs", import.meta.url));
// The paired CLI identity the plugin runs as. Synthetic: the stub never reads it.
const IDENTITY = "/private/reply-alerts/cli-identity";

async function setup(t: { after(fn: () => unknown): void }, timeoutMs = 5_000) {
  const home = await mkdtemp(join(tmpdir(), "cli-push-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const transport = createCliPushTransport({ cliPath: STUB, url: "ws://127.0.0.1:18789", identityDir: IDENTITY, timeoutMs, baseEnv: { HOME: home } });
  const record = async () => JSON.parse(await readFile(join(home, "record.json"), "utf8"));
  return { transport, record };
}

test("an accepted push.test call reports accepted and sends only the generic payload", async (t) => {
  const { transport, record } = await setup(t);

  const result = await transport.push({ deviceId: "stub:accept", title: "OpenClaw", body: "Your reply is ready." });

  assert.deepEqual(result, { status: "accepted" });
  const { argv } = await record();
  assert.deepEqual(argv.slice(0, 3), ["gateway", "call", "push.test"]);
  assert.deepEqual(JSON.parse(argv[argv.indexOf("--params") + 1]), { nodeId: "stub:accept", title: "OpenClaw", body: "Your reply is ready." });
});

test("the CLI runs as the dedicated paired identity: no shared token anywhere, Gateway pinned, no other env leaks", async (t) => {
  const { transport, record } = await setup(t);

  await transport.push({ deviceId: "stub:accept", title: "OpenClaw", body: "Your reply is ready." });

  const { argv, env } = await record();
  assert.equal(env.stateDir, IDENTITY);
  assert.equal(env.port, "18789");
  // A URL override would force explicit shared credentials; the identity's stored device token is used instead.
  assert.equal(env.url, undefined);
  assert.equal(env.token, undefined);
  assert.equal(argv[argv.indexOf("--expect-url") + 1], "ws://127.0.0.1:18789");
  assert.ok(!argv.includes("--token") && !argv.includes("--url"));
  assert.deepEqual(env.keys.filter((k: string) => !["HOME", "PATH", "OPENCLAW_STATE_DIR", "OPENCLAW_GATEWAY_PORT", "__CF_USER_TEXT_ENCODING"].includes(k)), []);
});

test("an APNs 4xx refusal inside a successful RPC is a definite rejection, without token details", async (t) => {
  const { transport } = await setup(t);

  assert.deepEqual(await transport.push({ deviceId: "stub:apns-bad-token", title: "OpenClaw", body: "Your reply is ready." }),
    { status: "rejected", code: "apns-400" });
});

test("an APNs or relay 5xx inside a successful RPC is ambiguous, not accepted", async (t) => {
  const { transport } = await setup(t);

  await assert.rejects(transport.push({ deviceId: "stub:apns-unavailable", title: "OpenClaw", body: "Your reply is ready." }), /push-outcome-unknown/);
});

test("unparseable success output is ambiguous, not accepted", async (t) => {
  const { transport } = await setup(t);

  await assert.rejects(transport.push({ deviceId: "stub:garbled", title: "OpenClaw", body: "Your reply is ready." }), /push-outcome-unknown/);
});

test("a missing APNs registration is a definite rejection", async (t) => {
  const { transport } = await setup(t);

  assert.deepEqual(await transport.push({ deviceId: "stub:no-registration", title: "OpenClaw", body: "Your reply is ready." }),
    { status: "rejected", code: "no-registration" });
});

test("a scope/authorization refusal is a definite rejection", async (t) => {
  const { transport } = await setup(t);

  assert.deepEqual(await transport.push({ deviceId: "stub:unauthorized", title: "OpenClaw", body: "Your reply is ready." }),
    { status: "rejected", code: "unauthorized" });
});

test("unrecognized failures are ambiguous and surface as errors, not rejections", async (t) => {
  const { transport } = await setup(t);

  await assert.rejects(transport.push({ deviceId: "stub:other", title: "OpenClaw", body: "Your reply is ready." }), /push-outcome-unknown/);
});

test("a hung CLI is killed at the deadline and reported as unknown", async (t) => {
  const { transport } = await setup(t, 300);

  await assert.rejects(transport.push({ deviceId: "stub:hang", title: "OpenClaw", body: "Your reply is ready." }), /push-outcome-unknown/);
});

test("construction accepts only the local Gateway and a separate, absolute identity directory", () => {
  assert.throws(() => createCliPushTransport({ cliPath: STUB, url: "ws://gateway.example:18789", identityDir: IDENTITY }), /url/);
  assert.throws(() => createCliPushTransport({ cliPath: STUB, url: "wss://gateway.example", identityDir: IDENTITY }), /url/);
  assert.throws(() => createCliPushTransport({ cliPath: STUB, url: "ws://127.0.0.1:18789", identityDir: "" }), /identityDir/);
  assert.throws(() => createCliPushTransport({ cliPath: STUB, url: "ws://127.0.0.1:18789", identityDir: "relative/identity" }), /identityDir/);
  // The Gateway's own state directory carries the shared admin token: never run as it.
  assert.throws(() => createCliPushTransport({ cliPath: STUB, url: "ws://127.0.0.1:18789", identityDir: "/h/.openclaw/", baseEnv: { HOME: "/h" } }), /identityDir/);
});
