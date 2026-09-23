// The envelope each tool wraps its answer in (returned/total/truncated/unresolvedInstances) is all an agent has to
// tell a complete answer from a cut one, and figma_get_text's description promises it is always reported. The CLI and
// MCP tests always pass an explicit limit, so no default was ever exercised: 500 could become 5, and truncated a
// hardcoded false, with the whole suite green. These call the handlers directly, on .fig files written here.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, zipSync } from "fflate";
import { compileSchema, encodeBinarySchema, parseSchema } from "kiwi-schema";
import { z } from "zod";
import { guid, nodeChanges, type TestNode } from "./fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "figma-reader-tools-"));
const figs = join(root, "figs");
const listed = join(root, "listed");
for (const d of [join(root, "home"), figs, listed]) mkdirSync(d, { recursive: true });
// tools.ts resolves the account, the cache and the local file directories when it is imported, and registers this
// process with the shared browser state: everything has to point into the temp dir, and the registration be given back.
// HOME is not what Windows reads: os.homedir() takes USERPROFILE there, and the roots are built from APPDATA and
// LOCALAPPDATA, so redirecting HOME alone left these tests writing into the runner's real profile.
process.env.HOME = join(root, "home");
process.env.USERPROFILE = join(root, "home");
process.env.APPDATA = join(root, "home", "AppData", "Roaming");
process.env.LOCALAPPDATA = join(root, "home", "AppData", "Local");
process.env.FIGMA_ACCOUNT = "tools-test";
process.env.FIGMA_READER_CACHE = join(root, "cache");
process.env.FIGMA_FILES_DIRS = listed;
// No browser may be started from a test. Naming one that cannot exist keeps that true whatever a tool decides to do,
// and turns "it tried to export" into an error a test can assert instead of a real browser launch.
process.env.FIGMA_BROWSER_PATH = join(root, "no-such-browser");
for (const k of ["FIGMA_CDP_URL", "FIGMA_USER_DATA_DIR", "FIGMA_SNAPSHOT_MAX_AGE_MIN"]) delete process.env[k];
const { release, tools } = await import("../src/tools.ts");
after(async () => {
  await release();
  rmSync(root, { recursive: true, force: true });
});

const byName = new Map(tools.map((t) => [t.name, t]));
/** A tool's answer as it is returned: text for figma_get_tree, a format the caller chose for the token tools. */
async function body(name: string, args: Record<string, unknown>) {
  const res = await byName.get(name)!.run(args);
  assert.equal(res.content[0].type, "text");
  return (res.content[0] as { type: "text"; text: string }).text;
}
/** A tool's answer, parsed: most tools here answer with one JSON text block. */
const call = async (name: string, args: Record<string, unknown>) => JSON.parse(await body(name, args));

// test/fixtures.ts's kiwi schema carries guid/parentIndex/type/name/key only, so a .fig built from it holds none of
// the fields these counts come from (text, instances, library keys). This one carries those too; field numbers are
// ours to choose, since every .fig ships the schema it was written with.
const SCHEMA = parseSchema(`
  struct GUID { uint sessionID; uint localID; }
  message ParentIndex { GUID guid = 1; string position = 2; }
  message TextData { string characters = 1; }
  message SymbolData { GUID symbolID = 1; }
  message VariableSetMode { GUID id = 1; string name = 2; string sortPosition = 3; }
  message ImageRef { byte[] hash = 1; }
  message Paint { string type = 1; ImageRef image = 2; }
  message NodeChange {
    GUID guid = 1; ParentIndex parentIndex = 2; string type = 3; string name = 4; string key = 5;
    TextData textData = 6; SymbolData symbolData = 7; string sourceLibraryKey = 8; string componentKey = 9;
    VariableSetMode[] variableSetModes = 10; string styleType = 11;
    Paint[] fillPaints = 12; Paint[] strokePaints = 13;
  }
  message Message { NodeChange[] nodeChanges = 1; }
`);
const codec = compileSchema(SCHEMA) as { encodeMessage(m: unknown): Uint8Array };

