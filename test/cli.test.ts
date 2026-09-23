// The CLI end to end, as a child process on local .fig files: no browser is ever started for a local path. HOME and
// the caches point into a temp dir so nothing touches the user's accounts or snapshots.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { figBytes, type TestNode } from "./fixtures.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
// Resolved, because every path the CLI prints has been through the cwd the kernel reports, which is resolved:
// on macOS the temp dir is reached through /var -> /private/var, and "use" named the file it copied under the
// /private spelling while the test looked for it under the other one.
const root = realpathSync(mkdtempSync(join(tmpdir(), "figma-reader-cli-")));
after(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home");
const work = join(root, "work");
mkdirSync(home);
mkdirSync(work);

// 20k frames named "frame <i>" on two pages: a search for "frame" prints well over 1 MB.
const FRAMES = 20_000;
const big: TestNode[] = [
  { id: "0:1", type: "CANVAS", parent: "0:0", name: "Home" },
  { id: "0:2", type: "CANVAS", parent: "0:0", name: "Settings" },
  ...Array.from({ length: FRAMES }, (_, i): TestNode => ({ id: `1:${i + 1}`, type: "FRAME", parent: i % 2 ? "0:2" : "0:1", name: `frame ${i}`, position: String(i).padStart(6, "0") })),
];
const bigFig = join(work, "big.fig");
writeFileSync(bigFig, figBytes(big));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI with stdout and stderr on pipes, the way `figma-reader ... | jq` runs it. */
function cli(args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<Run> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, FIGMA_FILES_DIRS: work, FIGMA_ACCOUNT: undefined, FIGMA_READER_CACHE: undefined, ...opts.env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", CLI, ...args], { cwd: opts.cwd ?? work, env: env as NodeJS.ProcessEnv });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
  });
}

test("npm run test:private fails when there are no private tests to run", async () => {
  // An unmatched glob stays literal, node then collects zero files and exits 0: anyone who never writes the private
  // suite gets a passing "private tests" step forever.
  const script: string = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).scripts["test:private"];
  const sh = (cwd: string, extra: Record<string, string> = {}) =>
    new Promise<Run>((resolve) => {
      // NODE_TEST_CONTEXT is set for us by the runner above; a nested one would report to it instead of its stdout.
      const env = { ...process.env, ...extra };
      delete env.NODE_TEST_CONTEXT;
      const child = spawn("sh", ["-c", script], { cwd, env });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (b) => out.push(b));
      child.stderr.on("data", (b) => err.push(b));
      child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
    });
  const none = join(root, "private-none");
  mkdirSync(none);
  const empty = await sh(none);
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /no test files in test\/private\//);
  // The escape hatch still passes, saying why.
  const skipped = await sh(none, { FIGMA_PRIVATE_OPTIONAL: "1" });
  assert.equal(skipped.code, 0, skipped.stderr);
  assert.match(skipped.stdout, /FIGMA_PRIVATE_OPTIONAL/);
  // With a private test there, it is run.
  const some = join(root, "private-some");
  mkdirSync(join(some, "test", "private"), { recursive: true });
  writeFileSync(join(some, "test", "private", "a.test.ts"), 'import { test } from "node:test";\ntest("private", () => {});\n');
  const ran = await sh(some);
  assert.equal(ran.code, 0, ran.stderr);
  assert.match(ran.stdout, /pass 1/);
});

test("output larger than the pipe buffer reaches a piped reader whole", async () => {
  const r = await cli(["search", bigFig, "frame", "--limit", String(FRAMES)]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.length > 1_000_000, `only ${r.stdout.length} bytes`);
  // process.exit() used to cut this at 64 KiB: the JSON did not parse, and the exit code still said success.
  const res = JSON.parse(r.stdout);
  assert.equal(res.total, FRAMES);
  assert.equal(res.results.length, FRAMES);
});

