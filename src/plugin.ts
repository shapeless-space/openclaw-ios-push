// OpenClaw plugin entry. Wires the host surfaces the live Gateway provides to the reply-alert feature.
// See docs/status.md for what has been observed live and what is still open.
import { ALERT, createReplyAlerts, type DeviceDirectory, type Diagnostic, type PushTransport, type ViewingSource } from "./reply-alerts.ts";
import { previewAlert, readRunOrigin, toRunSettled, type HostAgentEvent, type RunOrigin } from "./host/openclaw-adapter.ts";
import { createCliPushTransport } from "./host/cli-push-transport.ts";
import { createCliDeviceDirectory } from "./host/cli-device-directory.ts";

/** Caller identity the Gateway router passes to method handlers. */
export type GatewayClient = { connect?: { device?: { id?: string } }; authenticatedUserProfile?: { profileId?: string } };
export type GatewayError = { code: string; message: string; details?: Record<string, unknown> };
export type GatewayHandlerOptions = {
  params: unknown;
  client?: GatewayClient | null;
  respond(ok: boolean, payload?: unknown, error?: GatewayError): void;
};
export type HostApi = {
  pluginConfig: Record<string, unknown>;
  /** Scoped plugin logger (`api.logger`). Receives bare diagnostic codes only. */
  logger?: { info?(message: string): void };
  /** Typed plugin hooks. `agent_end` needs `hooks.allowConversationAccess` for non-bundled plugins. */
  on(name: string, handler: (event: unknown, ctx: Record<string, unknown>) => unknown): void;
  registerService(service: { id: string; start(): unknown; stop(): unknown }): void;
  registerGatewayMethod(name: string, handler: (options: GatewayHandlerOptions) => unknown, opts?: { scope: string }): void;
  agent: { events: { registerAgentEventSubscription(sub: { id: string; streams?: string[]; phases?: string[]; handle(event: HostAgentEvent): unknown }): void } };
  runtime: {
    agent: { session: { getSessionEntryAsync(params: { sessionKey: string }): Promise<Record<string, unknown> | undefined> } };
  };
};

export type PluginDeps = {
  transport: PushTransport;
  devices: DeviceDirectory;
  viewing?: ViewingSource;
  now?: () => number;
  pushTimeoutMs?: number;
  /** How long one of the two run signals (agent_end hook, lifecycle end) waits for the other. */
  joinTimeoutMs?: number;
  /** Single-owner Gateways: the person a session belongs to when the session records no owner. */
  declaredOwnerId?: string;
  /** "generic" (default): fixed text. "preview": session name and the start of the reply. */
  alertContent?: "generic" | "preview";
  diagnostics?: (event: Diagnostic) => void;
};

const REQUIRED_CAPABILITIES = [
  "on",
  "registerService",
  "registerGatewayMethod",
  "agent.events.registerAgentEventSubscription",
  "runtime.agent.session.getSessionEntryAsync",
] as const;

function lookup(api: unknown, path: string): unknown {
  let value: unknown = api;
  for (const part of path.split(".")) value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[part] : undefined;
  return value;
}

export const DEVICE_SET_METHOD = "replyAlerts.device.set";
export const DEVICE_GET_METHOD = "replyAlerts.device.get";
export const DEVICES_LIST_METHOD = "replyAlerts.devices.list";

const ERROR_CODES: Record<string, string> = {
  unauthenticated: "FORBIDDEN",
  "devices-unavailable": "UNAVAILABLE",
  "consent-unavailable": "UNAVAILABLE",
  "feature-error": "UNAVAILABLE",
};

type MethodResult = { ok: true; [key: string]: unknown } | { ok: false; error: string };

/** Answers exactly once, mapping feature refusals onto Gateway error codes with the reason in details. */
function answer(respond: GatewayHandlerOptions["respond"], result: MethodResult) {
  if (result.ok) {
    const { ok: _ok, ...payload } = result;
    respond(true, payload);
  } else {
    respond(false, undefined, { code: ERROR_CODES[result.error] ?? "INVALID_REQUEST", message: result.error, details: { reason: result.error } });
  }
}

/** The device a toggle call is about: an explicit `deviceId`, else the calling connection's own device. */
function targetDevice(params: Record<string, unknown>, client: GatewayClient | null | undefined): unknown {
  if (params.deviceId !== undefined) return params.deviceId;
  const own = client?.connect?.device?.id;
  return typeof own === "string" && own.length > 0 ? own : undefined;
}

/** Top-level field names only, sorted: enough to map an unverified host contract, never a value. */
const fieldNames = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.keys(value).sort().join(",") : "";

/** Status-style values only (booleans and short lowercase enum strings); anything else is dropped. */
const enumValue = (value: unknown): string | undefined =>
  typeof value === "boolean" ? String(value) : typeof value === "string" && /^[a-z][a-z0-9_.-]{0,31}$/u.test(value) ? value : undefined;