/** These nodes as a .fig on disk, read by the tools the way a user's local copy is; images by their hash, as a real export carries them. */
function figFile(name: string, nodes: TestNode[], images: Record<string, Uint8Array> = {}): string {
  const chunk = (b: Uint8Array) => {
    const z = deflateSync(b);
    const out = new Uint8Array(4 + z.length);
    new DataView(out.buffer).setUint32(0, z.length, true);
    out.set(z, 4);
    return out;
  };
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode("fig-kiwi"));
  new DataView(header.buffer).setUint32(8, 15, true);
  const canvas = new Uint8Array([
    ...header,
    ...chunk(encodeBinarySchema(SCHEMA)),
    ...chunk(codec.encodeMessage({ nodeChanges: nodeChanges(nodes) })),
  ]);
  const path = join(figs, `${name}.fig`);
  const files: Record<string, Uint8Array> = { "canvas.fig": canvas, "meta.json": new TextEncoder().encode("{}") };
  for (const [hash, bytes] of Object.entries(images)) files[`images/${hash}`] = bytes;
  writeFileSync(path, zipSync(files));
  return path;
}

const page: TestNode = { id: "0:1", type: "CANVAS", parent: "0:0", name: "Page" };
const many = (n: number, make: (i: number) => TestNode): TestNode[] =>
  Array.from({ length: n }, (_, i) => ({ position: String(i).padStart(6, "0"), ...make(i) }));

