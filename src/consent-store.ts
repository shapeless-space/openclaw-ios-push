// Durable per-device consent. Absent state means "off"; malformed or unreadable state throws so the
// caller can fail closed (no submission) and report it, rather than silently re-enrolling anyone.
// A grant is bound to the owner and the pairing incarnation it was given under: a re-paired
// identity, or a device that changed owner, starts opted out.
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Device } from "./reply-alerts.ts";

type ConsentRecord = { ownerId: string; incarnation: string; enabled: boolean; changedAt: number };
export type EffectiveConsent = { enabled: false } | { enabled: true; since: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function createConsentStore(stateDir: string, now: () => number) {
  const file = join(stateDir, "consent.json");
  let writes: Promise<unknown> = Promise.resolve();

  async function load(): Promise<Record<string, ConsentRecord>> {
    let raw: string;
    try { raw = await readFile(file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error("consent-malformed");
    return parsed as Record<string, ConsentRecord>;
  }

  return {
    async effective(device: Device): Promise<EffectiveConsent> {
      const record = (await load())[device.deviceId];
      if (!isRecord(record) || record.enabled !== true || record.ownerId !== device.ownerId ||
          record.incarnation !== device.incarnation || typeof record.changedAt !== "number") return { enabled: false };
      return { enabled: true, since: record.changedAt };
    },
    /** Resolves only after the change is durably committed. */
    set(device: Device, enabled: boolean): Promise<void> {
      const write = writes.then(async () => {
        await mkdir(stateDir, { recursive: true });
        const records = await load();
        records[device.deviceId] = { ownerId: device.ownerId, incarnation: device.incarnation, enabled, changedAt: now() };
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(records));
        const handle = await open(tmp, "r");
        try { await handle.sync(); } finally { await handle.close(); }
        await rename(tmp, file);
      });
      writes = write.catch(() => {});
      return write;
    },
  };
}
