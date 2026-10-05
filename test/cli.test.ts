// The CLI end to end, as a child process on local .fig files: no browser is ever started for a local path. HOME and
// the caches point into a temp dir so nothing touches the user's accounts or snapshots.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { dropLease, takeLease } from "../src/browser.ts";
import { LEASE_POLL_MS } from "../src/store.ts";
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
  assert.deepEqual(JSON.parse(readFileSync(join(sub, ".figma-reader.json"), "utf8")), { filesDirs: [join("..", "design")], account: "personal" });
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
  // Several directories in one variable, separated the way this platform separates PATH. The split was on ':',
  // which on Windows cuts "C:\designs" into "C" and "\designs": the directory a user configured was never
  // searched, and list-files answered that there were no local files without saying why.
  const two = JSON.parse((await cli(["list-files", "--limit", "100"], { env: { FIGMA_FILES_DIRS: [dir, work].join(delimiter) } })).stdout);
  assert.deepEqual(two.searchedDirs, [dir, work]);
  assert.equal(two.total, 36, "the 35 files here and the one in the work directory");
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

/**
 * A home of its own, with every root this tool writes below it: state, data and (unless FIGMA_READER_CACHE moves it)
 * the cache. Windows builds those from APPDATA and LOCALAPPDATA rather than from HOME, so they are moved too.
 */
function ownHome(name: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  return { dir, env: { HOME: dir, USERPROFILE: dir, APPDATA: join(dir, "AppData", "Roaming"), LOCALAPPDATA: join(dir, "AppData", "Local") } };
}
/** Everything under dir, as paths relative to it. */
const contents = (dir: string) => readdirSync(dir, { recursive: true }).map(String).sort();

const realFig = join(import.meta.dirname, "files", "real-export.fig");
const LOCAL_READS = [
  ["help"],
  ["load-file", realFig],
  ["get-tree", realFig, "--depth", "1"],
  ["search", realFig, "a", "--limit", "1"],
  ["get-text", realFig, "--limit", "1"],
  ["list-files"],
];

test("a local read or help writes nothing: no browser state, no cache directory", async () => {
  // Loading the tools used to register this process with the shared browser (a lease under the state directory) and
  // make the account's cache directory, so every call wrote both before it had looked at its arguments.
  for (const where of ["under HOME", "in FIGMA_READER_CACHE"]) {
    const { dir, env } = ownHome(`untouched ${where}`);
    const cache = join(root, `untouched cache ${where}`);
    mkdirSync(cache);
    const cacheEnv = { ...env, FIGMA_READER_CACHE: where === "under HOME" ? undefined : cache };
    const runs = await Promise.all(LOCAL_READS.map((args) => cli(args, { env: cacheEnv })));
    runs.forEach((r, i) => assert.equal(r.code, 0, `${LOCAL_READS[i][0]}: ${r.stderr}`));
    assert.deepEqual(contents(dir), [], `cache ${where}: written under HOME`);
    assert.deepEqual(contents(cache), [], `cache ${where}: written in the cache`);
  }
});

test("a local read or help works where nothing may be written", { skip: (process.platform === "win32" || process.getuid?.() === 0) && "permissions do not bind here" }, async () => {
  // A read-only sandbox (Codex -s read-only) failed a get-tree on a local .fig with EROFS on that lease, before it
  // decoded anything. Directories this user may not write stand in for it, as the state and cache roots both.
  const { dir, env } = ownHome("read-only");
  const cache = join(root, "read-only cache");
  mkdirSync(cache);
  chmodSync(dir, 0o555);
  chmodSync(cache, 0o555);
  try {
    for (const cacheRoot of [undefined, cache]) {
      const runs = await Promise.all(LOCAL_READS.map((args) => cli(args, { env: { ...env, FIGMA_READER_CACHE: cacheRoot } })));
      runs.forEach((r, i) => assert.equal(r.code, 0, `${LOCAL_READS[i][0]}: ${r.stderr}`));
      assert.match(runs[0].stdout, /^figma-reader \S+: /);
      assert.ok(JSON.parse(runs[1].stdout).fileModifiedAt, "load-file answered for the file");
    }
  } finally {
    chmodSync(dir, 0o755);
    chmodSync(cache, 0o755);
  }
});