describe("figma_search", () => {
  // 51 matches for "alpha" and exactly 50 for "beta": one more than the default limit, and exactly it.
  const file = figFile("search", [
    page,
    ...many(51, (i) => ({ id: `1:${i + 1}`, type: "FRAME", parent: "0:1", name: `alpha ${i}` })),
    ...many(50, (i) => ({ id: `2:${i + 1}`, type: "FRAME", parent: "0:1", name: `beta ${i}` })),
  ]);

  // A frame's URL carries its node-id, and fileArg says a tool that takes node_id uses it. Search ignored it, so
  // pasting the URL of one card searched the whole file and reported nothing about having done so.
  // The second page is what makes the scope a filter rather than the only thing there is: the walk is per page, so
  // without it a scoped search walks its node once for every page in the file.
  const scoped = figFile("scoped", [
    page,
    { id: "1:1", type: "FRAME", parent: "0:1", name: "Card A" },
    { id: "1:2", type: "TEXT", parent: "1:1", name: "label", textData: { characters: "wanted here" } },
    { id: "2:1", type: "FRAME", parent: "0:1", name: "Card B" },
    { id: "2:2", type: "TEXT", parent: "2:1", name: "label", textData: { characters: "wanted there" } },
    { id: "0:2", type: "CANVAS", parent: "0:0", name: "Page 2" },
    { id: "3:1", type: "FRAME", parent: "0:2", name: "Card C" },
    { id: "3:2", type: "TEXT", parent: "3:1", name: "label", textData: { characters: "wanted elsewhere" } },
    // A library component this file has no copy of, so the text pass counts it instead of reading it.
    { id: "3:3", type: "INSTANCE", parent: "3:1", name: "badge", symbolData: { symbolID: guid("9:9") } },
  ]);

  it("searches only the node a URL or node_id names, and says which", async () => {
    const all = await call("figma_search", { file: scoped, query: "wanted", include_text: true });
    assert.deepEqual([all.total, all.searchedNode], [3, undefined], "the whole file when nothing scopes it");
    for (const ref of [{ file: scoped, node_id: "1:1" }, { file: scoped, node_id: "1-1" }]) {
      const one = await call("figma_search", { ...ref, query: "wanted", include_text: true });
      assert.deepEqual([one.total, one.searchedNode, one.results[0].id], [1, "1:1", "1:2"], JSON.stringify(ref));
    }
    // The name pass is scoped too, not only the text pass.
    const names = await call("figma_search", { file: scoped, query: "Card", node_id: "1:1" });
    assert.deepEqual([names.total, names.results[0].name], [1, "Card A"]);
  });

  it("walks a scoped search once, on the page its node is on", async () => {
    // The scope is walked inside the per-page loop, so a scope on the second page used to be searched once per page:
    // its hits came back labelled with the first page's name, and every instance it could not resolve was counted
    // again for each page in the file - a number an agent reads as text missing from the answer.
    const r = await call("figma_search", { file: scoped, node_id: "3:1", query: "wanted", include_text: true });
    assert.deepEqual([r.total, r.searchedNode, r.results[0].id], [1, "3:1", "3:2"]);
    assert.equal(r.results[0].page, "Page 2", "the page the scope is on, not the first one walked");
    assert.equal(r.unresolvedInstances, 1, "one instance, counted once");
  });

  it("takes the node from a pasted URL, which is the way a frame is usually named", async () => {
    // Passing node_id explicitly is the rare case: a person or an agent pastes the URL Figma's "Copy link to
    // selection" gives them, whose node-id is the only thing saying which frame was meant. Asserting only the
    // explicit argument left the whole URL path unpinned, so scoping could be lost on the way anyone really uses it.
    const key = "SCOPEDKEY12";
    // FIGMA_FILES_DIRS is shared with the list-files tests, which count what is in it, so this leaves nothing behind.
    const local = join(listed, `Scoped [${key}].fig`);
    copyFileSync(scoped, local);
    try {
      const url = `https://www.figma.com/design/${key}/Scoped?node-id=1-1`;
      const r = await call("figma_search", { file: url, query: "wanted", include_text: true });
      assert.deepEqual([r.searchedNode, r.total, r.results[0].id], ["1:1", 1, "1:2"]);
      // An explicit node_id still wins over the one in the URL.
      const explicit = await call("figma_search", { file: url, query: "wanted", include_text: true, node_id: "2:1" });
      assert.deepEqual([explicit.searchedNode, explicit.results[0].id], ["2:1", "2:2"]);
    } finally {
      rmSync(local, { force: true });
    }
  });

  it("returns 50 by default and says what it left out", async () => {
    const r = await call("figma_search", { file, query: "alpha" });
    assert.deepEqual([r.returned, r.total, r.truncated, r.results.length], [50, 51, true, 50]);
  });

  it("marks a characters preview it had to cut", async () => {
    const long = "w".repeat(200);
    const edge = "e".repeat(120);
    const texts = figFile("preview", [
      page,
      { id: "1:1", type: "TEXT", parent: "0:1", name: "long", textData: { characters: long } },
      { id: "1:2", type: "TEXT", parent: "0:1", name: "edge", textData: { characters: edge } },
    ]);
    // The string used to be cut mid-word with no mark, next to a truncated: false that is about the result count.
    const [hitByName, hitByText] = await Promise.all([
      call("figma_search", { file: texts, query: "long" }),
      call("figma_search", { file: texts, query: "w{150}", regex: true, include_text: true }),
    ]);
    for (const r of [hitByName, hitByText]) {
      assert.equal(r.truncated, false);
      assert.equal(r.results[0].characters, `${"w".repeat(120)}...`);
      assert.equal(r.results[0].charactersTruncated, true);
    }
    const whole = await call("figma_search", { file: texts, query: "edge" });
    assert.deepEqual([whole.results[0].characters, whole.results[0].charactersTruncated], [edge, undefined]);
  });

  // A page shaped like a product file: a frame, a text layer named after its own content, a component with text in
  // it, an instance of that component, and an instance whose main component is not in the file.
  const mixed = figFile("search-mixed", [
    page,
    { id: "1:1", type: "FRAME", parent: "0:1", name: "Card" },
    { id: "1:2", type: "TEXT", parent: "1:1", name: "Label", textData: { characters: "Label of the card" } },
    { id: "3:1", type: "INSTANCE", parent: "1:1", name: "button", symbolData: { symbolID: guid("2:1") } },
    { id: "4:1", type: "INSTANCE", parent: "1:1", name: "ghost", symbolData: { symbolID: guid("9:9") } },
    { id: "2:1", type: "SYMBOL", parent: "0:1", name: "Button" },
    { id: "2:2", type: "TEXT", parent: "2:1", name: "caption", textData: { characters: "Save" } },
  ]);

  it("tells the truth about a hit that both passes found, and about text it never looked at", async () => {
    const both = await call("figma_search", { file: mixed, query: "Label", include_text: true });
    // 1:2 matches by name and again by its content. The second record used to be dropped, so the same node came
    // back with or without where it renders depending on which pass had found it.
    assert.equal(both.total, 1);
    const hit = both.results[0];
    assert.deepEqual([hit.id, hit.name, hit.characters, hit.via, hit.frame], ["1:2", "Label", "Label of the card", "direct", "Card"]);
    // One instance here points at a component the file does not hold: that is what the count is for.
    assert.equal(both.unresolvedInstances, 1);

    // Text that exists only inside an instance is found, and tagged with the component it renders through.
    const inside = await call("figma_search", { file: mixed, query: "Save", include_text: true });
    const rendered = inside.results.find((r: { id: string }) => r.id === "3:1/2:2");
    assert.deepEqual([rendered?.via, rendered?.component], ["instance", "Button"]);

    // types without TEXT turns the text pass off. Reporting 0 unresolved there claimed nothing was missing from
    // text nobody had read; with no types at all the same file reports the one that is.
    const frames = await call("figma_search", { file: mixed, query: "Card", include_text: true, types: ["FRAME"] });
    assert.deepEqual([frames.total, frames.unresolvedInstances], [1, undefined]);
    // An empty list is no filter at all: as a filter it would match nothing.
    assert.equal((await call("figma_search", { file: mixed, query: "Card", types: [] })).total, 1);
  });

  it("is not truncated when exactly the limit matched", async () => {
    const r = await call("figma_search", { file, query: "beta" });
    assert.deepEqual([r.returned, r.total, r.truncated], [50, 50, false]);
    const one = await call("figma_search", { file, query: "beta", limit: 1 });
    assert.deepEqual([one.returned, one.total, one.truncated], [1, 50, true]);
  });
});

