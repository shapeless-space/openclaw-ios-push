// Alert content. The default is generic ("OpenClaw" / "Your reply is ready."). With
// `alert.content: "preview"` the alert names the session and shows the start of the final reply,
// taken from the terminal event's `terminalReply.text` and the session's `label`/`displayName`.
// Content only ever goes into the push request: never the ledger, consent store or log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { GENERIC, OWNER, PHONE, startHarness } from "./support/harness.ts";

const owned = (extra: Record<string, unknown> = {}) => ({ owner: { actor: { type: "human", id: OWNER } }, ...extra });

test("by default the alert stays generic even when the reply text is available", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun({ entry: owned({ label: "Moon facts" }), wait: { terminalReply: { disposition: "visible", text: "The Moon is drifting away." } as never } });

  assert.deepEqual(h.transport.pushes, [{ deviceId: PHONE, ...GENERIC }]);
});

test("with previews on, the alert names the session and shows the start of the reply", async (t) => {
  const h = await startHarness({ alertContent: "preview" });
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun({ entry: owned({ label: "Moon facts" }), wait: { terminalReply: { disposition: "visible", text: "**The Moon** is slowly\n\n drifting away from `Earth`." } as never } });

  assert.deepEqual(h.transport.pushes, [{ deviceId: PHONE, title: "Moon facts", body: "The Moon is slowly drifting away from Earth." }]);
});

test("previews fall back to the display name, then to OpenClaw, and cut long replies", async (t) => {
  const h = await startHarness({ alertContent: "preview" });
  t.after(() => h.dispose());
  await h.optIn();
  const long = "word ".repeat(100).trim();

  await h.completeRun({ sessionKey: "s:named", entry: owned({ displayName: "Trip planning" }), wait: { terminalReply: { disposition: "visible", text: "Pack light." } as never } });
  await h.completeRun({ sessionKey: "s:unnamed", entry: owned(), wait: { terminalReply: { disposition: "visible", text: long } as never } });

  assert.deepEqual(h.transport.pushes[0], { deviceId: PHONE, title: "Trip planning", body: "Pack light." });
  assert.equal(h.transport.pushes[1]!.title, "OpenClaw");
  assert.ok(h.transport.pushes[1]!.body.length <= 180 && h.transport.pushes[1]!.body.endsWith("…"));
});

test("a visible reply without text keeps the generic body under the session name", async (t) => {
  const h = await startHarness({ alertContent: "preview" });
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun({ entry: owned({ label: "Moon facts" }) });

  assert.deepEqual(h.transport.pushes, [{ deviceId: PHONE, title: "Moon facts", body: "Your reply is ready." }]);
});

test("preview text never reaches the ledger, the consent store or the diagnostics", async (t) => {
  const h = await startHarness({ alertContent: "preview" });
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun({ entry: owned({ label: "Secret project" }), wait: { terminalReply: { disposition: "visible", text: "The launch code is 1234." } as never } });

  assert.equal(h.transport.pushes.length, 1);
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(dir, e.name)); else files.push(await readFile(join(dir, e.name), "utf8"));
    }
  };
  await walk(h.stateDir);
  const stored = files.join("\n") + JSON.stringify(h.diagnostics) + h.host.logs.join("\n");
  for (const secret of ["Secret project", "launch code", "1234"]) assert.ok(!stored.includes(secret), `stored ${secret}`);
});
