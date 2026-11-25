// Push transport over the OpenClaw CLI: `openclaw gateway call push.test`. An ordinary external
// plugin cannot use the trusted in-process gateway request API, so the call runs as the plugin's
// own paired, scope-limited identity (see gateway-cli.ts). This module never reads config or
// credential files.
// push.test targets any node with an APNs registration, so iPhone and iPad nodes share this route.
import type { PushResult, PushTransport, PushRequest } from "../reply-alerts.ts";
import { createGatewayCli, type GatewayCliOptions } from "./gateway-cli.ts";

export type CliPushTransportOptions = GatewayCliOptions;

const DEFINITE_REJECTIONS: [RegExp, string][] = [
  [/has no APNs registration/i, "no-registration"],
  [/missing scope|unauthorized|forbidden|not authorized/i, "unauthorized"],
  [/invalid params|unknown node/i, "invalid-request"],
];

/**
 * `push.test` responds ok at the RPC level with the APNs send result as payload
 * (`{ ok, status, reason, apnsId, tokenSuffix, ... }`), so success depends on that payload.
 * Only `ok: true` is accepted and only a 4xx (APNs refused the request) is a definite rejection.
 * Anything else may or may not have reached the device, so it is unknown. Token details are never kept.
 */
function apnsVerdict(stdout: string): PushResult | undefined {
  let payload: unknown;
  try { payload = JSON.parse(stdout); } catch { return undefined; }
  if (typeof payload !== "object" || payload === null) return undefined;
  const { ok, status } = payload as { ok?: unknown; status?: unknown };
  if (ok === true) return { status: "accepted" };
  if (ok === false && typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500) {
    return { status: "rejected", code: `apns-${status}` };
  }
  return undefined;
}

export function createCliPushTransport(options: CliPushTransportOptions): PushTransport {
  const cli = createGatewayCli(options);
  return {
    async push(request: PushRequest): Promise<PushResult> {
      const outcome = await cli.call("push.test", { nodeId: request.deviceId, title: request.title, body: request.body });
      if (outcome.exited === "ok") {
        const verdict = apnsVerdict(outcome.stdout);
        if (verdict) return verdict;
        throw new Error("push-outcome-unknown");
      }
      const match = outcome.killed ? undefined : DEFINITE_REJECTIONS.find(([pattern]) => pattern.test(outcome.output));
      // Anything not positively recognised may have reached APNs: report it as unknown.
      if (match) return { status: "rejected", code: match[1]! };
      throw new Error("push-outcome-unknown");
    },
  };
}