// A tool whose schema promises json/css/dtcg must answer in that format even when there is nothing to say: an
// English sentence threw SyntaxError: Unexpected token 'N' in every client that parsed the answer it was promised.
describe("an empty result", () => {
  const empty = figFile("no-tokens", [page, { id: "1:1", type: "FRAME", parent: "0:1", name: "Card" }]);
  const collections = figFile("collections", [
    page,
    { id: "5:1", type: "VARIABLE_SET", parent: "0:1", name: "Core", variableSetModes: [{ id: guid("1:1"), name: "Light", sortPosition: "a" }] },
    { id: "5:2", type: "VARIABLE_SET", parent: "0:1", name: "Brand", variableSetModes: [{ id: guid("1:2"), name: "Mode 1", sortPosition: "a" }] },
  ]);
  it("is still json, dtcg or css, whichever was asked for", async () => {
    assert.deepEqual(JSON.parse(await body("figma_get_variables", { file: empty })), []);
    assert.deepEqual(JSON.parse(await body("figma_get_variables", { file: empty, format: "dtcg" })), {});
    assert.deepEqual(JSON.parse(await body("figma_get_styles", { file: empty })), []);
    // Empty CSS is a stylesheet that declares nothing, which is still a stylesheet.
    for (const name of ["figma_get_variables", "figma_get_styles"]) {
      const css = (await body(name, { file: empty, format: "css" })).trim();
      assert.ok(css === "" || /\{\s*\}$/.test(css), `${name}: ${css}`);
      assert.doesNotMatch(css, /--/, name);
    }
  });

  it("says a collection name matched nothing instead of reporting the file empty", async () => {
    // A --collection typo answered "No variables found in this file", so an agent gave up on a file full of them.
    await assert.rejects(
      body("figma_get_variables", { file: collections, collection: "Cor" }),
      /no collection named "Cor"; collections: "Core", "Brand"/,
    );
    const one = JSON.parse(await body("figma_get_variables", { file: collections, collection: "Core" }));
    assert.deepEqual(one.map((c: { name: string }) => c.name), ["Core"]);
  });
});

describe("figma_get_styles", () => {
  it("lets a style type this tool returns be asked for", async () => {
    // tokens.ts emits STROKE styles and figma_load_file counts them, but the type filter was an enum of four names
    // without it: --type STROKE was a usage error for a kind of style the tool itself returns.
    const styled = figFile("styles", [
      page,
      { id: "6:1", type: "STYLE", parent: "0:1", name: "Border/Default", styleType: "STROKE" },
      { id: "6:2", type: "STYLE", parent: "0:1", name: "Text/Body", styleType: "TEXT" },
    ]);
    const args = { file: styled, type: "STROKE" };
    assert.ok(z.object(byName.get("figma_get_styles")!.shape).strict().safeParse(args).success, "the CLI and MCP both refuse what this shape refuses");
    assert.deepEqual(
      JSON.parse(await body("figma_get_styles", args)).map((s: { name: string; type: string }) => [s.type, s.name]),
      [["STROKE", "Border/Default"]],
    );
  });

});

