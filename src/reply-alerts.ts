// Reply-alert feature core: eligibility → per-device consent → viewing → durable ledger → transport.
// Host-independent. The OpenClaw host mapping lives in src/host/openclaw-adapter.ts.
import { createConsentStore } from "./consent-store.ts";
import { createLedger } from "./ledger.ts";

export const ALERT = { title: "OpenClaw", body: "Your reply is ready." } as const;

/** Normalized, host-independent facts about one settled run. Every field is evidence, never a default. */
export type RunSettled = {
  runId: string;
  sessionKey: string;
  trigger: string | undefined;
  /** Every origin/delivery channel marker found for the conversation and run. Empty = unknown. */
  provenance: string[];
  ownerId: string | undefined;
  status: string | undefined;
  stopReason: string | undefined;
  /** True when lineage shows a spawned/child session. Children never notify on their own. */
  isChild: boolean;
  /** True when the run ended by yielding to children/waiting work rather than answering. */
  yielded: boolean;
  disposition: string | undefined;
  /** Host receipt that a final reply reached the source conversation (terminalReceipt). */
  sourceReplyDelivered: boolean;
  endedAt: number | undefined;
  /** Alert text for this run; the generic ALERT when absent. Never stored or logged. */
  alert?: { title: string; body: string };
};

/**
 * A paired node. `platform` and `deviceFamily` are the node's reported metadata
 * (e.g. "iPadOS 26.2" / "iPad"), which the Gateway pins at pairing.
 */
export type Device = { deviceId: string; ownerId: string; platform: string; deviceFamily?: string; displayName?: string; paired: boolean; incarnation: string };
export interface DeviceDirectory {
  listForOwner(ownerId: string): Promise<Device[]>;
  get(deviceId: string): Promise<Device | undefined>;
}
export type ViewingPresence = { sessionKey: string; foreground: boolean; observedAt: number; authenticated: boolean };
export interface ViewingSource { current(deviceId: string): Promise<ViewingPresence | undefined> }
export type PushRequest = { deviceId: string; title: string; body: string };
export type PushResult = { status: "accepted" } | { status: "rejected"; code: string };
export interface PushTransport { push(request: PushRequest): Promise<PushResult> }
export type Diagnostic = { code: string };

export type ReplyAlertsOptions = {
  stateDir: string;
  transport: PushTransport;
  devices: DeviceDirectory;
  viewing?: ViewingSource;
  now: () => number;
  /** Bound on waiting for transport acknowledgement; expiry records "unknown", never a resend. */
  pushTimeoutMs?: number;
  /** Maximum age of a presence declaration that may suppress an alert. */
  viewingFreshMs?: number;
  diagnostics?: (event: Diagnostic) => void;
};

/** App/web channel identifiers accepted as eligible origins. Anything else, including Telegram, is excluded. */
export const APP_WEB_CHANNELS: ReadonlySet<string> = new Set(["webchat", "app", "web"]);
/** Stop reasons compatible with a completed, non-cancelled turn. */
const COMPLETED_STOP_REASONS: ReadonlySet<string> = new Set(["end_turn", "stop", "completed"]);

/** Returns the first reason a run is ineligible, or undefined when it positively qualifies. */
export function ineligibility(run: RunSettled): string | undefined {
  if (run.provenance.length === 0) return "origin-unverified";
  if (run.provenance.some((c) => !APP_WEB_CHANNELS.has(c.toLowerCase()))) return "ineligible-channel";
  if (!run.ownerId) return "owner-unverified";
  if (run.isChild) return "child-run";
  if (run.trigger !== "user") return "not-user-turn";
  // A yield hands off to waiting work: it is not a final answer, whatever its stop reason says.
  if (run.yielded) return "run-yielded";
  if (run.status !== "ok" || (run.stopReason !== undefined && !COMPLETED_STOP_REASONS.has(run.stopReason))) return "run-unsuccessful";
  // A delivered source reply stays authoritative even if a later terminal marker is silent.
  if (run.disposition !== "visible" && !run.sourceReplyDelivered) return "reply-not-visible";
  return undefined;
}