/** Terminal facts carried on the lifecycle event: status enums plus nested field names. */
function describeFacts(data: unknown): string {
  const d = typeof data === "object" && data !== null ? data as Record<string, unknown> : {};
  const parts: string[] = [];
  for (const key of ["aborted", "executionSettled", "replayInvalid", "stopReason", "livenessState", "trigger", "channel"]) {
    const v = enumValue(d[key]);
    if (v !== undefined) parts.push(`${key}=${v}`);
  }
  const reply = typeof d.terminalReply === "object" && d.terminalReply !== null ? d.terminalReply as Record<string, unknown> : undefined;
  const disposition = enumValue(reply?.disposition);
  if (disposition !== undefined) parts.push(`terminalReply.disposition=${disposition}`);
  for (const key of ["terminalReply", "terminalReceipt"]) if (fieldNames(d[key])) parts.push(`${key}=${fieldNames(d[key])}`);
  return parts.join(" ");
}

function describeOrigin(origin: RunOrigin): string {
  const parts: string[] = [];
  const channel = enumValue(origin.channel), trigger = enumValue(origin.trigger), provenance = enumValue(origin.provenance);
  if (channel) parts.push(`channel=${channel}`);
  if (trigger) parts.push(`trigger=${trigger}`);
  if (provenance) parts.push(`inputProvenance=${provenance}`);
  parts.push(`sender=${origin.hasSender ? "present" : "absent"}`);
  return parts.join(" ");
}