test("-- ends the options: a query after it is a value, not --help or --account", async () => {
  const help = await cli(["search", bigFig, "--limit", "1", "--", "--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.equal(JSON.parse(help.stdout).total, 0, "searched for the text --help instead of printing usage");
  const acct = await cli(["search", bigFig, "--limit", "1", "--", "--account"]);
  assert.equal(acct.code, 0, acct.stderr);
  assert.equal(JSON.parse(acct.stdout).total, 0);
});

test("a FIGMA_SNAPSHOT_MAX_AGE_MIN that is not a number is reported and ignored", async () => {
  // Number("30m") is NaN, and "age < NaN" is false for every snapshot: a typo silently turned every tool call into a
  // full browser export, up to a minute each, with nothing said anywhere.
  for (const bad of ["30m", "", "abc"]) {
    const r = await cli(["search", bigFig, "frame", "--limit", "1"], { env: { FIGMA_SNAPSHOT_MAX_AGE_MIN: bad } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`FIGMA_SNAPSHOT_MAX_AGE_MIN=${JSON.stringify(bad)} is not a number of minutes; using 30`));
  }
  const ok = await cli(["search", bigFig, "frame", "--limit", "1"], { env: { FIGMA_SNAPSHOT_MAX_AGE_MIN: "5" } });
  assert.equal(ok.stderr, "");
});

test("a --help where a flag's value belongs is that value, not a request for usage", async () => {
  const r = await cli(["search", bigFig, "frame", "--page", "--help"]);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /no page named "--help"/);
  assert.doesNotMatch(r.stdout, /^Usage:/m);
});

test("--page naming no page is an error that lists the pages", async () => {
  // It used to search nothing and report 0 matches.
  const r = await cli(["search", bigFig, "frame", "--page", "Hom"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no page named "Hom"; pages: "Home", "Settings"/);
  assert.equal(JSON.parse((await cli(["search", bigFig, "frame", "--page", "Home", "--limit", "1"])).stdout).total, FRAMES / 2);
});

test("an empty --types is bad usage, not a filter that matches nothing", async () => {
  const r = await cli(["search", bigFig, "frame", "--types="]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--types needs at least one value/);
});

test("a list flag added to a --json value that is not a list is bad usage, not a crash", async () => {
  // It threw a raw TypeError: exit 1, a stack with our source paths, and the browser was never released.
  const r = await cli(["search", bigFig, "frame", "--json", '{"types":5}', "--types", "FRAME"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--types takes a list; --json set types to 5/);
  assert.doesNotMatch(r.stderr, /TypeError|\n\s+at /);
  // "FRAME" used to be searched for as ["F","R","A","M","E"], which matched nothing and still exited 0.
  const str = await cli(["search", bigFig, "frame", "--json", '{"types":"FRAME"}', "--types", "TEXT"]);
  assert.equal(str.code, 2);
  assert.match(str.stderr, /--types takes a list/);
});

test("search reads a query as a pattern only when asked", async () => {
  const q = async (...args: string[]) => JSON.parse((await cli(["search", bigFig, ...args, "--limit", "1"])).stdout);
  assert.deepEqual([(await q("/FRAME 1\\d{4}$/", "--regex")).total, (await q("/FRAME 1\\d{4}$/", "--regex")).queryAs], [10_000, "regex"]);
  assert.equal((await q("/FRAME 1\\d{4}$/", "--regex", "--case-sensitive")).total, 0);
  // The same query without --regex is the layer name a file could really hold, so it matches nothing here.
  assert.deepEqual([(await q("/FRAME 1\\d{4}$/")).total, (await q("/FRAME 1\\d{4}$/")).queryAs], [0, "substring"]);
  assert.deepEqual([(await q("/frame/")).total, (await q("/frame/")).queryAs], [0, "substring"]);
});

test("account commands have help and exit 2 on bad usage", async () => {
  for (const args of [["help", "use"], ["help", "accounts"], ["use", "--help"], ["accounts", "-h"]]) {
    const r = await cli(args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, /^Usage: figma-reader (use <account>|accounts)\n\n\S/, args.join(" "));
  }
  const bad = await cli(["use", "bad name"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /invalid account name "bad name"/);
  assert.equal((await cli(["use"])).code, 2);
  assert.equal((await cli(["help", "nope"])).code, 2);
});

test("use in a subdirectory says which project file it copied", async () => {
  const proj = join(root, "proj");
  const sub = join(proj, "app");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(proj, ".figma-reader.json"), JSON.stringify({ account: "acme", filesDirs: ["design"] }));
  const r = await cli(["use", "personal"], { cwd: sub });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`copied from ${join(proj, ".figma-reader.json")}`), r.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(sub, ".figma-reader.json"), "utf8")), { filesDirs: ["../design"], account: "personal" });
});

test("list-files reports how many files there are beyond the limit, and when a query matched none", async () => {
  const dir = join(root, "many");
  mkdirSync(dir);
  for (let i = 0; i < 35; i++) writeFileSync(join(dir, `File ${i}.fig`), "x");
  const env = { FIGMA_FILES_DIRS: dir };
  const all = JSON.parse((await cli(["list-files"], { env })).stdout);
  assert.deepEqual([all.returned, all.total, all.truncated, all.files.length], [30, 35, true, 30]);
  const some = JSON.parse((await cli(["list-files", "--query", "file 1", "--limit", "100"], { env })).stdout);
  assert.deepEqual([some.returned, some.total, some.truncated], [11, 11, false]);
  // An empty answer used to be an English sentence, which broke every client parsing the JSON this command promises;
  // what it said is in the envelope now. It first said there were no .fig files at all when the query matched none.
  const none = await cli(["list-files", "--query", "nope"], { env });
  assert.equal(none.code, 0);
  assert.deepEqual(JSON.parse(none.stdout).totalUnfiltered, 35);
  const nowhere = JSON.parse((await cli(["list-files"], { env: { FIGMA_FILES_DIRS: join(root, "empty") } })).stdout);
  assert.deepEqual([nowhere.total, nowhere.searchedDirs], [0, [join(root, "empty")]]);
});

test("the download directory follows the browser profile, not the cache each process was given", async () => {
  // The browser is told one download directory for all of its tabs, so every process on a profile has to name the
  // same one. It used to come from the cache: two processes on one profile with different FIGMA_READER_CACHE values
  // armed different directories, and whoever armed it second sent the other's export somewhere nobody waited for it.
  const dirOf = async (env: Record<string, string>) => JSON.parse((await cli(["status"], { env })).stdout).downloadDir;
  const profile = join(root, "profile-a");
  const [one, two] = await Promise.all([
    dirOf({ FIGMA_USER_DATA_DIR: profile, FIGMA_READER_CACHE: join(root, "cache-1") }),
    dirOf({ FIGMA_USER_DATA_DIR: profile, FIGMA_READER_CACHE: join(root, "cache-2") }),
  ]);
  assert.equal(one, two);
  assert.ok(one, "and status reports it, since it is where a download nobody waited for would be sitting");
  // Two profiles are two browsers, each with a download directory of its own.
  assert.notEqual(await dirOf({ FIGMA_USER_DATA_DIR: join(root, "profile-b"), FIGMA_READER_CACHE: join(root, "cache-1") }), one);
});

