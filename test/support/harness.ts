// Fake OpenClaw host for the plugin-host seam. It implements only the plugin surfaces the plugin
// uses (typed hooks, agent event subscriptions, session entry lookup, registerService,
// registerGatewayMethod, logger) and replaces external I/O (push transport, paired-device directory,
// viewing presence, clock). Event and entry shapes match what a live OpenClaw 2026.11.6 Gateway
// (Codex runtime) reports; see the header of src/host/openclaw-adapter.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReplyAlertsPlugin } from "../../src/plugin.ts";
import type { Device, DeviceDirectory, PushRequest, PushResult, PushTransport, ViewingPresence, ViewingSource } from "../../src/reply-alerts.ts";

type Handler = (event: AgentEvent) => unknown;
export type AgentEvent = { runId: string; sessionKey?: string; stream: string; ts: number; data: Record<string, unknown> };
/** How a test describes a run's outcome; `completeRun` turns it into lifecycle end event data. */
export type WaitResult = {
  status: "ok" | "error" | "timeout" | "pending";
  endedAt?: number;
  yielded?: true;
  stopReason?: string;
  terminalReply?: { disposition: string };
  sourceReplyDelivered?: true;
};
export type SessionEntry = Record<string, unknown>;
/** Caller identity as the Gateway hands it to handlers (`client.connect.device`, `client.authenticatedUserProfile`). */
export type GatewayClient = { connect?: { device?: { id?: string } }; authenticatedUserProfile?: { profileId?: string } };
export type GatewayError = { code: string; message: string; details?: Record<string, unknown> };
export type GatewayResponse = { ok: boolean; payload?: unknown; error?: GatewayError };
type GatewayHandler = (opts: { params: unknown; client?: GatewayClient; respond: (ok: boolean, payload?: unknown, error?: GatewayError) => void }) => unknown;

export type RunSpec = {
  runId?: string;
  sessionKey?: string;
  channel?: string | undefined;
  ownerId?: string | undefined;
  trigger?: string | undefined;
  entry?: SessionEntry;
  wait?: Partial<WaitResult>;
  /** Extra `agent_end` hook context fields (e.g. `inputProvenance`). */
  hookContext?: Record<string, unknown>;
  /** Deliver the terminal lifecycle event before the `agent_end` hook (the host does not order them). */
  lifecycleFirst?: boolean;
  endedAt?: number;
};

export const OWNER = "profile:alice";
export const PHONE = "node:alice-iphone";

export class FakeHost {
  subscriptions: { streams?: string[]; phases?: string[]; handle: Handler }[] = [];
  services: { start(): unknown; stop(): unknown }[] = [];
  methods = new Map<string, GatewayHandler>();
  entries = new Map<string, SessionEntry>();
  /** Session keys the plugin looked up; only a settled run (both signals) triggers a lookup. */
  entryLookups: string[] = [];
  /** Typed hooks registered with `api.on(name, handler)`. */
  hooks = new Map<string, ((event: unknown, ctx: Record<string, unknown>) => unknown)[]>();
  /** Lines the plugin wrote through the host's scoped `api.logger`. */
  logs: string[] = [];
  pluginConfig: Record<string, unknown>;
  constructor(pluginConfig: Record<string, unknown>) { this.pluginConfig = pluginConfig; }

  api() {
    return {
      pluginConfig: this.pluginConfig,
      logger: { info: (message: string) => { this.logs.push(message); } },
      on: (name: string, handler: (event: unknown, ctx: Record<string, unknown>) => unknown) => {
        this.hooks.set(name, [...(this.hooks.get(name) ?? []), handler]);
      },
      registerService: (service: { id: string; start(): unknown; stop(): unknown }) => { this.services.push(service); },
      registerGatewayMethod: (name: string, handler: GatewayHandler) => { this.methods.set(name, handler); },
      agent: {
        events: {
          registerAgentEventSubscription: (sub: { id: string; streams?: string[]; phases?: string[]; handle: Handler }) => {
            this.subscriptions.push(sub);
          },
        },
      },
      runtime: {
        agent: {
          session: {
            getSessionEntryAsync: async ({ sessionKey }: { sessionKey: string }) => { this.entryLookups.push(sessionKey); return this.entries.get(sessionKey); },
          },
        },
      },
    };
  }

