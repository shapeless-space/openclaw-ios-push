// Paired-device directory over the authenticated CLI: `openclaw gateway call node.list`.
// node.list reports each node's pairing, platform, family and approval time but no per-device
// owner. This directory therefore requires the administrator to declare the single person who
// owns every paired device on this Gateway; every other profile owns nothing. It must not be
// used on a Gateway where other people pair their own devices.
import type { Device, DeviceDirectory } from "../reply-alerts.ts";
import { createGatewayCli, type GatewayCliOptions } from "./gateway-cli.ts";

export type CliDeviceDirectoryOptions = GatewayCliOptions & { ownerId: string };

type NodeRow = { nodeId?: unknown; displayName?: unknown; platform?: unknown; deviceFamily?: unknown; paired?: unknown; approvedAtMs?: unknown; commands?: unknown };

const unavailable = () => new Error("device-directory-unavailable");

export function createCliDeviceDirectory(options: CliDeviceDirectoryOptions): DeviceDirectory {
  if (typeof options.ownerId !== "string" || options.ownerId.length === 0) throw new Error("cli-device-directory: declared owner required");
  const { ownerId, ...cliOptions } = options;
  const cli = createGatewayCli(cliOptions);

  /** Paired nodes only. The approval time is the pairing incarnation; a node without one is left out. */
  async function list(): Promise<Device[]> {
    const outcome = await cli.call("node.list", {});
    if (outcome.exited !== "ok") throw unavailable();
    let payload: unknown;
    try { payload = JSON.parse(outcome.stdout); } catch { throw unavailable(); }
    const rows = (payload as { nodes?: unknown } | null)?.nodes;
    if (!Array.isArray(rows)) throw unavailable();
    return rows.flatMap((row: NodeRow) => {
      if (typeof row !== "object" || row === null) return [];
      if (typeof row.nodeId !== "string" || row.nodeId.length === 0 || row.paired !== true) return [];
      if (typeof row.approvedAtMs !== "number" || !Number.isFinite(row.approvedAtMs)) return [];
      // The iOS share extension pairs as a separate iPhone-family node that advertises no commands and has no push registration.
      if (Array.isArray(row.commands) && row.commands.length === 0) return [];
      return [{
        deviceId: row.nodeId,
        ownerId,
        platform: typeof row.platform === "string" ? row.platform : "",
        ...(typeof row.deviceFamily === "string" ? { deviceFamily: row.deviceFamily } : {}),
        ...(typeof row.displayName === "string" && row.displayName.trim() !== "" ? { displayName: row.displayName.trim().slice(0, 64) } : {}),
        paired: true,
        incarnation: `approved:${row.approvedAtMs}`,
      }];
    });
  }

  return {
    async listForOwner(owner: string) {
      const devices = await list();
      return owner === ownerId ? devices : [];
    },
    async get(deviceId: string) {
      return (await list()).find((device) => device.deviceId === deviceId);
    },
  };
}
