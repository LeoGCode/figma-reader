// figma-reader batch, run in this process against the real tools so that decodes can be counted: a batch exists to
// decode each file once (while at most four are in play), and one that decoded per line would answer exactly the
// same, only as slowly as separate processes. test/cli.test.ts runs the command itself, over stdin.
import { after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { FigDocument } from "../src/fig-file.ts";
import { FigmaWeb } from "../src/figma-web.ts";
import { figBytes, type TestNode } from "./fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "figma-reader-batch-"));
const listed = join(root, "listed");
for (const d of [join(root, "home"), join(root, "tmp"), listed]) mkdirSync(d, { recursive: true });
// As in test/tools.test.ts: tools.ts resolves the account, the cache and the local file directories when it is
// imported, so all of it points into the temp dir, and no browser can be started. The temp dir too, for the images a
// batch writes where nobody gave it a path: TMPDIR, and TEMP and TMP, which are what Windows reads.
process.env.HOME = join(root, "home");
process.env.USERPROFILE = join(root, "home");
process.env.APPDATA = join(root, "home", "AppData", "Roaming");
process.env.LOCALAPPDATA = join(root, "home", "AppData", "Local");
for (const k of ["TMPDIR", "TEMP", "TMP"]) process.env[k] = join(root, "tmp");
process.env.FIGMA_ACCOUNT = "batch-test";
process.env.FIGMA_READER_CACHE = join(root, "cache");
process.env.FIGMA_FILES_DIRS = listed;
process.env.FIGMA_BROWSER_PATH = join(root, "no-such-browser");
for (const k of ["FIGMA_CDP_URL", "FIGMA_USER_DATA_DIR", "FIGMA_SNAPSHOT_MAX_AGE_MIN"]) delete process.env[k];
const { release, tools } = await import("../src/tools.ts");
const { runBatch } = await import("../src/batch.ts");
after(async () => {
  await release();
  rmSync(root, { recursive: true, force: true });
});

const nodes: TestNode[] = [
  { id: "0:1", type: "CANVAS", parent: "0:0", name: "Home" },
  { id: "1:1", type: "FRAME", parent: "0:1", name: "Card" },
  { id: "1:2", type: "FRAME", parent: "1:1", name: "Inner" },
];
const fig = (name: string, list = nodes) => {
  const path = join(root, `${name}.fig`);
  writeFileSync(path, figBytes(list));
  return path;
};
const a = fig("a");
const b = fig("b", [...nodes, { id: "2:1", type: "FRAME", parent: "0:1", name: "Only in b" }]);
const line = (tool: string, args?: object) => JSON.stringify(args === undefined ? { tool } : { tool, args });

/** Run a batch on these tools and collect what it writes, parsed. */
async function batch(lines: AsyncIterable<string> | Iterable<string>, using = tools) {
  const out: any[] = [];
  const summary = await runBatch(lines, using, async (l) => {
    // One JSON value per line, so a line of it is all a reader has to take apart.
    assert.doesNotMatch(l, /\n/);
    out.push(JSON.parse(l));
    return true;
  });
  return { out, ...summary };
}
const byName = new Map(tools.map((t) => [t.name, t]));
const single = async (name: string, args: object) => (await byName.get(name)!.run(args)).content[0] as { type: "text"; text: string };

describe("batch", () => {
  it("decodes each file once however many calls read it", async () => {
    const decode = mock.method(FigDocument, "fromFile");
    try {
      const { out, failed } = await batch([
        line("get-tree", { file: a }),
        line("figma_get_node", { file: a, node_id: "1:1", depth: 0 }),
        line("locate", { file: b, node_ids: ["2:1"] }),
        line("get-text", { file: a }),
        line("search", { file: b, query: "Only" }),
        line("get-node", { file: a, node_id: "9:9" }),
        line("load-file", { file: a }),
      ]);
      assert.deepEqual(failed, [5]);
      assert.equal(out.length, 7);
      // Two files, two decodes: a call that fails on the decoded file costs no decode of its own either.
      assert.deepEqual(decode.mock.calls.map((c) => c.arguments[1]).sort(), [a, b].map((p) => realpathSync(p)).sort());
    } finally {
      decode.mock.restore();
    }
  });

  it("reads a file again once it has changed, rather than answering from the old decode", async () => {
    const path = fig("changing");
    const decode = mock.method(FigDocument, "fromFile");
    // Each line is handed over only when asked for, so the file can be replaced between two calls.
    async function* lines() {
      yield line("locate", { file: path, node_ids: ["3:1"] });
      writeFileSync(path, figBytes([...nodes, { id: "3:1", type: "FRAME", parent: "0:1", name: "Added" }]));
      // The stamp is mtime and size; a later mtime keeps a same-sized rewrite within the clock's tick from hiding.
      const later = new Date(Date.now() + 60_000);
      utimesSync(path, later, later);
      yield line("locate", { file: path, node_ids: ["3:1"] });
      yield line("locate", { file: path, node_ids: ["3:1"] });
    }
    try {
      const { out } = await batch(lines());
      assert.deepEqual(out.map((o) => o.result.found), [0, 1, 1]);
      assert.equal(decode.mock.callCount(), 2);
    } finally {
      decode.mock.restore();
    }
  });

  it("serves a key and the path of the local copy it names from one decode", async () => {
    // A key is served from '<name> [<key>].fig' under FIGMA_FILES_DIRS, and decodes are kept by real path, so the
    // two spellings an agent mixes in one task share it.
    const key = "BATCHKEY1234";
    const local = join(listed, `App [${key}].fig`);
    copyFileSync(a, local);
    const decode = mock.method(FigDocument, "fromFile");
    try {
      const { out, failed } = await batch([line("locate", { file: key, node_ids: ["1:1"] }), line("locate", { file: local, node_ids: ["1:1"] })]);
      assert.deepEqual([failed, out.map((o) => o.result.found)], [[], [1, 1]]);
      assert.equal(decode.mock.callCount(), 1);
    } finally {
      decode.mock.restore();
      rmSync(local, { force: true });
    }
  });

  it("reads a snapshot by its key and by its path from one decode, dating each the way it was named", async () => {
    // A task pins itself to one snapshot by passing its path after reading by key, and the two names decoded the same
    // file twice. How the file was named still decides the date: by key it is our export, by path a file like any.
    const cache = join(root, "cache", "accounts", "batch-test");
    mkdirSync(cache, { recursive: true });
    const snapshot = (key: string) => {
      const path = join(cache, `${key}.fig`);
      writeFileSync(path, figBytes(nodes));
      return path;
    };
    const keyFirst = snapshot("KEYFIRST1234");
    const pathFirst = snapshot("PATHFIRST123");
    const decode = mock.method(FigDocument, "fromFile");
    try {
      const { out, failed } = await batch([
        line("locate", { file: "KEYFIRST1234", node_ids: ["1:1"] }),
        line("locate", { file: keyFirst, node_ids: ["1:1"] }),
        line("get-node", { file: keyFirst, node_id: "1:1", depth: 0 }),
        line("locate", { file: pathFirst, node_ids: ["1:1"] }),
        line("locate", { file: "PATHFIRST123", node_ids: ["1:1"] }),
      ]);
      assert.deepEqual(failed, []);
      assert.deepEqual(decode.mock.calls.map((c) => basename(c.arguments[1])), ["KEYFIRST1234.fig", "PATHFIRST123.fig"]);
      const taken = (path: string) => statSync(path).mtime.toISOString();
      const dates = out.map((o) => [o.result.exportedAt, o.result.fileModifiedAt]);
      assert.deepEqual(dates, [
        [taken(keyFirst), undefined],
        [undefined, taken(keyFirst)],
        [undefined, taken(keyFirst)],
        [undefined, taken(pathFirst)],
        [taken(pathFirst), undefined],
      ]);
    } finally {
      decode.mock.restore();
    }
  });

  it("keeps four files decoded, so a batch over more decodes again the one it used longest ago", async () => {
    // The bound the help and the README state: within four files each is decoded once, and a fifth evicts the file
    // used longest ago, which is decoded again when it comes back. A smaller bound would decode the second round
    // again; a larger one would not decode the first file a second time at the end.
    const [f1, f2, f3, f4, f5] = ["held-1", "held-2", "held-3", "held-4", "held-5"].map((name) => fig(name));
    const decode = mock.method(FigDocument, "fromFile");
    try {
      const { failed } = await batch([f1, f2, f3, f4, f1, f2, f3, f4, f5, f1].map((file) => line("locate", { file, node_ids: ["1:1"] })));
      assert.deepEqual(failed, []);
      assert.deepEqual(decode.mock.calls.map((c) => c.arguments[1]), [f1, f2, f3, f4, f5, f1].map((p) => realpathSync(p)));
    } finally {
      decode.mock.restore();
    }
  });

  it("answers each line with what the command alone prints: JSON as a value, text as a string", async () => {
    const { out, failed, answered } = await batch([line("get-tree", { file: a }), line("get-node", { file: a, node_id: "1:1", depth: 0 })]);
    assert.deepEqual([failed, answered], [[], 2]);
    // get-tree's outline is text, and a string is the only faithful way to carry it.
    assert.deepEqual(out[0], { i: 0, ok: true, result: (await single("figma_get_tree", { file: a })).text });
    // The string as get-tree prints it alone, its "# {...}" header line included.
    assert.match(out[0].result, /^# \{"fileModifiedAt":"[^"]+"\}\n- 0:1 PAGE "Home"\n {2}- 1:1 FRAME "Card"/);
    // get-node's JSON is the value itself, so `jq .result.name` reads it without a second parse.
    assert.deepEqual(out[1], { i: 1, ok: true, result: JSON.parse((await single("figma_get_node", { file: a, node_id: "1:1", depth: 0 })).text) });
  });

  it("fails a line alone, and runs the rest", async () => {
    const { out, failed, answered } = await batch([
      "not json",
      line("get-node", { file: a, node_id: "9:9" }),
      line("bogus"),
      line("get-tree", { file: a, nodeId: "1:1" }),
      line("get-tree", { file: a, depth: -1 }),
      JSON.stringify({ tool: "get-tree", arg: { file: a } }),
      "[1, 2]",
      JSON.stringify({ args: { file: a } }),
      line("get-tree", { file: a, node_id: "1:2" }),
    ]);
    assert.equal(answered, 9);
    assert.deepEqual(failed, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(out.map((o) => o.i), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const errors = out.map((o) => o.error);
    assert.match(errors[0], /^not a JSON line: /);
    // A call that fails says what the command alone says on stderr.
    assert.match(errors[1], /^node 9:9 not found in file /);
    assert.equal(errors[2], `unknown tool "bogus". Run 'figma-reader help' for the list.`);
    // As strict as the CLI and the MCP server: an unknown argument is refused, not dropped, which would have answered
    // for the whole document. A bad value is refused the same way.
    assert.match(errors[3], /^invalid arguments for get-tree: .*Unrecognized key: "nodeId"/s);
    assert.match(errors[4], /^invalid arguments for get-tree: .*depth/s);
    // "arg" for "args" would otherwise run the call with no arguments at all.
    assert.match(errors[5], /^unknown key "arg": a line has "tool" and "args" only$/);
    assert.match(errors[6], /^a line is a JSON object/);
    assert.match(errors[7], /^"tool" names the call/);
    assert.deepEqual([out[8].i, out[8].ok], [8, true]);
    assert.match(out[8].result, /^# \{"fileModifiedAt":"[^"]+"\}\n- 1:2 FRAME "Inner"$/);
    for (const o of out.slice(0, 8)) assert.deepEqual(Object.keys(o), ["i", "ok", "error"]);
  });

  it("validates arguments exactly as a single call does", async () => {
    // The same schema, so what one refuses the other refuses: a line can never run with arguments the CLI rejects.
    const shape = z.object(byName.get("figma_locate")!.shape).strict();
    for (const args of [{ file: a }, { file: a, node_ids: [] }, { file: a, node_ids: "1:1" }, { file: a, node_ids: ["1:1"], nodeIds: ["1:1"] }]) {
      assert.equal(shape.safeParse(args).success, false, JSON.stringify(args));
      const { out } = await batch([line("locate", args)]);
      assert.match(out[0].error, /^invalid arguments for locate: /, JSON.stringify(args));
    }
  });

  it("skips blank lines without counting them", async () => {
    const { out, answered } = await batch(["", line("get-tree", { file: a, node_id: "1:2" }), "   ", "\t", line("get-tree", { file: a, node_id: "1:1", depth: 0 })]);
    assert.equal(answered, 2);
    assert.deepEqual(out.map((o) => [o.i, o.ok]), [[0, true], [1, true]]);
  });

  it("refuses login, which waits for a person at a window", async () => {
    let ran = false;
    const login = { ...byName.get("figma_login")!, run: async () => ((ran = true), { content: [] }) };
    for (const name of ["login", "figma_login"]) {
      const { out, failed } = await batch([line(name, { wait_seconds: 60 })], [login]);
      assert.deepEqual(failed, [0]);
      assert.match(out[0].error, /^login is not run in a batch: it waits for a person/);
    }
    assert.equal(ran, false);
  });

  it("writes an image to a file and answers with the path that holds it, never inline", async () => {
    // The real screenshot tool, with only the capture in the browser replaced: the check is that the file a line
    // names holds the image, so the tool's own write is under test along with the batch's.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const capture = mock.method(FigmaWeb.prototype, "copyAsPng", async () => ({ base64: png.toString("base64"), width: 7, height: 1, originalWidth: 7, originalHeight: 1 }));
    const shot = (save_path?: string) => line("screenshot", { file: "SHOTKEY12345", node_id: "1:1", ...(save_path === undefined ? {} : { save_path }) });
    try {
      const { out, failed } = await batch([shot(), shot(""), shot("~/shots/a.png"), shot(join(root, "out", "b.png"))]);
      assert.deepEqual(failed, []);
      assert.equal(capture.mock.callCount(), 4);
      // Without a save path, and with an empty one, which the tool does not write to either, the image goes where the
      // command alone puts it: a private temp file named after it. The empty one was answered with the working
      // directory, where nothing had been saved.
      const temp = new RegExp(`^${join(root, "tmp").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}.*screenshot-.*\\.png$`);
      for (const o of out.slice(0, 2)) assert.match(o.images[0], temp);
      assert.notEqual(out[0].images[0], out[1].images[0]);
      // With one, the tool wrote it there, and the line names where that resolved to, ~ included.
      assert.deepEqual([out[2].images, out[3].images], [[join(root, "home", "shots", "a.png")], [join(root, "out", "b.png")]]);
      for (const o of out) {
        assert.equal(o.images.length, 1);
        assert.deepEqual(readFileSync(o.images[0]), png, o.images[0]);
        assert.match(o.result, /^node 1:1: 7x1/);
        assert.doesNotMatch(JSON.stringify(o), new RegExp(png.toString("base64").slice(0, 8)));
      }
    } finally {
      capture.mock.restore();
    }
  });

  it("stops once nobody reads the answers", async () => {
    let runs = 0;
    const count = { name: "figma_count", description: "", readOnly: true, shape: {}, run: async () => (runs++, { content: [{ type: "text" as const, text: "{}" }] }) };
    const summary = await runBatch([line("count"), line("count"), line("count")], [count], async () => false);
    assert.deepEqual([summary.answered, runs], [1, 1]);
  });
});
