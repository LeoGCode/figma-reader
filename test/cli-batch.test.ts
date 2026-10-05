// batch, locate and help end to end (see cli-helpers.ts): one JSON line per call, the exit codes, what help says once
// for every command, and locate's required --node-ids.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bigFile, cli } from "./cli-helpers.ts";

const bigFig = bigFile();

test("batch answers each stdin line with a JSON line, and exits 1 when any call failed", async () => {
  const calls = [
    JSON.stringify({ tool: "locate", args: { file: bigFig, node_ids: ["1-1", "1:2", "99:99"] } }),
    JSON.stringify({ tool: "get-tree", args: { file: bigFig, node_id: "1:1", depth: 0 } }),
    "{not json",
    JSON.stringify({ tool: "get-node", args: { file: bigFig, node_id: "99:99" } }),
  ];
  const r = await cli(["batch"], { input: `${calls.join("\n")}\n` });
  assert.equal(r.code, 1, r.stderr);
  const out = r.stdout.trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(out.map((o) => [o.i, o.ok]), [[0, true], [1, true], [2, false], [3, false]]);
  assert.deepEqual([out[0].result.found, out[0].result.missing], [2, 1]);
  assert.match(out[1].result, /^# \{"fileModifiedAt":"[^"]+"\}\n- 1:1 FRAME "frame 0"$/);
  // The answers say what failed; stderr says that something did, for a reader who only sees the exit code.
  assert.equal(r.stderr, "figma-reader batch: 2 of 4 calls failed (i = 2, 3)\n");

  // A last line with no newline after it is still a call.
  const ok = await cli(["batch"], { input: calls.slice(0, 2).join("\n") });
  assert.deepEqual([ok.code, ok.stderr, ok.stdout.trimEnd().split("\n").length], [0, "", 2]);
  const none = await cli(["batch"], { input: "" });
  assert.deepEqual([none.code, none.stdout, none.stderr], [0, "", ""]);
});

test("batch is bad usage only when the command itself is", async () => {
  const extra = await cli(["batch", "calls.jsonl"], { input: "" });
  assert.equal(extra.code, 2);
  assert.match(extra.stderr, /batch: unexpected argument "calls.jsonl"; the calls are read from stdin/);
  for (const args of [["help", "batch"], ["batch", "--help"]]) {
    const r = await cli(args, { input: "" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Usage: figma-reader batch < calls\.jsonl\n/, args.join(" "));
  }
  assert.match((await cli(["help"])).stdout, /^ {2}batch +Run tool calls given as JSON lines on stdin/m);
  // The dating rule the dated commands' help points to, once, in the words of the command line.
  const overview = (await cli(["help"])).stdout;
  assert.match(overview, /^Dates: A result read from a file is dated by the copy it answers from\./m);
  assert.match(overview.replace(/\s+/g, " "), /pass --refresh to export it again.*get-tree carries the same fields.*the note --out-file prints/);
  assert.match((await cli(["help", "get-node"])).stdout.replace(/\s+/g, " "), /Dated by exportedAt and account, or fileModifiedAt for a file read from disk, as the server's instructions say \(figma-reader help on the command line\)/);
});

test("help says once what <file> and --refresh take, and names the arguments a batch line gives as lists", async () => {
  // Written out in every command, the two were 7.4 KB of the MCP tool list; each command now says them in a line.
  const overview = (await cli(["help"])).stdout;
  assert.match(overview, /^Files: <file> is a local \.fig path, a Figma file key, or a figma\.com\/design\/\.\.\. URL\./m);
  assert.match(overview.replace(/\s+/g, " "), /--refresh skips both and exports the live file through the browser\. It has no effect when <file> is a path to a \.fig/);
  const search = (await cli(["help", "search"])).stdout;
  assert.match(search.replace(/\s+/g, " "), /<file> A local \.fig path, a Figma file key or a figma\.com\/design\/\.\.\. URL \(see the server's instructions, or figma-reader help\)/);
  assert.match(search, /^ {2}--no-exclude-pages +Give exclude_pages as an empty list$/m);
  // Read off the tools: an agent passed node_ids as "1:2,3:4", the way the flag takes them, and lost the call.
  const batch = (await cli(["help", "batch"])).stdout.replace(/\s+/g, " ");
  assert.match(batch, /a list as a JSON array, even of one value, never as a comma-separated string\. The lists are node_ids \(locate\), types \(search\), exclude_pages \(search, get-text, diff, changes\), fields \(get-text\):/);
});

test("locate takes its ids from --node-ids, and cannot run without them", async () => {
  const r = await cli(["locate", bigFig, "--node-ids", "1-1,99:99", "--node-ids", "nope"]);
  // Ids the file does not have are an answer, not a failed call.
  assert.equal(r.code, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.deepEqual([res.found, res.missing, res.invalid], [1, 1, 1]);
  assert.deepEqual(res.results[0], { id: "1:1", found: true, type: "FRAME", name: "frame 0", page: "Home", path: "Home / frame 0" });
  const without = await cli(["locate", bigFig]);
  assert.equal(without.code, 2);
  assert.match(without.stderr, /^figma-reader locate: missing --node-ids\n/);
});
