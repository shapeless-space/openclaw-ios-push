// `openclaw gateway call <method>` runner shared by the push transport and the device directory.
// It runs as a dedicated paired CLI identity (its own OPENCLAW_STATE_DIR, holding a device token
// narrowed to operator.read + operator.write), so no Gateway secret exists in plugin config, argv
// or env. The Gateway is chosen by port in local mode and pinned with `--expect-url`: a URL
// override would make the CLI demand the shared token instead of using the stored device token.
// The child inherits no other environment.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type GatewayCliOptions = {
  /** Path to the OpenClaw CLI entry script. */
  cliPath: string;
  /** Node binary used to run the CLI (defaults to the current one). */
  nodePath?: string;
  /** Loopback ws:// URL of the local Gateway, without credentials. */
  url: string;
  /** Absolute OPENCLAW_STATE_DIR of the paired, scope-limited CLI identity. Never the Gateway's own state dir. */
  identityDir: string;
  timeoutMs?: number;
  /** Environment the child inherits besides the identity pair. Defaults to PATH and HOME only. */
  baseEnv?: Record<string, string>;
};

export type GatewayCallOutcome =
  | { exited: "ok"; stdout: string }
  | { exited: "error"; killed: boolean; output: string };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function validateUrl(raw: string): { url: string; port: string } {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("gateway-cli: invalid url"); }
  if (url.username || url.password || url.search || url.hash) throw new Error("gateway-cli: url must not carry credentials or query");
  if (url.protocol !== "ws:" || !LOOPBACK.has(url.hostname)) throw new Error("gateway-cli: url must be the local Gateway (loopback ws://)");
  return { url: raw, port: url.port || "18789" };
}

function validateIdentityDir(raw: unknown, home: string | undefined): string {
  if (typeof raw !== "string" || raw.length === 0 || !isAbsolute(raw)) throw new Error("gateway-cli: identityDir must be an absolute path");
  const dir = resolve(raw);
  if (home && dir === resolve(home, ".openclaw")) throw new Error("gateway-cli: identityDir must not be the Gateway's own state directory");
  return dir;
}

export function createGatewayCli(options: GatewayCliOptions) {
  const { url, port } = validateUrl(options.url);
  const baseEnv = options.baseEnv ?? Object.fromEntries(["PATH", "HOME"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
  const identityDir = validateIdentityDir(options.identityDir, baseEnv.HOME ?? homedir());
  const timeoutMs = options.timeoutMs ?? 15_000;

  return {
    /** Runs one call; never rejects, so callers decide what each outcome means. */
    call(method: string, params: Record<string, unknown>): Promise<GatewayCallOutcome> {
      const args = [options.cliPath, "gateway", "call", method, "--params", JSON.stringify(params), "--json", "--timeout", String(timeoutMs), "--expect-url", url];
      return new Promise((done) => {
        execFile(options.nodePath ?? process.execPath, args, {
          env: { ...baseEnv, OPENCLAW_STATE_DIR: identityDir, OPENCLAW_GATEWAY_PORT: port },
          timeout: timeoutMs + 2_000,
          killSignal: "SIGKILL",
          maxBuffer: 1_000_000,
        }, (error, stdout, stderr) => {
          if (!error) done({ exited: "ok", stdout });
          else done({ exited: "error", killed: (error as { killed?: boolean }).killed === true, output: `${stdout}${stderr}` });
        });
      });
    },
  };
}
