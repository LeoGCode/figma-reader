// The CLI's argument parsing as search exercises it, end to end (see cli-helpers.ts): a --help where a value belongs,
// a page that does not exist, empty and mistyped lists, and when a query is a pattern.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bigFile, cli, FRAMES } from "./cli-helpers.ts";

const bigFig = bigFile();

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