describe("figma_get_text", () => {
  // 501 strings: one more than the default limit.
  const file = figFile("text", [
    page,
    ...many(501, (i) => ({ id: `1:${i + 1}`, type: "TEXT", parent: "0:1", name: `t ${i}`, textData: { characters: `line ${i}` } })),
  ]);

  it("returns 500 by default, reporting the total and that it was cut", async () => {
    const r = await call("figma_get_text", { file });
    assert.deepEqual([r.returned, r.total, r.truncated, r.text.length], [500, 501, true, 500]);
    assert.deepEqual([r.unresolvedInstances, r.unresolved, r.unresolvedComponentsOmitted], [0, undefined, undefined]);
    assert.equal(r.text[0].text, "line 0");
  });

  it("is not truncated when the limit is the number of strings", async () => {
    const r = await call("figma_get_text", { file, limit: 501 });
    assert.deepEqual([r.returned, r.total, r.truncated], [501, 501, false]);
  });

  it("counts every instance whose text is missing and groups them by component", async () => {
    // Each instance points at a main component this file does not hold, so none of their text can be resolved.
    const missing = figFile("missing", [
      page,
      ...many(25, (i) => ({ id: `1:${i + 1}`, type: "INSTANCE", parent: "0:1", name: `card ${i}`, symbolData: { symbolID: guid(`9:${i + 1}`) } })),
    ]);
    const r = await call("figma_get_text", { file: missing });
    assert.deepEqual([r.returned, r.total, r.truncated, r.unresolvedInstances], [0, 0, false, 25]);
    assert.equal(r.unresolved.length, 20, "the listing is capped at 20 groups");
    // The description promises each missing component once; the ones past the cap used to be dropped with no note.
    assert.equal(r.unresolvedComponentsOmitted, 5);
    assert.match(r.unresolved[0].reason, /main component is not present in this file/);
  });
});

describe("figma_list_files", () => {
  it("returns 30 by default, and is truncated only past that", async () => {
    for (let i = 0; i < 30; i++) writeFileSync(join(listed, `File ${i}.fig`), "x");
    const exact = await call("figma_list_files", {});
    assert.deepEqual([exact.returned, exact.total, exact.truncated, exact.files.length], [30, 30, false, 30]);
    writeFileSync(join(listed, "File 30.fig"), "x");
    const over = await call("figma_list_files", {});
    assert.deepEqual([over.returned, over.total, over.truncated], [30, 31, true]);
  });

  it("answers a query that matched nothing with the envelope, not a sentence", async () => {
    // It used to answer English, which a client parsing the promised JSON threw on. What that sentence said - how
    // many files there are in all, and where they were looked for - is in the envelope instead.
    const none = await call("figma_list_files", { query: "nothing here" });
    assert.deepEqual([none.returned, none.total, none.truncated, none.totalUnfiltered], [0, 0, false, 31]);
    assert.deepEqual([none.files, none.searchedDirs], [[], [listed]]);
  });
});

