#!/usr/bin/env node
// Creates the plugin's own Gateway identity: a separate OpenClaw CLI state directory, paired with
// the local Gateway, whose token is then narrowed to operator.read + operator.write.
//
// Usage (the shared Gateway token is used once, for pairing, and is never stored):
//   OPENCLAW_GATEWAY_TOKEN=<shared token> node scripts/pair-cli-identity.mjs \
//     --cli /path/to/openclaw.mjs --identity-dir ~/.openclaw/plugin-state/ios-reply-alerts/cli-identity
//
// Steps: (1) run `openclaw tui` once as the new identity so the local Gateway pairs it, (2) as that
// identity, rotate its own token down to read + write, (3) save the narrowed token in the identity's
// credential store (the CLI does not save a self-rotated token itself), (4) check it works and that
// admin access is refused. Relies on OpenClaw 2026.11 CLI internals; check the result it prints.
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const run = promisify(execFile);
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []));
const cli = args.cli;
const identityDir = resolve((args["identity-dir"] ?? join(homedir(), ".openclaw/plugin-state/ios-reply-alerts/cli-identity")).replace(/^~(?=\/)/u, homedir()));
const port = args.port ?? "18789";
const node = process.execPath;

function fail(message) { console.error(`pair-cli-identity: ${message}`); process.exit(1); }
if (!cli || !existsSync(cli)) fail("pass --cli <path to the OpenClaw CLI entry script, e.g. .../node_modules/openclaw/openclaw.mjs>");
if (!isAbsolute(identityDir)) fail("--identity-dir must be an absolute path");
if (identityDir === resolve(homedir(), ".openclaw")) fail("--identity-dir must not be the Gateway's own state directory");

const credentials = join(identityDir, "client", "credentials.sqlite");
const baseEnv = { PATH: process.env.PATH ?? "", HOME: homedir(), OPENCLAW_STATE_DIR: identityDir, OPENCLAW_GATEWAY_PORT: port };
const storedToken = () => {
  if (!existsSync(credentials)) return undefined;
  const db = new DatabaseSync(credentials, { readOnly: true });
  try { return db.prepare("select device_id as deviceId, scopes_json as scopes, updated_at_ms as at from device_auth_tokens where role = 'operator'").get(); }
  finally { db.close(); }
};

mkdirSync(identityDir, { recursive: true });
chmodSync(identityDir, 0o700);

// 1. Pair, unless this identity already holds an operator token.
if (!storedToken()) {
  if (!process.env.OPENCLAW_GATEWAY_TOKEN) fail("set OPENCLAW_GATEWAY_TOKEN to the Gateway's shared token for this one pairing step");
  console.log("Pairing a new identity with the local Gateway…");
  // `tui` needs a terminal; `script` provides one. `script` refuses Node's socket pipes, so a shell
  // pipe from `sleep` keeps its stdin open (EOF would quit the TUI). The group is stopped below.
  const tui = spawn("/bin/sh", ["-c", 'sleep 120 | exec script -q /dev/null "$@"', "sh", node, cli, "tui", "--history-limit", "1"], {
    env: { ...baseEnv, TERM: "xterm-256color", OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN },
    stdio: "ignore",
    detached: true,
  });
  const deadline = Date.now() + 60_000;
  while (!storedToken() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1_000));
  try { process.kill(-tui.pid, "SIGTERM"); } catch { /* already gone */ }
  if (!storedToken()) fail("the Gateway did not pair the identity within 60 s (is the Gateway running locally, and is local auto-approval on?)");
}

// 2. Narrow the token, authenticated as the identity itself (no shared token in this environment).
const { deviceId } = storedToken();
console.log(`Identity device: ${deviceId.slice(0, 12)}…  narrowing its token to operator.read + operator.write…`);
let rotated;
try {
  const { stdout } = await run(node, [cli, "devices", "rotate", "--device", deviceId, "--role", "operator", "--scope", "operator.read", "--scope", "operator.write", "--json"], { env: baseEnv });
  rotated = JSON.parse(stdout);
} catch (error) { fail(`token rotation failed: ${String(error?.stderr ?? error).slice(0, 300)}`); }
if (typeof rotated?.token !== "string" || rotated.token.length < 20) fail("rotation returned no token for this identity; it may already be stale. Delete the identity directory and run again.");

// 3. Save it where the CLI reads it.
const db = new DatabaseSync(credentials);
try {
  db.prepare("update device_auth_tokens set token = ?, scopes_json = ?, updated_at_ms = ? where device_id = ? and role = 'operator'")
    .run(rotated.token, JSON.stringify(["operator.read", "operator.write"]), Date.now(), deviceId);
} finally { db.close(); }

// 4. Check: read works, admin is refused.
const call = async (method, params) => {
  try { return JSON.parse((await run(node, [cli, "gateway", "call", method, "--params", JSON.stringify(params), "--json"], { env: baseEnv })).stdout); }
  catch (error) { try { return JSON.parse(error.stdout); } catch { return { ok: false, error: { message: String(error).slice(0, 200) } }; } }
};
const list = await call("node.list", {});
const admin = await call("users.setRole", { profileId: "pair-cli-identity-probe" });
const readOk = Array.isArray(list?.nodes);
const adminRefused = /scope/u.test(String(admin?.error?.message ?? ""));
console.log(`node.list: ${readOk ? "ok" : "FAILED"}   admin method: ${adminRefused ? "refused (good)" : "NOT refused"}`);
if (!readOk || !adminRefused) process.exit(1);
console.log(`Done. Put this in the plugin config:  gateway.identityDir = "${identityDir}"`);
console.log(`To label it in Devices:  openclaw devices rename --device ${deviceId} --name "ios-reply-alerts plugin"`);
