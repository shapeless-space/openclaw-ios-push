import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeTransport, startHarness } from "./support/harness.ts";

test("several final events for one logical run submit at most once", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun({ runId: "run-a" });
  await h.completeRun({ runId: "run-a" });
  await h.completeRun({ runId: "run-a" });

  assert.equal(h.transport.pushes.length, 1);
  assert.deepEqual(h.codes(), ["submitted-accepted", "duplicate", "duplicate"]);
});

test("a distinct later run gets its own alert", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun({ runId: "run-a" });
  await h.completeRun({ runId: "run-b" });

  assert.equal(h.transport.pushes.length, 2);
});

test("concurrent duplicate events reserve once and submit once", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();

  await Promise.all([h.completeRun({ runId: "run-a" }), h.completeRun({ runId: "run-a" }), h.completeRun({ runId: "run-a" })]);

  assert.equal(h.transport.pushes.length, 1);
  assert.deepEqual(h.codes().filter((c) => c.startsWith("submitted")), ["submitted-accepted"]);
});

test("a full duplicate of a settled run is caught by the ledger", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun({ runId: "run-a" });
  await h.completeRun({ runId: "run-a" });

  assert.equal(h.transport.pushes.length, 1);
  assert.deepEqual(h.codes(), ["submitted-accepted", "duplicate"]);
});

test("a replayed event after a Gateway restart does not resubmit", async (t) => {
  const first = await startHarness();
  await first.optIn();
  await first.completeRun({ runId: "run-a" });

  const second = await first.restart();
  t.after(() => second.dispose());
  await second.completeRun({ runId: "run-a" });

  assert.equal(first.transport.pushes.length, 1);
  assert.deepEqual(second.codes(), ["duplicate"]);
});

test("a crash after handoff with no acknowledgement is recorded as unknown and never blindly resent", async (t) => {
  const hanging = new FakeTransport();
  hanging.respond = () => new Promise(() => {});
  const first = await startHarness({ transport: hanging });
  await first.optIn();
  void first.completeRun({ runId: "run-a" });
  await waitFor(() => hanging.pushes.length === 1);

  // Process dies here: reservation is durable, outcome never written.
  const recovered = new FakeTransport();
  const second = await first.restart({ transport: recovered });
  t.after(() => second.dispose());
  await second.completeRun({ runId: "run-a" });

  assert.equal(recovered.pushes.length, 0);
  assert.deepEqual(second.codes(), ["recovered-unknown", "duplicate"]);
});

test("a push timeout records unknown acceptance without automatic resend", async (t) => {
  const transport = new FakeTransport();
  transport.respond = () => new Promise(() => {});
  const h = await startHarness({ transport, pushTimeoutMs: 20 });
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun({ runId: "run-a" });
  await h.completeRun({ runId: "run-a" });

  assert.equal(transport.pushes.length, 1);
  assert.deepEqual(h.codes(), ["submitted-unknown", "duplicate"]);
});

test("a transport exception records unknown, not failure or success", async (t) => {
  const transport = new FakeTransport();
  transport.respond = async () => { throw new Error("socket reset"); };
  const h = await startHarness({ transport });
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun();

  assert.deepEqual(h.codes(), ["submitted-unknown"]);
});

test("a definite rejection is recorded and does not block a later independent reply", async (t) => {
  const transport = new FakeTransport();
  let calls = 0;
  transport.respond = async () => (++calls === 1 ? { status: "rejected", code: "no-registration" } : { status: "accepted" });
  const h = await startHarness({ transport });
  t.after(() => h.dispose());
  await h.optIn();

  await h.completeRun({ runId: "run-a" });
  await h.completeRun({ runId: "run-a" });
  await h.completeRun({ runId: "run-b" });

  assert.equal(transport.pushes.length, 2);
  assert.deepEqual(h.codes(), ["submitted-rejected", "duplicate", "submitted-accepted"]);
});

test("if the durable ledger cannot reserve, nothing is submitted", async (t) => {
  const h = await startHarness();
  t.after(() => h.dispose());
  await h.optIn();
  await writeFile(join(h.stateDir, "ledger"), "not a directory");

  await h.completeRun();

  assert.equal(h.transport.pushes.length, 0);
  assert.deepEqual(h.codes(), ["ledger-unavailable"]);
});

async function waitFor(condition: () => boolean, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setImmediate(r));
  }
}
