// Which Figma account a CLI call goes through, end to end (see cli-helpers.ts): the account commands, and the refusal
// of a default nothing chose while other accounts exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findProjectConfig } from "../src/account.ts";
import { cli, root, type Run, work } from "./cli-helpers.ts";
import { figBytes, type TestNode } from "./fixtures.ts";

// Which Figma login a key or URL is read through. Nothing chose one when there is no FIGMA_ACCOUNT, no --account and
// no .figma-reader.json naming one above the working directory, so it was "default", whichever login was set up
// first: an agent run from a scratch directory read a client file through a personal login that way, an export and
// then 18 screenshots, and nothing in any answer said so. With another account there, such a call is now refused.
const stray = findProjectConfig(root)?.path;
const strayNote = { skip: stray && `${stray} is above the temp dir` };
const KEY = "CACHEDKEY123";
const small: TestNode[] = [{ id: "0:1", type: "CANVAS", parent: "0:0", name: "Page" }, { id: "1:1", type: "FRAME", parent: "0:1", name: "Card" }];
const smallFig = join(root, "local", "small.fig");
mkdirSync(join(root, "local"));
writeFileSync(smallFig, figBytes(small));

/**
 * A machine of its own: a HOME where these accounts have been set up, and a fresh snapshot of KEY in the cache of each
 * account in `cached`. A cached key is answered from the snapshot, so a call that is let through succeeds without a
 * browser, and one that answers at all proves it was let through. No browser can start here in any case.
 */
