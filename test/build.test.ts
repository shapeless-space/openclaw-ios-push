// The Gateway refuses to install a TypeScript entry without compiled output next to it
// (`./src/plugin.ts` needs `./dist/plugin.js`). The build must emit a plain-JavaScript entry
// that loads without TypeScript support and exposes the same plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

async function jsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jsFiles(path)));
    else if (entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

test("the build emits dist/plugin.js that loads as plain JavaScript", { timeout: 60_000 }, async (t) => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.deepEqual(pkg.openclaw.extensions, ["./src/plugin.ts"]);
  assert.equal(typeof pkg.scripts.build, "string");

  const outDir = await mkdtemp(join(tmpdir(), "reply-alerts-build-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--project", join(root, "tsconfig.build.json"), "--outDir", outDir], { cwd: root });

  const files = await jsFiles(outDir);
  assert.ok(files.includes(join(outDir, "plugin.js")), `plugin.js missing from ${files.join(", ")}`);
  for (const file of files) {
    assert.doesNotMatch(await readFile(file, "utf8"), /from\s+["']\.{1,2}\/[^"']*\.ts["']/, `${file} still imports .ts`);
  }

  // Child process without type stripping: proves the output needs no TypeScript loader.
  const probe = `const m = await import(${JSON.stringify(pathToFileURL(join(outDir, "plugin.js")).href)});
    process.stdout.write(JSON.stringify({ id: m.default.id, register: typeof m.default.register }));`;
  const { stdout } = await run(process.execPath, ["--no-experimental-strip-types", "--input-type=module", "-e", probe]);
  assert.deepEqual(JSON.parse(stdout), { id: "ios-reply-alerts", register: "function" });
});