const asRecord = (value: unknown) => (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;

export function createReplyAlertsPlugin(deps: PluginDeps) {
  return {
    id: "ios-reply-alerts",
    register(api: HostApi) {
      // Codes only: never run ids, session keys, device ids or reply content.
      const emit = (code: string) => {
        try { deps.diagnostics?.({ code }); } catch { /* best effort */ }
        try { api.logger?.info?.(`ios-reply-alerts: ${code}`); } catch { /* best effort */ }
      };
      // Unsupported host surfaces must fail installation visibly, never degrade into silent misses.
      for (const capability of REQUIRED_CAPABILITIES) {
        if (typeof lookup(api, capability) !== "function") throw new Error(`ios-reply-alerts: host-capability-missing: ${capability}`);
      }
      const stateDir = api.pluginConfig?.stateDir;
      if (typeof stateDir !== "string" || stateDir.length === 0) throw new Error("ios-reply-alerts: stateDir config required");

      const feature = createReplyAlerts({
        stateDir,
        transport: deps.transport,
        devices: deps.devices,
        now: deps.now ?? Date.now,
        ...(deps.viewing ? { viewing: deps.viewing } : {}),
        ...(deps.pushTimeoutMs !== undefined ? { pushTimeoutMs: deps.pushTimeoutMs } : {}),
        diagnostics: (event) => emit(event.code),
      });
      const joinTimeoutMs = deps.joinTimeoutMs ?? 120_000;
      const logShape = api.pluginConfig?.logEvidenceShape === true;
      const log = (line: string) => { if (logShape) { try { api.logger?.info?.(`ios-reply-alerts: ${line}`); } catch { /* best effort */ } } };

      // The host reports a run twice and in no fixed order: the agent_end hook context (origin) and
      // the lifecycle end event (terminal facts). Whichever arrives second settles the run.
      type Pending = { origin?: RunOrigin; terminal?: HostAgentEvent & { runId: string; sessionKey: string }; timer: ReturnType<typeof setTimeout> };
      const pending = new Map<string, Pending>();
      const settle = async (runId: string) => {
        const p = pending.get(runId);
        if (!p?.origin || !p.terminal) return;
        clearTimeout(p.timer);
        pending.delete(runId);
        let entry;
        try { entry = await api.runtime.agent.session.getSessionEntryAsync({ sessionKey: p.terminal.sessionKey }); }
        catch { emit("evidence-fetch-failed:entry"); return; }
        log(`shape top=${fieldNames(p.terminal)} event=${fieldNames(p.terminal.data)} entry=${fieldNames(entry)}`);
        log(`facts ${describeFacts(p.terminal.data)}`);
        const run = toRunSettled(p.terminal, p.origin, entry, deps.declaredOwnerId);
        if (!run) { emit("evidence-incomplete"); return; }
        if (deps.alertContent === "preview") run.alert = previewAlert(entry, p.terminal.data, ALERT);
        await feature.handleRunSettled(run);
      };
      const track = (runId: string): Pending => {
        let p = pending.get(runId);
        if (!p) {
          const timer = setTimeout(() => {
            const stale = pending.get(runId);
            pending.delete(runId);
            if (stale?.terminal && !stale.origin) emit("origin-missing");
          }, joinTimeoutMs);
          (timer as { unref?: () => void }).unref?.();
          p = { timer };
          pending.set(runId, p);
          if (pending.size > 1_000) {
            const [oldest, stale] = pending.entries().next().value!;
            clearTimeout(stale.timer);
            pending.delete(oldest);
          }
        }
        return p;
      };

      // Observation only, and only the context: the event (with the conversation's messages) is never read.
      api.on("agent_end", async (_event, ctx) => {
        try {
          const runId = typeof ctx?.runId === "string" ? ctx.runId : undefined;
          if (!runId) { emit("origin-missing-run-id"); return; }
          const origin = readRunOrigin(ctx);
          log(`origin ${describeOrigin(origin)}`);
          track(runId).origin = origin;
          await settle(runId);
        } catch { emit("feature-error"); }
      });

      api.agent.events.registerAgentEventSubscription({
        id: "ios-reply-alerts.terminal",
        streams: ["lifecycle"],
        phases: ["end"],
        // Never throws: notification work must not change or fail the reply.
        async handle(event) {
          try {
            const runId = typeof event.runId === "string" ? event.runId : undefined;
            const sessionKey = typeof event.sessionKey === "string" ? event.sessionKey : undefined;
            if (!runId || !sessionKey) {
              log(`shape top=${fieldNames(event)} event=${fieldNames(event.data)}`);
              emit("evidence-missing-run-ids");
              return;
            }
            track(runId).terminal = { ...event, runId, sessionKey };
            await settle(runId);
          } catch { emit("feature-error"); }
        },
      });

      // Called from the device's own connection (a settings toggle), the device is the caller itself;
      // an explicit deviceId serves owner tooling. Either way the device must belong to the caller.
      const methodHandler = (run: (profileId: string | undefined, deviceId: unknown, params: Record<string, unknown>) => Promise<MethodResult>) =>
        async ({ params, client, respond }: GatewayHandlerOptions) => {
          let result: MethodResult;
          try {
            const p = asRecord(params);
            const deviceId = targetDevice(p, client);
            result = deviceId === undefined ? { ok: false, error: "device-required" } : await run(client?.authenticatedUserProfile?.profileId, deviceId, p);
          } catch { result = { ok: false, error: "feature-error" }; }
          answer(respond, result);
        };
      api.registerGatewayMethod(DEVICE_SET_METHOD, methodHandler((profileId, deviceId, p) => feature.setDeviceOptIn(profileId, deviceId, p.enabled)), { scope: "operator.write" });
      api.registerGatewayMethod(DEVICE_GET_METHOD, methodHandler((profileId, deviceId) => feature.getDeviceOptIn(profileId, deviceId)), { scope: "operator.read" });
      // Lists the caller's own iPhones and iPads, marking the calling device, so a browser can switch them.
      api.registerGatewayMethod(DEVICES_LIST_METHOD, async ({ client, respond }: GatewayHandlerOptions) => {
        let result: MethodResult;
        try {
          const listed = await feature.listDeviceOptIns(client?.authenticatedUserProfile?.profileId);
          const own = client?.connect?.device?.id;
          result = listed.ok ? { ok: true, devices: listed.devices.map((d) => ({ ...d, current: d.deviceId === own })) } : listed;
        } catch { result = { ok: false, error: "feature-error" }; }
        answer(respond, result);
      }, { scope: "operator.read" });

      api.registerService({ id: "ios-reply-alerts", start: () => feature.recover(), stop() {} });
    },
  };
}

/**
 * Installable entry. Config: `{ stateDir, owner: { profileId }, gateway: { cliPath, url, identityDir } }`.
 * `identityDir` is the OPENCLAW_STATE_DIR of a CLI identity paired with this Gateway whose device
 * token is narrowed to `operator.read` (node.list) and `operator.write` (push.test). The plugin
 * holds no Gateway secret itself.
 *
 * The Gateway's node list carries no per-device owner, so the administrator must declare the one
 * person who owns every paired iPhone and iPad on this Gateway. Without that declaration the entry
 * refuses to register rather than guess who should receive alerts.
 */
export default {
  id: "ios-reply-alerts",
  register(api: HostApi) {
    const ownerId = asRecord(api.pluginConfig?.owner).profileId;
    if (typeof ownerId !== "string" || ownerId === "") {
      throw new Error("ios-reply-alerts: owner.profileId config required (single-owner Gateways only: every paired device must belong to this person)");
    }
    const gateway = asRecord(api.pluginConfig?.gateway);
    for (const key of ["cliPath", "url", "identityDir"] as const) {
      if (typeof gateway[key] !== "string" || gateway[key] === "") throw new Error(`ios-reply-alerts: gateway.${key} config required`);
    }
    const cli = { cliPath: gateway.cliPath as string, url: gateway.url as string, identityDir: gateway.identityDir as string };
    createReplyAlertsPlugin({
      transport: createCliPushTransport(cli),
      devices: createCliDeviceDirectory({ ...cli, ownerId }),
      declaredOwnerId: ownerId,
      alertContent: asRecord(api.pluginConfig?.alert).content === "preview" ? "preview" : "generic",
    }).register(api);
  },
};