// Mirrors the host's own iOS-app classification: an "ios"/"ipados" platform label and an
// iPhone/iPad/iOS family (absent family allowed, as the host allows). Watch, Mac and Android are excluded.
const APPLE_PUSH_PLATFORM = /^(?:ios|ipados)(?:\s|$)/u;
const APPLE_PUSH_FAMILIES = new Set(["iphone", "ipad", "ios"]);

export function isNativePushTarget(device: Pick<Device, "platform" | "deviceFamily">): boolean {
  const platform = typeof device.platform === "string" ? device.platform.trim().toLowerCase() : "";
  if (!APPLE_PUSH_PLATFORM.test(platform)) return false;
  if (device.deviceFamily === undefined || device.deviceFamily.trim() === "") return true;
  return typeof device.deviceFamily === "string" && APPLE_PUSH_FAMILIES.has(device.deviceFamily.trim().toLowerCase());
}

const isEligibleDevice = (device: Device, ownerId: string) =>
  isNativePushTarget(device) && device.paired === true && device.ownerId === ownerId;

export function createReplyAlerts(options: ReplyAlertsOptions) {
  const consent = createConsentStore(options.stateDir, options.now);
  const ledger = createLedger(options.stateDir, options.now);
  const pushTimeoutMs = options.pushTimeoutMs ?? 15_000;
  const viewingFreshMs = options.viewingFreshMs ?? 30_000;
  /** Watermark: replies that ended before this instance started are never replayed. */
  const startedAt = options.now();
  const emit = (code: string) => { try { options.diagnostics?.({ code }); } catch { /* best effort */ } };

  async function submit(device: Device, alert: { title: string; body: string }): Promise<"accepted" | "rejected" | "unknown"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"unknown">((resolve) => { timer = setTimeout(() => resolve("unknown"), pushTimeoutMs); });
    try {
      return await Promise.race([
        options.transport.push({ deviceId: device.deviceId, title: alert.title, body: alert.body }).then((r) => (r.status === "accepted" ? "accepted" as const : "rejected" as const)),
        timeout,
      ]);
    } catch {
      return "unknown";
    } finally { clearTimeout(timer); }
  }

  /** Re-reads pairing and consent immediately before transport handoff. Any failure means "no". */
  async function stillAuthorized(deviceId: string, ownerId: string): Promise<boolean> {
    try {
      const current = await options.devices.get(deviceId);
      if (!current || !isEligibleDevice(current, ownerId)) return false;
      return (await consent.effective(current)).enabled;
    } catch { return false; }
  }

  /** True only for authenticated, fresh, foreground presence on the destination conversation. */
  async function visiblyReading(deviceId: string, sessionKey: string): Promise<boolean> {
    if (!options.viewing) return false;
    try {
      const view = await options.viewing.current(deviceId);
      return view !== undefined && view.authenticated === true && view.foreground === true &&
        view.sessionKey === sessionKey && options.now() - view.observedAt <= viewingFreshMs &&
        view.observedAt <= options.now();
    } catch { return false; /* unknown viewing => send */ }
  }

  async function notifyDevice(run: RunSettled, ownerId: string, device: Device) {
    if (!isEligibleDevice(device, ownerId)) { emit("device-not-eligible"); return; }
    let grant;
    try { grant = await consent.effective(device); } catch { emit("consent-unavailable"); return; }
    if (!grant.enabled) { emit("not-opted-in"); return; }
    if (run.endedAt === undefined || run.endedAt < Math.max(startedAt, grant.since)) { emit("historical"); return; }

    let reservation: "reserved" | "duplicate";
    try { reservation = await ledger.reserve(run.runId, device.deviceId); } catch { emit("ledger-unavailable"); return; }
    if (reservation === "duplicate") { emit("duplicate"); return; }

    if (await visiblyReading(device.deviceId, run.sessionKey)) {
      emit("suppressed-active-view");
      try { await ledger.settle(run.runId, device.deviceId, "suppressed"); } catch { emit("ledger-settle-failed"); }
      return;
    }

    if (!(await stillAuthorized(device.deviceId, ownerId))) {
      emit("revoked-before-dispatch");
      try { await ledger.settle(run.runId, device.deviceId, "revoked"); } catch { emit("ledger-settle-failed"); }
      return;
    }
    const outcome = await submit(device, run.alert ?? ALERT);
    emit(`submitted-${outcome}`);
    try { await ledger.settle(run.runId, device.deviceId, outcome); } catch { emit("ledger-settle-failed"); }
  }

  async function notify(run: RunSettled) {
    const reason = ineligibility(run);
    if (reason || !run.ownerId) { emit(reason ?? "owner-unverified"); return; }
    const ownerId = run.ownerId;
    let devices: Device[];
    try { devices = await options.devices.listForOwner(ownerId); } catch { emit("devices-unavailable"); return; }
    if (devices.length === 0) { emit("owner-has-no-devices"); return; }
    // Devices are independent: each gets its own pipeline, and one failing never blocks another.
    for (const device of devices) {
      try { await notifyDevice(run, ownerId, device); } catch { emit("feature-error"); }
    }
  }

  return {
    /** Call once at service start: reports interrupted submissions as unknown without resending. */
    async recover(): Promise<void> {
      try {
        const count = await ledger.recoverInterrupted();
        for (let i = 0; i < count; i++) emit("recovered-unknown");
      } catch { emit("ledger-unavailable"); }
    },
    /** Never throws and never affects the reply itself. */
    async handleRunSettled(run: RunSettled): Promise<void> {
      try { await notify(run); } catch { emit("feature-error"); }
    },
    /** Authenticated device opt-in/out. Acknowledged only after a durable commit. */
    async setDeviceOptIn(callerProfileId: string | undefined, deviceId: unknown, enabled: unknown) {
      if (!callerProfileId) return { ok: false as const, error: "unauthenticated" };
      if (typeof deviceId !== "string" || typeof enabled !== "boolean") return { ok: false as const, error: "invalid-params" };
      let device: Device | undefined;
      try { device = await options.devices.get(deviceId); } catch { return { ok: false as const, error: "devices-unavailable" }; }
      // Same answer for "absent" and "someone else's": do not reveal other accounts' devices.
      if (!device || device.ownerId !== callerProfileId) return { ok: false as const, error: "device-not-found" };
      if (!isEligibleDevice(device, callerProfileId)) return { ok: false as const, error: "device-not-eligible" };
      try { await consent.set(device, enabled); } catch { return { ok: false as const, error: "consent-unavailable" }; }
      return { ok: true as const, enabled };
    },

    /** The caller's own iPhones and iPads with their toggle state, for switching from any surface. */
    async listDeviceOptIns(callerProfileId: string | undefined) {
      if (!callerProfileId) return { ok: false as const, error: "unauthenticated" };
      let owned: Device[];
      try { owned = await options.devices.listForOwner(callerProfileId); } catch { return { ok: false as const, error: "devices-unavailable" }; }
      const devices: { deviceId: string; displayName?: string; deviceFamily?: string; enabled: boolean }[] = [];
      try {
        for (const device of owned.filter((d) => isEligibleDevice(d, callerProfileId))) {
          devices.push({
            deviceId: device.deviceId,
            ...(device.displayName ? { displayName: device.displayName } : {}),
            ...(device.deviceFamily ? { deviceFamily: device.deviceFamily } : {}),
            enabled: (await consent.effective(device)).enabled,
          });
        }
      } catch { return { ok: false as const, error: "consent-unavailable" }; }
      return { ok: true as const, devices };
    },

    /** Current toggle state for one of the caller's own devices; a non-push device reads as ineligible. */
    async getDeviceOptIn(callerProfileId: string | undefined, deviceId: unknown) {
      if (!callerProfileId) return { ok: false as const, error: "unauthenticated" };
      if (typeof deviceId !== "string") return { ok: false as const, error: "invalid-params" };
      let device: Device | undefined;
      try { device = await options.devices.get(deviceId); } catch { return { ok: false as const, error: "devices-unavailable" }; }
      if (!device || device.ownerId !== callerProfileId) return { ok: false as const, error: "device-not-found" };
      if (!isEligibleDevice(device, callerProfileId)) return { ok: true as const, eligible: false, enabled: false };
      try { return { ok: true as const, eligible: true, enabled: (await consent.effective(device)).enabled }; } catch {
        return { ok: false as const, error: "consent-unavailable" };
      }
    },
  };
}
