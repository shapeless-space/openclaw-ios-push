import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDevices, FakeHost, FakeTransport, OWNER, PHONE, startHarness } from "./support/harness.ts";
import entry, { createReplyAlertsPlugin } from "../src/plugin.ts";

test("host lookup failures never throw into the reply lifecycle and never submit", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "reply-alerts-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const transport = new FakeTransport();
  const codes: string[] = [];
  const host = new FakeHost({ stateDir });
  const api = host.api();
  api.runtime.agent.session.getSessionEntryAsync = async () => { throw new Error("gateway busy"); };
  createReplyAlertsPlugin({ transport, devices: new FakeDevices(), diagnostics: (e) => codes.push(e.code) }).register(api);
  await host.call("replyAlerts.device.set", { deviceId: PHONE, enabled: true }, { profileId: OWNER });

  await assert.doesNotReject(host.fireHook("agent_end", { runId: "r1" }, { runId: "r1", sessionKey: "agent:main:webchat:c", channel: "webchat", trigger: "user" }));
  await assert.doesNotReject(host.emit({ runId: "r1", sessionKey: "agent:main:webchat:c", stream: "lifecycle", ts: 1, data: { phase: "end" } }));

  assert.equal(transport.pushes.length, 0);
  assert.deepEqual(codes, ["evidence-fetch-failed:entry"]);
});

test("streaming, progress and tool events are not observed as completions", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();

  await h.host.emit({ runId: "r1", sessionKey: "agent:main:webchat:c", stream: "assistant", ts: 1, data: { delta: "partial" } });
  await h.host.emit({ runId: "r1", sessionKey: "agent:main:webchat:c", stream: "lifecycle", ts: 1, data: { phase: "start" } });
  await h.host.emit({ runId: "r1", sessionKey: "agent:main:webchat:c", stream: "tool", ts: 1, data: { phase: "end" } });

  assert.deepEqual(h.host.waitCalls, []);
  assert.equal(h.transport.pushes.length, 0);
});

test("registration fails loudly when a required host capability is missing", () => {
  const plugin = createReplyAlertsPlugin({ transport: new FakeTransport(), devices: new FakeDevices() });
  const api = new FakeHost({ stateDir: "/tmp/unused" }).api() as Record<string, unknown>;
  delete api.agent;

  assert.throws(() => plugin.register(api as never), /host-capability-missing: agent\.events\.registerAgentEventSubscription/);
});

test("registration requires an explicit state directory", () => {
  const plugin = createReplyAlertsPlugin({ transport: new FakeTransport(), devices: new FakeDevices() });

  assert.throws(() => plugin.register(new FakeHost({}).api()), /stateDir/);
});

test("durable state and diagnostics contain no raw identifiers or content", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();
  const runId = await h.completeRun({ runId: "run-secret-123", sessionKey: "agent:main:webchat:private-title" });

  const ledgerDir = join(h.stateDir, "ledger");
  const ledgerText = (await Promise.all((await readdir(ledgerDir)).map(async (f) => f + await readFile(join(ledgerDir, f), "utf8")))).join("\n");
  for (const secret of [runId, "private-title", PHONE]) assert.ok(!ledgerText.includes(secret), `ledger leaks ${secret}`);
  for (const event of h.diagnostics) assert.deepEqual(Object.keys(event), ["code"]);
});

test("the installable entry refuses to start unless a single device owner is declared", () => {
  const api = new FakeHost({ stateDir: "/tmp/unused", gateway: { cliPath: "/x/openclaw.mjs", url: "ws://127.0.0.1:18789", identityDir: "/private/id" } }).api();

  assert.throws(() => entry.register(api), /owner\.profileId config required/);
});

test("the installable entry registers with a declared owner and complete transport config", () => {
  const host = new FakeHost({ stateDir: "/tmp/unused", owner: { profileId: OWNER }, gateway: { cliPath: "/x/openclaw.mjs", url: "ws://127.0.0.1:18789", identityDir: "/private/id" } });

  entry.register(host.api());

  assert.deepEqual([...host.methods.keys()].sort(), ["replyAlerts.device.get", "replyAlerts.device.set", "replyAlerts.devices.list"]);
  assert.equal(host.subscriptions.length, 1);
});

test("the installable entry rejects incomplete transport configuration", () => {
  const api = new FakeHost({ stateDir: "/tmp/unused", owner: { profileId: OWNER } }).api();

  assert.throws(() => entry.register(api), /gateway\.(cliPath|url|identityDir)/);
});