// An answer read from a copy is only as current as that copy, and "fresh" is not something a reader can check: a
// time is. But the file's time is not the same claim in both directions. A snapshot this tool exported was written
// the instant it was taken, so its mtime is the export. A .fig the user supplied carries only when that copy was
// written: cp, rsync, unzip, a Drive sync, a re-download and git clone all reset it - test/files/real-export.fig
// holds data from 12:38 and reported "exported 15 minutes ago" because cloning rewrote its mtime. So the two are
// reported under different names, and only ours claims to be an export.
describe("dating a result", () => {
  const file = figFile("dated", [
    page,
    { id: "1:1", type: "TEXT", parent: "0:1", name: "Label", textData: { characters: "hi" } },
  ]);
  const taken = new Date("2024-03-04T05:06:07.000Z");
  utimesSync(file, taken, taken);

  it("dates a local .fig by its file time, without claiming to have exported it", async () => {
    for (const [name, args] of [
      ["figma_load_file", {}],
      ["figma_get_node", { node_id: "0:1" }],
      ["figma_search", { query: "Label" }],
      ["figma_get_text", {}],
      ["figma_token_usage", {}],
      ["figma_get_components", {}],
    ] as [string, Record<string, unknown>][]) {
      const r = await call(name, { file, ...args });
      assert.equal(r.fileModifiedAt, taken.toISOString(), name);
      assert.equal(r.exportedAt, undefined, `${name} called a file it did not export a snapshot`);
    }
    // The age of a copy is not the age of the design, so nothing here reports one for a file we did not export.
    const loaded = await call("figma_load_file", { file });
    assert.deepEqual([loaded.source, loaded.snapshotAgeMinutes], ["local", undefined]);
  });

  it("follows the file, so a copy replaced on disk is not still dated by the old one", async () => {
    const again = new Date("2025-11-12T13:14:15.000Z");
    utimesSync(file, again, again);
    assert.equal((await call("figma_load_file", { file })).fileModifiedAt, again.toISOString());
  });

  it("refuses to answer a refresh on a file key from the local copy of it", async () => {
    // A key is served from a local "<name> [<key>].fig" when there is one, which is what makes a read cheap; refresh
    // is the only way to say "not that copy, the live file". This is the one path where a refresh could be answered
    // from a file on disk without anyone noticing, since the answer looks exactly like a fresh one.
    const key = "ABCDEF123456";
    const local = join(listed, `Design [${key}].fig`);
    copyFileSync(figFile("keyed", [page, { id: "1:1", type: "FRAME", parent: "0:1", name: "Card" }]), local);
    const served = await call("figma_load_file", { file: key });
    assert.deepEqual([served.source, served.path, served.key], ["local", local, key]);
    // With refresh it exports instead, which here is a browser that cannot start rather than a stale answer.
    await assert.rejects(byName.get("figma_load_file")!.run({ file: key, refresh: true }), /browser/i);
  });

  it("says on the result that a refresh could not be honoured for a path", async () => {
    // refresh has nothing to export a path from, and it used to be dropped in silence: an agent that asked for live
    // data got a file of any age back with nothing on it to say the request was ignored.
    const r = await call("figma_search", { file, query: "Label", refresh: true });
    assert.equal(r.refreshIgnored, true);
    assert.equal((await call("figma_search", { file, query: "Label" })).refreshIgnored, undefined);
  });
});

describe("figma_get_components", () => {
  it("lists the library components used, most used first", async () => {
    // The instances are declared middle, rare, common, and componentUses walks the node changes in that order, so
    // the map fills in an order the sort has to undo. It used to fill in the order the assertion expected, and the
    // test passed with the sort deleted: it pinned the fixture, not the rule.
    const file = figFile("components", [
      page,
      { id: "2:1", type: "SYMBOL", parent: "0:1", name: "Rare", key: "kr", componentKey: "kr", sourceLibraryKey: "lib" },
      { id: "2:2", type: "SYMBOL", parent: "0:1", name: "Common", key: "kc", componentKey: "kc", sourceLibraryKey: "lib" },
      { id: "2:3", type: "SYMBOL", parent: "0:1", name: "Middle", key: "km", componentKey: "km", sourceLibraryKey: "lib" },
      ...many(2, (i) => ({ id: `3:${i + 1}`, type: "INSTANCE", parent: "0:1", name: `middle ${i}`, symbolData: { symbolID: guid("2:3") } })),
      { id: "4:1", type: "INSTANCE", parent: "0:1", name: "rare", symbolData: { symbolID: guid("2:1") } },
      ...many(3, (i) => ({ id: `5:${i + 1}`, type: "INSTANCE", parent: "0:1", name: `common ${i}`, symbolData: { symbolID: guid("2:2") } })),
    ]);
    const r = await call("figma_get_components", { file });
    // A library component is reported by how much the file leans on it, so the order is the point.
    assert.deepEqual(r.libraryComponentsUsed.map((c: { name: string; instances: number }) => [c.name, c.instances]), [["Common", 3], ["Middle", 2], ["Rare", 1]]);
    assert.deepEqual(r.components.map((c: { name: string }) => c.name).sort(), ["Common", "Middle", "Rare"]);
  });
});

