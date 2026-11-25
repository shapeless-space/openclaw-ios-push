// Stub for `openclaw gateway call push.test` and `node.list`. Records its argv and environment
// (into $HOME) and answers by the requested node id. Never contacts a Gateway or APNs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const params = JSON.parse(argv[argv.indexOf("--params") + 1] ?? "{}");
writeFileSync(join(process.env.HOME, "record.json"), JSON.stringify({
  argv,
  env: {
    url: process.env.OPENCLAW_GATEWAY_URL,
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    stateDir: process.env.OPENCLAW_STATE_DIR,
    port: process.env.OPENCLAW_GATEWAY_PORT,
    keys: Object.keys(process.env).sort(),
  },
}));

// `node.list` answers with $HOME/nodes.json verbatim (a test-provided payload), or fails without it.
if (argv[2] === "node.list") {
  const fixture = join(process.env.HOME, "nodes.json");
  if (!existsSync(fixture)) { process.stderr.write("Gateway error: connection refused"); process.exit(1); }
  process.stdout.write(readFileSync(fixture, "utf8"));
  process.exit(0);
}

switch (params.nodeId) {
  case "stub:accept":
    process.stdout.write(JSON.stringify({ ok: true }));
    process.exit(0);
  // push.test answers ok at the RPC level even when APNs refuses: the verdict is in the payload.
  case "stub:apns-bad-token":
    process.stdout.write(JSON.stringify({ ok: false, status: 400, reason: "BadDeviceToken", tokenSuffix: "abcd1234", transport: "direct" }));
    process.exit(0);
  case "stub:apns-unavailable":
    process.stdout.write(JSON.stringify({ ok: false, status: 503, reason: "ServiceUnavailable", transport: "relay" }));
    process.exit(0);
  case "stub:garbled":
    process.stdout.write("not json");
    process.exit(0);
  case "stub:no-registration":
    process.stderr.write(`Gateway error: node ${params.nodeId} has no APNs registration (connect iOS node first)`);
    process.exit(1);
  case "stub:unauthorized":
    process.stderr.write("Gateway error: missing scope: operator.write");
    process.exit(1);
  case "stub:hang":
    setInterval(() => {}, 1_000);
    break;
  default:
    process.stderr.write("connection reset");
    process.exit(1);
}
