// Durable notification ledger: one file per (logical run, device) key.
// Reservation uses exclusive create (O_EXCL), so concurrent events and restart replays cannot both
// reserve. File names are SHA-256 digests; no raw run/device identifiers or content are stored.
// Records are never expired: the host documents no finite event-replay horizon, so tombstones are kept.
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type LedgerOutcome = "accepted" | "rejected" | "unknown" | "suppressed" | "revoked";
type LedgerRecord = { state: "reserved" | LedgerOutcome; at: number };

export function createLedger(stateDir: string, now: () => number) {
  const dir = join(stateDir, "ledger");
  const pathFor = (runId: string, deviceId: string) =>
    join(dir, `${createHash("sha256").update(runId).update("\0").update(deviceId).digest("hex")}.json`);

  async function durableWrite(path: string, record: LedgerRecord) {
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(record));
    const handle = await open(tmp, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(tmp, path);
  }

  return {
    /** "reserved" when this caller owns the key; "duplicate" when any earlier attempt exists. Throws if storage fails. */
    async reserve(runId: string, deviceId: string): Promise<"reserved" | "duplicate"> {
      await mkdir(dir, { recursive: true });
      let handle;
      try { handle = await open(pathFor(runId, deviceId), "wx"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return "duplicate";
        throw error;
      }
      try {
        await handle.writeFile(JSON.stringify({ state: "reserved", at: now() } satisfies LedgerRecord));
        await handle.sync();
      } finally { await handle.close(); }
      return "reserved";
    },
    async settle(runId: string, deviceId: string, outcome: LedgerOutcome): Promise<void> {
      await durableWrite(pathFor(runId, deviceId), { state: outcome, at: now() });
    },
    /** Marks reservations left without an outcome (crash window) as unknown. Never resends. */
    async recoverInterrupted(): Promise<number> {
      let names: string[];
      try { names = await readdir(dir); } catch { return 0; }
      let recovered = 0;
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const path = join(dir, name);
        try {
          const record = JSON.parse(await readFile(path, "utf8")) as LedgerRecord;
          if (record.state !== "reserved") continue;
        } catch { /* unreadable/partial reservation: still a reservation */ }
        await durableWrite(path, { state: "unknown", at: now() });
        recovered += 1;
      }
      return recovered;
    },
  };
}
