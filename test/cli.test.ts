// The CLI end to end, as a child process on local .fig files (see cli-helpers.ts): the npm script that runs the private
// suite, output through a pipe, the end of the options, a bad snapshot age, dev-status's envelope and list-files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { bigFile, cli, FRAMES, root, type Run, work } from "./cli-helpers.ts";
import { figBytes } from "./fixtures.ts";

const bigFig = bigFile();

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

test("dev-status answers in the list envelope, and a status it does not know is bad usage", async () => {
  // An agent that could not find the status told the user it was unreadable; the command it looks for is this one.
  // Outside the work directory, whose files the list-files test counts.
  const small = join(root, "dev-status.fig");
  writeFileSync(small, figBytes([{ id: "0:1", type: "CANVAS", parent: "0:0", name: "Home" }]));
  const r = await cli(["dev-status", small, "--status", "completed", "--page", "Home"]);
  assert.equal(r.code, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.deepEqual([res.returned, res.total, res.truncated, res.nodes], [0, 0, false, []]);
  assert.ok(res.fileModifiedAt, "dated like the other answers read off a file");
  const bad = await cli(["dev-status", small, "--status", "ready"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /status/);
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