  /** Fires a typed hook the way the host's hook runner does. */
  async fireHook(name: string, event: unknown, ctx: Record<string, unknown>) {
    for (const handler of this.hooks.get(name) ?? []) await handler(event, ctx);
  }

  async emit(event: AgentEvent) {
    const matching = this.subscriptions.filter((s) =>
      (!s.streams?.length || s.streams.includes(event.stream)) &&
      (!s.phases?.length || s.phases.includes(String(event.data.phase))));
    await Promise.all(matching.map((s) => s.handle(event)));
  }

  /** Invokes a registered method the way the Gateway router does and returns the single response. */
  async call(method: string, params: unknown, caller: { profileId?: string; deviceId?: string } = {}): Promise<GatewayResponse> {
    const handler = this.methods.get(method);
    if (!handler) throw new Error(`method not registered: ${method}`);
    const client: GatewayClient = {
      ...(caller.deviceId !== undefined ? { connect: { device: { id: caller.deviceId } } } : {}),
      ...(caller.profileId !== undefined ? { authenticatedUserProfile: { profileId: caller.profileId } } : {}),
    };
    const responses: GatewayResponse[] = [];
    await handler({ params, client, respond: (ok, payload, error) => { responses.push({ ok, payload, ...(error ? { error } : {}) }); } });
    if (responses.length !== 1) throw new Error(`${method} responded ${responses.length} times`);
    return responses[0]!;
  }
}

export class FakeTransport implements PushTransport {
  pushes: PushRequest[] = [];
  respond: (request: PushRequest) => Promise<PushResult> = async () => ({ status: "accepted" });
  async push(request: PushRequest) {
    this.pushes.push({ ...request });
    return this.respond(request);
  }
}

export class FakeDevices implements DeviceDirectory {
  afterList: (() => Promise<void>) | undefined;
  devices: Device[] = [{ deviceId: PHONE, ownerId: OWNER, platform: "ios", paired: true, incarnation: "pair-1" }];
  failing = false;
  async listForOwner(ownerId: string) {
    if (this.failing) throw new Error("directory unavailable");
    const listed = this.devices.filter((d) => d.ownerId === ownerId).map((d) => ({ ...d }));
    await this.afterList?.();
    return listed;
  }
  async get(deviceId: string) {
    if (this.failing) throw new Error("directory unavailable");
    const found = this.devices.find((d) => d.deviceId === deviceId);
    return found ? { ...found } : undefined;
  }
}

export class FakeViewing implements ViewingSource {
  views = new Map<string, ViewingPresence>();
  failing = false;
  onLookup: (() => Promise<void>) | undefined;
  async current(deviceId: string) {
    await this.onLookup?.();
    if (this.failing) throw new Error("presence unavailable");
    return this.views.get(deviceId);
  }
}

export class Clock {
  t = 1_000_000;
  now = () => this.t;
  advance(ms: number) { this.t += ms; }
}

export type Harness = Awaited<ReturnType<typeof startHarness>>;