function machine(name: string, accounts: string[], cached: string[]) {
  const home = join(root, name);
  const env: Record<string, string | undefined> = {
    HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    FIGMA_READER_CACHE: join(home, "cache"), FIGMA_BROWSER_PATH: join(home, "no-such-browser"),
    FIGMA_CDP_URL: undefined, FIGMA_USER_DATA_DIR: undefined,
  };
  const data = process.platform === "win32" ? join(home, "AppData", "Roaming", "figma-reader") : join(home, ".local", "share", "figma-reader");
  for (const a of accounts) mkdirSync(join(data, "accounts", a), { recursive: true });
  for (const a of cached) {
    mkdirSync(join(home, "cache", "accounts", a), { recursive: true });
    writeFileSync(join(home, "cache", "accounts", a, `${KEY}.fig`), figBytes(small));
  }
  return env;
}
/** get-tree's first line, the header carrying what the JSON tools carry. */
const header = (r: Run) => JSON.parse(r.stdout.split("\n")[0].replace(/^# /, ""));

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

test("a key or URL is refused when nothing chose an account and another exists, and nothing else is", strayNote, async () => {
  // default's cache holds a fresh snapshot of KEY: had the refusal come after the cache was read, these would answer.
  const env = machine("two-accounts", ["acme", "default"], ["default"]);
  const web = [
    ["get-tree", KEY],
    ["get-node", `https://www.figma.com/design/${KEY}/App?node-id=1-1`],
    ["screenshot", KEY, "--node-id", "1:1"],
    ["list-files", "--source", "web"],
    ["login"],
  ];
  for (const [args, r] of await Promise.all(web.map(async (args) => [args, await cli(args, { env })] as const))) {
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, "", args.join(" "));
    assert.ok(r.stderr.startsWith(`figma-reader ${args[0]}: no Figma account chosen: no .figma-reader.json was found in or above ${work}, `), r.stderr);
    assert.match(r.stderr, /other accounts exist \(acme\)/);
    assert.match(r.stderr, /pass --account <name> or set FIGMA_ACCOUNT=<name>; --account default is the explicit way to use "default"/);
    assert.match(r.stderr, /should ask the user which account, not pick one/);
  }

  // Choosing default is a choice, by flag or by variable, and then the same key is answered, saying so.
  for (const [args, extra] of [[["--account", "default", "get-tree", KEY], {}], [["get-tree", KEY], { FIGMA_ACCOUNT: "default" }]] as const) {
    const r = await cli([...args], { env: { ...env, ...extra } });
    assert.equal(r.code, 0, r.stderr);
    const h = header(r);
    assert.deepEqual(h.account, { name: "default", source: "FIGMA_ACCOUNT" });
    assert.ok(Date.parse(h.exportedAt), "and the snapshot's time");
    assert.match(r.stdout.split("\n")[1], /^- 0:1 PAGE "Page"/);
  }

  // A local path needs no account, from the very same directory.
  const local = await cli(["get-tree", smallFig], { env });
  assert.equal(local.code, 0, local.stderr);
  assert.deepEqual(Object.keys(header(local)), ["fileModifiedAt"]);
  // So does a key that a local '<name> [<key>].fig' answers, until refresh asks for the live file.
  const keyed = join(root, "keyed");
  mkdirSync(keyed);
  writeFileSync(join(keyed, "Small [LOCALKEY1234].fig"), figBytes(small));
  const byKey = await cli(["get-tree", "LOCALKEY1234"], { env: { ...env, FIGMA_FILES_DIRS: keyed } });
  assert.equal(byKey.code, 0, byKey.stderr);
  assert.deepEqual(Object.keys(header(byKey)), ["fileModifiedAt"]);
  assert.equal((await cli(["get-tree", "LOCALKEY1234", "--refresh"], { env: { ...env, FIGMA_FILES_DIRS: keyed } })).code, 2);
  // Nor do the local listing, the account commands and help.
  const anywhere = [["list-files"], ["accounts"], ["help"], ["use", "--help"]];
  const codes = await Promise.all(anywhere.map(async (args) => (await cli(args, { env })).code));
  assert.deepEqual(codes, anywhere.map(() => 0), anywhere.map((a) => a.join(" ")).join(", "));

  // status is where a refusal is looked into, so it answers, and says what a web call would answer.
  const status = await cli(["status"], { env });
  assert.equal(status.code, 0, status.stderr);
  const s = JSON.parse(status.stdout);
  assert.deepEqual(s.account, { name: "default", source: "default" });
  assert.match(s.webCallsRefused, /^no Figma account chosen: .*other accounts exist \(acme\)/);
});

test("a batch whose line was refused for want of an account exits 2, as that call alone does", strayNote, async () => {
  // Nothing was tried on that line and running it again is refused the same way, which 1 (a call that failed and may
  // not next time) would not say. The other lines still run, and each line says what happened to it.
  const env = machine("batch-refused", ["acme", "default"], ["default"]);
  const lines = [{ tool: "get-tree", args: { file: KEY } }, { tool: "get-tree", args: { file: smallFig } }, { tool: "get-node", args: { file: smallFig, node_id: "9:9" } }];
  const r = await cli(["batch"], { env, input: lines.map((l) => JSON.stringify(l)).join("\n") });
  assert.equal(r.code, 2, r.stderr);
  const out = r.stdout.trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(out.map((o) => o.ok), [false, true, false]);
  assert.match(out[0].error, /^no Figma account chosen: .*other accounts exist \(acme\)/);
  assert.equal(r.stderr, "figma-reader batch: 2 of 3 calls failed (i = 0, 2), 1 of them refused because no Figma account was chosen (i = 0)\n");
  // Without the refused line, the failed one alone is a 1.
  const failedOnly = await cli(["batch"], { env, input: lines.slice(1).map((l) => JSON.stringify(l)).join("\n") });
  assert.equal(failedOnly.code, 1, failedOnly.stderr);
});

test("with default the only account, a key is answered as it always was, and says which account it was", async () => {
  for (const accounts of [[], ["default"]]) {
    const env = machine(`only-default-${accounts.length}`, accounts, ["default"]);
    const r = await cli(["get-tree", KEY], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(header(r).account, { name: "default", source: "default" });
    const status = JSON.parse((await cli(["status"], { env })).stdout);
    assert.deepEqual([status.account, status.webCallsRefused], [{ name: "default", source: "default" }, undefined]);
  }
});

test("a project file decides the account, and one naming none leaves it unchosen", strayNote, async () => {
  const env = machine("projects", ["acme", "default"], ["acme", "default"]);
  const proj = join(root, "projects", "app");
  mkdirSync(proj, { recursive: true });
  const config = join(proj, ".figma-reader.json");
  writeFileSync(config, JSON.stringify({ filesDirs: ["design"] }));
  const unnamed = await cli(["get-tree", KEY], { env, cwd: proj });
  assert.equal(unnamed.code, 2, unnamed.stdout);
  assert.ok(unnamed.stderr.includes(`the nearest .figma-reader.json (${config}) names no account`), unnamed.stderr);
  writeFileSync(config, JSON.stringify({ account: "acme" }));
  const named = await cli(["get-tree", KEY], { env, cwd: proj });
  assert.equal(named.code, 0, named.stderr);
  assert.deepEqual(header(named).account, { name: "acme", source: config });
});

test("a browser profile named directly is a login chosen on purpose, and is not refused", strayNote, async () => {
  const env = machine("custom-profile", ["acme", "default"], []);
  const r = await cli(["get-tree", KEY], { env: { ...env, FIGMA_USER_DATA_DIR: join(root, "custom-profile", "profile") } });
  // Let through, it goes on to export, which fails here for want of a browser; the error says whose login it was.
  assert.equal(r.code, 1, r.stdout);
  assert.doesNotMatch(r.stderr, /no Figma account chosen/);
  assert.ok(r.stderr.trimEnd().endsWith('[account "default" (source: default, profileOverride: FIGMA_USER_DATA_DIR)]'), r.stderr);
});
