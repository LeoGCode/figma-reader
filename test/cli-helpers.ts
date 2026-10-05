// What the CLI's end-to-end test files (test/cli*.test.ts) share: they run the CLI as a child process on local .fig
// files, where no browser is ever started, with HOME and the caches in a temp dir of each file's own, so nothing
// touches the user's accounts or snapshots. Not a test file itself.
//
// They were one file until it ran past the 30 s --test-timeout on Node 22, which applies the timeout to each test
// file as a whole as well as to each test in it (Node 24 only to the tests): 30.05 s on 22.18, where main's took 19.1.
// Each theme is a file of its own now, and the runner runs the files side by side.
import { after } from "node:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { figBytes, type TestNode } from "./fixtures.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
// Resolved, because every path the CLI prints has been through the cwd the kernel reports, which is resolved:
// on macOS the temp dir is reached through /var -> /private/var, and "use" named the file it copied under the
// /private spelling while the test looked for it under the other one.
export const root = realpathSync(mkdtempSync(join(tmpdir(), "figma-reader-cli-")));
after(() => rmSync(root, { recursive: true, force: true }));
export const home = join(root, "home");
export const work = join(root, "work");
mkdirSync(home);
mkdirSync(work);

// 20k frames named "frame <i>" on two pages: a search for "frame" prints well over 1 MB.
export const FRAMES = 20_000;
export const big: TestNode[] = [
  { id: "0:1", type: "CANVAS", parent: "0:0", name: "Home" },
  { id: "0:2", type: "CANVAS", parent: "0:0", name: "Settings" },
  ...Array.from({ length: FRAMES }, (_, i): TestNode => ({ id: `1:${i + 1}`, type: "FRAME", parent: i % 2 ? "0:2" : "0:1", name: `frame ${i}`, position: String(i).padStart(6, "0") })),
];
let bigPath: string | undefined;
/** `big` as a .fig in the work directory, written by the first call: only the files that read it pay for encoding it. */
export function bigFile(): string {
  if (!bigPath) {
    bigPath = join(work, "big.fig");
    writeFileSync(bigPath, figBytes(big));
  }
  return bigPath;
}

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI with stdout and stderr on pipes, the way `figma-reader ... | jq` runs it; `input` is written to its stdin. */
export function cli(args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; input?: string } = {}): Promise<Run> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, FIGMA_FILES_DIRS: work, FIGMA_ACCOUNT: undefined, FIGMA_READER_CACHE: undefined, ...opts.env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", CLI, ...args], { cwd: opts.cwd ?? work, env: env as NodeJS.ProcessEnv });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
  });
}