export async function startHarness(options: { stateDir?: string; clock?: Clock; transport?: FakeTransport; devices?: FakeDevices; viewing?: FakeViewing; pushTimeoutMs?: number; declaredOwnerId?: string; joinTimeoutMs?: number; alertContent?: "generic" | "preview" } = {}) {
  const stateDir = options.stateDir ?? await mkdtemp(join(tmpdir(), "reply-alerts-"));
  const clock = options.clock ?? new Clock();
  const transport = options.transport ?? new FakeTransport();
  const devices = options.devices ?? new FakeDevices();
  const viewing = options.viewing;
  const diagnostics: { code: string }[] = [];
  const host = new FakeHost({ stateDir });
  const plugin = createReplyAlertsPlugin({
    transport,
    devices,
    ...(viewing ? { viewing } : {}),
    now: clock.now,
    ...(options.pushTimeoutMs !== undefined ? { pushTimeoutMs: options.pushTimeoutMs } : {}),
    ...(options.declaredOwnerId !== undefined ? { declaredOwnerId: options.declaredOwnerId } : {}),
    ...(options.joinTimeoutMs !== undefined ? { joinTimeoutMs: options.joinTimeoutMs } : {}),
    ...(options.alertContent !== undefined ? { alertContent: options.alertContent } : {}),
    diagnostics: (event) => { diagnostics.push(event); },
  });
  plugin.register(host.api());
  for (const service of host.services) await service.start();
  let counter = 0;

  return {
    host, transport, devices, viewing, clock, stateDir, diagnostics,
    codes: () => diagnostics.map((d) => d.code),
    /** Explicit-device opt-in (e.g. from the owner's CLI). `profileId: null` calls without an authenticated profile. */
    async optIn(deviceId = PHONE, enabled = true, profileId: string | null = OWNER) {
      return flatten(await host.call("replyAlerts.device.set", { deviceId, enabled }, profileId === null ? {} : { profileId }));
    },
    /** Opt-in sent by the device itself: no deviceId param, the caller's connection identifies it. */
    async optInFromDevice(deviceId: string, enabled = true, profileId: string = OWNER) {
      return flatten(await host.call("replyAlerts.device.set", { enabled }, { profileId, deviceId }));
    },
    async statusFromDevice(deviceId: string, profileId: string = OWNER) {
      return flatten(await host.call("replyAlerts.device.get", {}, { profileId, deviceId }));
    },
    /**
     * Plays one run the way the live Gateway reports it: the `agent_end` hook context carries the
     * origin (channel, trigger, input provenance), the session entry carries the owner, and the
     * terminal lifecycle event carries the terminal facts. `wait` keeps the older spec vocabulary.
     */
    async completeRun(spec: RunSpec = {}) {
      counter += 1;
      const runId = spec.runId ?? `run-${counter}`;
      const sessionKey = spec.sessionKey ?? "agent:main:webchat:conversation-1";
      const endedAt = spec.endedAt ?? clock.now();
      if (!host.entries.has(sessionKey) || spec.entry || "ownerId" in spec) {
        const ownerId = "ownerId" in spec ? spec.ownerId : OWNER;
        host.entries.set(sessionKey, spec.entry ?? (ownerId !== undefined ? { owner: { actor: { type: "human", id: ownerId } } } : {}));
      }
      const wait = { status: "ok", terminalReply: { disposition: "visible" }, ...spec.wait } as WaitResult;
      const stopReason = wait.stopReason ?? (wait.yielded ? "yielded" : wait.status === "error" ? "error" : "stop");
      const data: Record<string, unknown> = {
        phase: "end", endedAt, startedAt: endedAt - 1_000, aborted: stopReason === "cancelled",
        executionSettled: wait.status === "ok", replayInvalid: false, stopReason,
        terminalReply: wait.terminalReply, terminalReceipt: wait.sourceReplyDelivered ? { sourceReplyDelivered: true } : {},
      };
      const channel = "channel" in spec ? spec.channel : "webchat";
      const trigger = "trigger" in spec ? spec.trigger : "user";
      const ctx: Record<string, unknown> = { runId, sessionKey, ...(channel !== undefined ? { channel } : {}), ...(trigger !== undefined ? { trigger } : {}), ...spec.hookContext };
      const end = () => host.emit({ runId, sessionKey, stream: "lifecycle", ts: endedAt, data });
      const hook = () => host.fireHook("agent_end", { runId, success: wait.status === "ok", messages: [{ role: "user", content: "private message text" }] }, ctx);
      if (spec.lifecycleFirst) { await end(); await hook(); } else { await hook(); await end(); }
      return runId;
    },
    async restart(overrides: { transport?: FakeTransport } = {}) {
      for (const service of host.services) await service.stop();
      return startHarness({ stateDir, clock, transport: overrides.transport ?? transport, devices, ...(viewing ? { viewing } : {}) });
    },
    async dispose() {
      for (const service of host.services) await service.stop();
      if (!options.stateDir) await rm(stateDir, { recursive: true, force: true });
    },
  };
}

/** Collapses a Gateway response to `{ ok: true, ...payload }` or `{ ok: false, error: <reason> }`. */
function flatten(response: GatewayResponse) {
  if (response.ok) return { ok: true as const, ...(response.payload as Record<string, unknown>) };
  return { ok: false as const, error: response.error?.details?.reason };
}

export const GENERIC = { title: "OpenClaw", body: "Your reply is ready." };
