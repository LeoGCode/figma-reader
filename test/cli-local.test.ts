// What a CLI call writes, end to end (see cli-helpers.ts): a local read or help writes nothing and works where nothing
// may be written, a call that must write says where it could not, and a call that reaches the browser holds its
// client lease from its first contact to its exit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, join } from "node:path";
import { dropLease, takeLease } from "../src/browser.ts";
import { LEASE_POLL_MS } from "../src/store.ts";
import { cli, root } from "./cli-helpers.ts";

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

test("a call that has to write where it may not says which directory, what needed it, and what reads without writing", { skip: (process.platform === "win32" || process.getuid?.() === 0) && "permissions do not bind here" }, async () => {
  // Raw, both ended in "EACCES: permission denied, mkdir '<path>'", which says neither what needed the directory nor
  // that a read by path needs none of it, and an agent in a read-only sandbox was left to guess.
  const { dir, env } = ownHome("unwritable");
  const cache = join(root, "unwritable cache");
  mkdirSync(cache);
  chmodSync(dir, 0o555);
  chmodSync(cache, 0o555);
  try {
    // Port 1, where nothing listens: had status got past its registration, it would have found no browser there.
    const status = await cli(["status"], { env: { ...env, FIGMA_CDP_URL: "http://127.0.0.1:1" } });
    assert.equal(status.code, 1, status.stderr);
    const state = join(dir, ".local", "state", "figma-reader");
    assert.ok(status.stderr.includes(`registers with it in figma-reader's state directory, ${state}, which this process may not write (EACCES: `), status.stderr);
    assert.match(status.stderr, /Run it where that directory is writable\. Reading a local \.fig by its path, or a key whose cached snapshot is still fresh/);
    // A home it may write, and a cache it may not: the export stops before the browser is asked for anything.
    const home = ownHome("unwritable cache, writable home");
    const load = await cli(["load-file", "UNWRITABLEKEY1"], {
      env: { ...home.env, FIGMA_ACCOUNT: "ro", FIGMA_READER_CACHE: cache, FIGMA_BROWSER_PATH: join(home.dir, "no-such-browser") },
    });
    assert.equal(load.code, 1, load.stderr);
    const said = `exporting UNWRITABLEKEY1 saves its snapshot in figma-reader's cache, ${join(cache, "accounts", "ro")}, which this process may not write (EACCES: `;
    assert.ok(load.stderr.includes(said), load.stderr);
    assert.match(load.stderr, /or set FIGMA_READER_CACHE to a directory that is\./);
    assert.doesNotMatch(load.stderr, /Cannot start browser/, "the browser was never launched for it");
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
