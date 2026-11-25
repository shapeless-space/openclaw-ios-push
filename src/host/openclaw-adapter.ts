// Maps the OpenClaw host's run evidence to the feature's RunSettled facts. The fields below are what
// OpenClaw 2026.11.6 reports (Codex runtime); `logEvidenceShape` prints them if a release changes them:
// - origin is only on the `agent_end` hook context: `channel`/`messageProvider`, `trigger`,
//   optional `inputProvenance.kind`;
// - terminal facts are on the lifecycle `end` event data: `endedAt`, `aborted`,
//   `executionSettled`, `stopReason`, `terminalReply.disposition`, `terminalReceipt`;
// - ownership is on the session entry: `owner.actor` (assigned) or `createdActor` (creator).
// - `runtime.subagent.waitForRun` fails for chat runs, and agent events carry no origin.
// Anything missing stays undefined so the policy fails closed.
import type { RunSettled } from "../reply-alerts.ts";

export type HostAgentEvent = { runId?: unknown; sessionKey?: unknown; stream?: unknown; data?: unknown };
export type HostSessionEntry = Record<string, unknown> | undefined;
/** The fields of a hook context the plugin reads. Never the hook event or its messages. */
export type RunOrigin = { channel?: string; trigger?: string; provenance?: string; hasSender: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Reads a run's origin from an `agent_end` hook context. */
export function readRunOrigin(ctx: Record<string, unknown>): RunOrigin {
  const origin: RunOrigin = { hasSender: str(ctx.senderId) !== undefined };
  const channel = str(ctx.channel) ?? str(ctx.messageProvider);
  const trigger = str(ctx.trigger);
  const provenance = isRecord(ctx.inputProvenance) ? str(ctx.inputProvenance.kind) : undefined;
  if (channel) origin.channel = channel.toLowerCase();
  if (trigger) origin.trigger = trigger;
  if (provenance) origin.provenance = provenance;
  return origin;
}

/**
 * The person a session belongs to. An explicit owner assignment wins, then a human profile creator.
 * A session created by an agent, the system or a channel sender has no profile owner. A session
 * that records no owner at all (the shared main session) belongs to the declared single owner.
 */
export function resolveOwner(entry: HostSessionEntry, declaredOwnerId: string | undefined): string | undefined {
  if (!entry) return undefined;
  const assigned = isRecord(entry.owner) && isRecord(entry.owner.actor) ? entry.owner.actor : undefined;
  if (assigned) return assigned.type === "human" ? str(assigned.id) : undefined;
  const creator = isRecord(entry.createdActor) ? entry.createdActor : undefined;
  if (creator) return creator.type === "human" && creator.source === "profile" ? str(creator.id) : undefined;
  return declaredOwnerId;
}

/**
 * Spawned work (sub-agents, delegated sessions), as opposed to a thread a person started. A parent
 * link alone is not enough: the iOS app's new threads carry `parentSessionKey` of the main session
 * with `createdVia: "operator"` and `spawnDepth: 0`.
 */
function isSpawned(entry: Record<string, unknown>): boolean {
  if (str(entry.spawnedBy) !== undefined || str(entry.spawnedBySessionId) !== undefined || str(entry.subagentRole) !== undefined) return true;
  if (typeof entry.spawnDepth === "number" && entry.spawnDepth > 0) return true;
  if (str(entry.parentSessionKey) === undefined) return false;
  return entry.createdVia !== "operator" || !(isRecord(entry.createdActor) && entry.createdActor.type === "human");
}

export function toRunSettled(event: HostAgentEvent, origin: RunOrigin, entry: HostSessionEntry, declaredOwnerId?: string): RunSettled | undefined {
  const runId = str(event.runId);
  const sessionKey = str(event.sessionKey);
  if (!runId || !sessionKey) return undefined;
  const data = isRecord(event.data) ? event.data : {};
  const terminalReply = isRecord(data.terminalReply) ? data.terminalReply : {};
  const receipt = isRecord(data.terminalReceipt) ? data.terminalReceipt : {};
  const stopReason = str(data.stopReason);
  // Input relayed from another session or the system keeps trigger "user" on some paths; provenance overrides it.
  const trigger = origin.provenance && origin.provenance !== "external_user" ? `provenance:${origin.provenance}` : origin.trigger;
  const status = data.aborted === true ? "aborted" : data.aborted === false && data.executionSettled === true ? "ok" : undefined;
  const isChild = sessionKey.includes(":subagent:") || (entry !== undefined && isSpawned(entry));
  return {
    runId,
    sessionKey,
    trigger,
    provenance: origin.channel ? [origin.channel] : [],
    ownerId: resolveOwner(entry, declaredOwnerId),
    status,
    stopReason,
    isChild,
    yielded: stopReason === "yielded",
    disposition: str(terminalReply.disposition),
    sourceReplyDelivered: receipt.sourceReplyDelivered === true,
    endedAt: typeof data.endedAt === "number" ? data.endedAt : undefined,
  };
}

const PREVIEW_TITLE_MAX = 60;
const PREVIEW_BODY_MAX = 180;

/** Plain one-line text: markdown markers and code fences removed, whitespace collapsed, cut with an ellipsis. */
function plainText(text: string, max: number): string {
  const flat = text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`#>~|]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Preview alert: the session's name and the start of the final reply. Falls back to "OpenClaw"
 * and the generic body when either is missing. Built only when previews are switched on.
 */
export function previewAlert(entry: HostSessionEntry, data: unknown, fallback: { title: string; body: string }): { title: string; body: string } {
  const name = entry ? str(entry.label) ?? str(entry.displayName) ?? str(entry.subject) : undefined;
  const reply = isRecord(data) && isRecord(data.terminalReply) ? str(data.terminalReply.text) : undefined;
  const title = name ? plainText(name, PREVIEW_TITLE_MAX) : "";
  const body = reply ? plainText(reply, PREVIEW_BODY_MAX) : "";
  return { title: title || fallback.title, body: body || fallback.body };
}
