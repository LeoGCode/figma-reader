// The project's excludePages from the command line, end to end (see cli-helpers.ts): search, diff and changes apply
// it, --exclude-page replaces it and --no-exclude-page turns it off; and diff's and changes' positionals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { big, bigFile, cli, FRAMES, root } from "./cli-helpers.ts";
import { figBytes } from "./fixtures.ts";

const bigFig = bigFile();

test("search skips the project's excludePages, --exclude-page replaces them, and --no-exclude-page turns them off", async () => {
  const proj = join(root, "excluding");
  mkdirSync(proj);
  writeFileSync(join(proj, ".figma-reader.json"), JSON.stringify({ excludePages: ["Home"] }));
  const run = (args: string[]) => cli(args, { cwd: proj });
  const q = async (...args: string[]) => {
    const r = await run(["search", bigFig, "frame", "--limit", "1", ...args]);
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const byDefault = await q();
  assert.deepEqual([byDefault.total, byDefault.results[0].page, byDefault.excludedPages], [FRAMES / 2, "Settings", ["Home"]]);
  assert.equal(byDefault.excludedPagesFrom, join(proj, ".figma-reader.json"));
  const own = await q("--exclude-page", "Settings");
  assert.deepEqual([own.total, own.results[0].page, own.excludedPages, own.excludedPagesFrom], [FRAMES / 2, "Home", ["Settings"], undefined]);
  // Turning the default off took --json '{"exclude_pages":[]}': an empty flag is bad usage, as it is for every list,
  // so that a value left empty by mistake cannot do it. --no-exclude-page (or -pages) says it on purpose.
  for (const off of [["--no-exclude-page"], ["--no-exclude-pages"], ["--json", '{"exclude_pages":[]}']]) {
    const all = await q(...off);
    assert.deepEqual([all.total, all.excludedPages], [FRAMES, undefined], off.join(" "));
  }
  const empty = await run(["search", bigFig, "frame", "--exclude-page="]);
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /--exclude-page needs at least one value; --no-exclude-page gives an empty list/);
  const both = await run(["search", bigFig, "frame", "--no-exclude-page", "--exclude-page", "Settings"]);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /--no-exclude-page gives exclude_pages as an empty list, but it was also given \["Settings"\]/);
  // diff and changes apply the same default, and the same flag turns it off.
  for (const args of [["diff", bigFig, bigFig], ["changes", bigFig, "7d"]]) {
    const r = await run(args);
    assert.deepEqual([r.code, JSON.parse(r.stdout).excludedPages], [0, ["Home"]], r.stderr);
    const off = await run([...args, "--no-exclude-page"]);
    assert.deepEqual([off.code, JSON.parse(off.stdout).excludedPages], [0, undefined], off.stderr);
  }
});

test("diff takes the older file first, and changes its since as a flag or a positional", async () => {
  // Not in the work directory, whose .fig files list-files counts.
  mkdirSync(join(root, "diff"));
  const smaller = join(root, "diff", "smaller.fig");
  writeFileSync(smaller, figBytes(big.slice(0, 3)));
  const r = await cli(["diff", bigFig, smaller, "--limit", "1"]);
  assert.equal(r.code, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.deepEqual([d.old.path, d.new.path, d.counts.layersRemoved, d.layers.removed.length], [bigFig, smaller, FRAMES - 1, 1]);
  const flag = await cli(["changes", smaller, "--since", "7d"]);
  const positional = await cli(["changes", smaller, "7d"]);
  assert.equal(flag.code, 0, flag.stderr);
  assert.deepEqual(Object.keys(JSON.parse(flag.stdout)), Object.keys(JSON.parse(positional.stdout)));
  const missing = await cli(["changes", smaller]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /missing <since>/);
});