test("the manifest declares the owner and the paired identity, and holds no Gateway secret", async () => {
  const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));

  assert.deepEqual(manifest.configSchema.required.sort(), ["gateway", "owner", "stateDir"]);
  assert.deepEqual(manifest.configSchema.properties.owner.required, ["profileId"]);
  const gateway = manifest.configSchema.properties.gateway;
  assert.deepEqual(gateway.required.sort(), ["cliPath", "identityDir", "url"]);
  assert.equal(gateway.properties.token, undefined);
  assert.equal(manifest.uiHints["gateway.token"], undefined);
});

test("diagnostic codes reach the host log as bare codes, so a missed alert can be explained", async () => {
  const host = new FakeHost({ stateDir: await mkdtemp(join(tmpdir(), "reply-alerts-log-")) });
  const plugin = createReplyAlertsPlugin({
    transport: { push: async () => ({ status: "accepted" }) },
    devices: { listForOwner: async () => [], get: async () => undefined },
  });
  plugin.register(host.api());

  await host.emit({ runId: "run:private-id", stream: "lifecycle", ts: 1, data: { phase: "end" } });

  assert.deepEqual(host.logs, ["ios-reply-alerts: evidence-missing-run-ids"]);
});

function shapeHost(config: Record<string, unknown>) {
  const host = new FakeHost(config);
  createReplyAlertsPlugin({
    transport: { push: async () => ({ status: "accepted" }) },
    devices: { listForOwner: async () => [], get: async () => undefined },
  }).register(host.api());
  return host;
}

test("with logEvidenceShape on, a settled run logs origin, field names and status values, never content or ids", async () => {
  const host = shapeHost({ stateDir: await mkdtemp(join(tmpdir(), "reply-alerts-shape-")), logEvidenceShape: true });
  host.entries.set("agent:main:main", { createdActor: { type: "human", id: "private-profile" }, label: "Private label" });

  await host.fireHook("agent_end", { runId: "run:1", messages: [{ content: "private message" }] }, {
    runId: "run:1", sessionKey: "agent:main:main", channel: "webchat", trigger: "user",
    inputProvenance: { kind: "external_user", sourceSessionKey: "agent:other" }, senderId: "private-sender",
  });
  await host.emit({ runId: "run:1", sessionKey: "agent:main:main", stream: "lifecycle", ts: 1, data: {
    phase: "end", endedAt: 5, aborted: false, stopReason: "stop", livenessState: "Private words here",
    terminalReply: { disposition: "visible", text: "private reply" }, terminalReceipt: { id: "receipt-123" },
  } });

  assert.deepEqual(host.logs.slice(0, 3), [
    "ios-reply-alerts: origin channel=webchat trigger=user inputProvenance=external_user sender=present",
    "ios-reply-alerts: shape top=data,runId,sessionKey,stream,ts event=aborted,endedAt,livenessState,phase,stopReason,terminalReceipt,terminalReply entry=createdActor,label",
    "ios-reply-alerts: facts aborted=false stopReason=stop terminalReply.disposition=visible terminalReply=disposition,text terminalReceipt=id",
  ]);
  const all = host.logs.join("\n");
  for (const secret of ["private", "Private", "receipt-123", "run:1", "agent:main:main", "agent:other"]) assert.ok(!all.includes(secret), `log leaks ${secret}`);
});

test("without logEvidenceShape, only bare diagnostic codes are logged", async () => {
  const host = shapeHost({ stateDir: await mkdtemp(join(tmpdir(), "reply-alerts-noshape-")) });
  host.entries.set("agent:main:main", {});

  await host.fireHook("agent_end", { runId: "run:1" }, { runId: "run:1", sessionKey: "agent:main:main", channel: "webchat", trigger: "user" });
  await host.emit({ runId: "run:1", sessionKey: "agent:main:main", stream: "lifecycle", ts: 1, data: { phase: "end", endedAt: 5, aborted: false, executionSettled: true, stopReason: "stop", terminalReply: { disposition: "visible" } } });

  assert.deepEqual(host.logs, ["ios-reply-alerts: owner-unverified"]);
});

test("with logEvidenceShape on, an event without run ids still logs its top-level field names", async () => {
  const host = shapeHost({ stateDir: await mkdtemp(join(tmpdir(), "reply-alerts-shape-ids-")), logEvidenceShape: true });

  await host.emit({ runId: "run:1", stream: "lifecycle", ts: 1, data: { phase: "end" } });

  assert.deepEqual(host.logs, ["ios-reply-alerts: shape top=data,runId,stream,ts event=phase", "ios-reply-alerts: evidence-missing-run-ids"]);
});