describe("figma_export_image_fills", () => {
  it("writes each image once, from fills and strokes alike, and never implies a layer count it capped", async () => {
    const shared = "aa".repeat(20);
    const bordered = "bb".repeat(20);
    const gone = "cc".repeat(20);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const paint = (hash: string) => ({ type: "IMAGE", image: { hash: [...Buffer.from(hash, "hex")] } });
    const file = figFile(
      "images",
      [
        page,
        ...many(6, (i) => ({ id: `1:${i + 1}`, type: "FRAME", parent: "0:1", name: `card ${i}`, fillPaints: [paint(shared)] })),
        // A photo used as a border, which is an image use like any other: only fillPaints used to be walked.
        { id: "2:1", type: "FRAME", parent: "0:1", name: "framed", strokePaints: [paint(bordered)] },
        { id: "3:1", type: "FRAME", parent: "0:1", name: "placeholder", fillPaints: [paint(gone)] },
      ],
      { [shared]: png, [bordered]: png },
    );
    const out = join(root, "exported");
    const written = await call("figma_export_image_fills", { file, out_dir: out });
    const entry = (hash: string) => written.find((e: { hash: string }) => e.hash === hash);
    assert.deepEqual(written.map((e: { hash: string }) => e.hash).sort(), [shared, bordered, gone].sort());

    // usedBy is a sample of five, so the entry says how many layers there really are.
    assert.equal(entry(shared).usedBy.length, 5);
    assert.equal(entry(shared).usedByTotal, 6);
    assert.equal(entry(shared).path, join(out, `${shared}.png`), "named by hash, typed from the magic bytes");
    assert.equal(readFileSync(entry(shared).path).length, png.length);

    assert.deepEqual([entry(bordered).usedBy, entry(bordered).usedByTotal], [["framed"], undefined]);
    // The file carries no bytes for this one, so it is reported rather than written or dropped.
    assert.deepEqual(entry(gone), { hash: gone, missing: true, usedBy: ["placeholder"] });
  });
});

// What an agent gets when it passes nothing but the file. Every one of these is a cut-off: too small and the answer
// silently misses what was asked about, too large and it floods the caller's context.
describe("the defaults", () => {
  const chain = (n: number, from: string) =>
    many(n, (i) => ({ id: `1:${i + 1}`, type: "FRAME", parent: i ? `1:${i}` : from, name: `level ${i + 1}` }));

  it("show a page, its top-level layers and one level under those", async () => {
    const file = figFile("tree", [page, ...chain(4, "0:1")]);
    const tree = await body("figma_get_tree", { file });
    // Three levels from a document start, not two: with no node_id the pages themselves are level 0.
    assert.deepEqual(tree.split("\n").map((l) => l.trim().split(" ")[1]), ["0:1", "1:1", "1:2"]);
    // The layer the cut-off stopped at says what is under it, so nothing is missing in silence.
    assert.match(tree, /- 1:2 FRAME "level 2" \(1 children\)/);
    assert.equal(await body("figma_get_tree", { file, node_id: "1:1", depth: 0 }), '- 1:1 FRAME "level 1" (1 children)');
  });

  it("give a node three levels of children, and refuse to answer with 200 KB", async () => {
    const file = figFile("node-depth", [page, ...chain(5, "0:1")]);
    let node = await call("figma_get_node", { file, node_id: "1:1" });
    const seen: string[] = [];
    for (; node; node = node.children?.[0]) {
      seen.push(node.id);
      if (!node.children) assert.equal(node.childCount, 1, "the level below the cut-off is counted, not dropped");
    }
    assert.deepEqual(seen, ["1:1", "1:2", "1:3", "1:4"]);

    // A subtree that would answer with a quarter of a megabyte is refused, with the two ways out of it named.
    const wide = figFile("node-wide", [
      page,
      { id: "1:1", type: "FRAME", parent: "0:1", name: "Wide" },
      ...many(400, (i) => ({ id: `2:${i + 1}`, type: "FRAME", parent: "1:1", name: `${i}-${"n".repeat(500)}` })),
    ]);
    await assert.rejects(body("figma_get_node", { file: wide, node_id: "1:1" }), /result is \d+KB; use a smaller depth or a deeper node_id/);
    assert.equal(JSON.parse(await body("figma_get_node", { file: wide, node_id: "1:1", depth: 0 })).childCount, 400);
  });
});