test("a call that reaches the browser has registered with it by then, and gives that back when it exits", async () => {
  // The lease is what another process's release() reads before it closes the browser, so it has to be there before
  // this process first talks to the browser: taken any later, a release in between closes it under this one.
  const { dir, env } = ownHome("web-lease");
  const leases = () => contents(dir).filter((p) => basename(dirname(p)) === "clients");
  let seen: string[] | undefined;
  const server = createServer((_req, res) => {
    seen ??= leases();
    // A DevTools endpoint whose socket refuses the connection: status stops there, before anything reaches figma.com.
    res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/none", "User-Agent": "Chrome" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as AddressInfo;
    const r = await cli(["status"], { env: { ...env, FIGMA_CDP_URL: `http://127.0.0.1:${port}` } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).loggedIn, "unknown");
    assert.equal(seen?.length, 1, `leases when the browser was first asked: ${JSON.stringify(seen)}`);
    assert.deepEqual(leases(), [], "and none once it had exited");
  } finally {
    server.close();
  }
});

test("a call that may export has registered with the browser while it waits for another process's export", async () => {
  // Registered only once its own export began, it would be unannounced for the whole wait, and the process it waits
  // for may be the browser's last client: that one closes the browser on its way out, just as this one turns to it.
  // Its own process, since this has to be the first time it reaches for the browser.
  const { dir, env } = ownHome("waits");
  const cache = join(root, "waits cache");
  const key = "WAITINGKEY1234";
  // A lease of this test's own pid, stamped as this process, is what the CLI reads as another process exporting the
  // key, and it waits for as long as the lease is there.
  const exportsDir = join(cache, "accounts", "waits", "exports", key);
  const other = takeLease(exportsDir, `${process.pid}-${Date.now()}-other`);
  const leases = () => contents(dir).filter((p) => basename(dirname(p)) === "clients");
  let exited = false;
  const run = cli(["load-file", key], {
    env: { ...env, FIGMA_ACCOUNT: "waits", FIGMA_READER_CACHE: cache, FIGMA_BROWSER_PATH: join(dir, "no-such-browser") },
  }).finally(() => (exited = true));
  try {
    const deadline = Date.now() + 10_000;
    while (!leases().length && !exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const registered = leases();
    await new Promise((r) => setTimeout(r, 3 * LEASE_POLL_MS));
    assert.deepEqual([exited, readdirSync(exportsDir)], [false, [basename(other)]], "still waiting, with no export of its own");
    assert.equal(registered.length, 1, `client leases while it waited: ${JSON.stringify(registered)}`);
  } finally {
    dropLease(other);
    // Then it exports, which here is a browser that cannot start rather than a launch.
    const r = await run;
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Cannot start browser/);
  }
  assert.deepEqual(leases(), [], "and none once it had exited");
});

test("what an unfinished export left behind is swept by the next call that reaches the browser, not by a local read", async () => {
  // A crash between an export's copy and its rename leaves a full-size partial beside the snapshot. Sweeping it is
  // cleanup every process used to run as it loaded; only an export ever leaves one, so it waits for a call that may.
  const { env } = ownHome("leftovers");
  const cache = join(root, "leftovers cache");
  const left = join(cache, "accounts", "leftovers", "KEY.fig.12345.abcdef.tmp");
  mkdirSync(dirname(left), { recursive: true });
  writeFileSync(left, "half a snapshot");
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(left, old, old);
  const accountEnv = { ...env, FIGMA_ACCOUNT: "leftovers", FIGMA_READER_CACHE: cache };
  const read = await cli(["get-tree", realFig, "--depth", "0"], { env: accountEnv });
  assert.equal(read.code, 0, read.stderr);
  assert.ok(existsSync(left), "a local read deleted it");
  // Port 1, where nothing listens: status reaches for the browser and finds nothing to start or to talk to.
  const status = await cli(["status"], { env: { ...accountEnv, FIGMA_CDP_URL: "http://127.0.0.1:1" } });
  assert.equal(status.code, 0, status.stderr);
  assert.ok(!existsSync(left), "the call that reached the browser left it there");
});

