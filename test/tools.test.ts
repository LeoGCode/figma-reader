// The envelope each tool wraps its answer in (returned/total/truncated/unresolvedInstances) is all an agent has to
// tell a complete answer from a cut one, and figma_get_text's description promises it is always reported. The CLI and
// MCP tests always pass an explicit limit, so no default was ever exercised: 500 could become 5, and truncated a
// hardcoded false, with the whole suite green. These call the handlers directly, on .fig files written here.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, zipSync } from "fflate";
import { compileSchema, encodeBinarySchema, parseSchema } from "kiwi-schema";
import { z } from "zod";
import { FigDocument } from "../src/fig-file.ts";
import { FigmaWeb } from "../src/figma-web.ts";
import { outline } from "../src/outline.ts";
import { guid, nodeChanges, type TestNode } from "./fixtures.ts";

// Resolved, as in test/cli.test.ts: the project file is found from the working directory, which the kernel reports
// resolved, so on macOS (/var -> /private/var) its path came back under a spelling this test did not build it with.
const root = realpathSync(mkdtempSync(join(tmpdir(), "figma-reader-tools-")));
const figs = join(root, "figs");
const listed = join(root, "listed");
for (const d of [join(root, "home"), figs, listed]) mkdirSync(d, { recursive: true });
// tools.ts resolves the account, the cache and the local file directories when it is imported, and the first call that
// reaches the browser registers this process with the shared browser state: everything has to point into the temp dir,
// and the registration be given back.
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
// The project file is read from the working directory at import too, and one found above it (a developer's own) would
// change what figma_search leaves out. This one makes every search skip a page named "Archive" unless it says
// otherwise; only the fixtures of the exclusion tests have one. "Gone" is in no file at all.
const project = join(root, "project");
mkdirSync(project);
const projectFile = join(project, ".figma-reader.json");
writeFileSync(projectFile, JSON.stringify({ excludePages: ["Archive", "Gone"] }));
const startDir = process.cwd();
process.chdir(project);
const { release, tools } = await import("../src/tools.ts");
after(async () => {
  await release();
  // Windows will not remove the directory a process is standing in.
  process.chdir(startDir);
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
  enum SectionStatus { NONE = 0; BUILD = 1; COMPLETED = 2; }
  message SectionStatusInfo {
    SectionStatus status = 1; uint lastUpdateUnixTimestamp = 2; string description = 3; string userId = 4; SectionStatus prevStatus = 5;
  }
  message EditInfo { uint createdAt = 1; uint lastEditedAt = 2; }
  message NodeChange {
    GUID guid = 1; ParentIndex parentIndex = 2; string type = 3; string name = 4; string key = 5;
    TextData textData = 6; SymbolData symbolData = 7; string sourceLibraryKey = 8; string componentKey = 9;
    VariableSetMode[] variableSetModes = 10; string styleType = 11;
    Paint[] fillPaints = 12; Paint[] strokePaints = 13; SectionStatusInfo sectionStatusInfo = 14;
    EditInfo editInfo = 15;
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

describe("figma_search page exclusion", () => {
  // The archive comes first and holds more hits than the limit, as a real file's archive page did: 77 of a query's 78
  // hits were there. Filtered after the limit, as agents did with jq, the answer was the archive or nothing.
  const archived = figFile("archived", [
    { id: "0:1", type: "CANVAS", parent: "0:0", name: "Archive" },
    ...many(5, (i) => ({ id: `1:${i + 1}`, type: "FRAME", parent: "0:1", name: `request old ${i}` })),
    { id: "0:2", type: "CANVAS", parent: "0:0", name: "Screens" },
    ...many(2, (i) => ({ id: `2:${i + 1}`, type: "FRAME", parent: "0:2", name: `request new ${i}` })),
    { id: "0:3", type: "CANVAS", parent: "0:0", name: "Templates" },
    { id: "3:1", type: "FRAME", parent: "0:3", name: "request template" },
  ]);
  const pages = (r: { results: { page: string }[] }) => [...new Set(r.results.map((h) => h.page))];

  it("skips excluded pages before the limit, so their hits never crowd out the rest", async () => {
    const r = await call("figma_search", { file: archived, query: "request", exclude_pages: ["Archive", "Templates"], limit: 2 });
    assert.deepEqual([r.returned, r.total, r.truncated, pages(r)], [2, 2, false, ["Screens"]]);
    assert.deepEqual([r.excludedPages, r.excludedPagesFrom], [["Archive", "Templates"], undefined]);
  });

  it("applies the project's excludePages when the call names no pages, and says so", async () => {
    const r = await call("figma_search", { file: archived, query: "request", limit: 3 });
    assert.deepEqual([r.returned, r.total, r.truncated, pages(r)], [3, 3, false, ["Screens", "Templates"]]);
    // "Gone" is in the project's list and not in this file: nothing to skip, and nothing to say about it.
    assert.deepEqual([r.excludedPages, r.excludedPagesFrom], [["Archive"], projectFile]);
    // A file with none of those pages is searched whole, with no field claiming anything was left out.
    const plain = figFile("unarchived", [page, { id: "1:1", type: "FRAME", parent: "0:1", name: "request" }]);
    assert.deepEqual(Object.keys(await call("figma_search", { file: plain, query: "request" })).filter((k) => k.startsWith("excluded")), []);
  });

  it("replaces the project's list with the call's, and an empty one searches everything", async () => {
    const own = await call("figma_search", { file: archived, query: "request", exclude_pages: ["Templates"], limit: 3 });
    assert.deepEqual([own.total, pages(own), own.excludedPages, own.excludedPagesFrom], [7, ["Archive"], ["Templates"], undefined]);
    const all = await call("figma_search", { file: archived, query: "request", exclude_pages: [] });
    assert.deepEqual([all.total, all.excludedPages], [8, undefined]);
  });

  it("leaves excluded pages out of the text pass too", async () => {
    // Only the text matches here. A page skipped by the name walk alone was still searched by the text scan, and
    // answered first under a limit of one, next to an excludedPages saying it had not been searched.
    const texts = figFile("archived-text", [
      { id: "0:1", type: "CANVAS", parent: "0:0", name: "Archive" },
      { id: "1:1", type: "TEXT", parent: "0:1", name: "old copy", textData: { characters: "needle in the archive" } },
      { id: "0:2", type: "CANVAS", parent: "0:0", name: "Screens" },
      { id: "2:1", type: "TEXT", parent: "0:2", name: "new copy", textData: { characters: "needle on a screen" } },
    ]);
    for (const args of [{}, { exclude_pages: ["Archive"] }]) {
      const r = await call("figma_search", { file: texts, query: "needle", include_text: true, limit: 1, ...args });
      assert.deepEqual([r.returned, r.total, r.truncated, r.results[0].id, r.excludedPages], [1, 1, false, "2:1", ["Archive"]], JSON.stringify(args));
    }
  });

  it("leaves the default out when page or node_id already says where to look", async () => {
    const page = await call("figma_search", { file: archived, query: "request", page: "Archive" });
    assert.deepEqual([page.total, page.excludedPages], [5, undefined]);
    const node = await call("figma_search", { file: archived, query: "request", node_id: "1:1" });
    assert.deepEqual([node.total, node.searchedNode, node.excludedPages], [1, "1:1", undefined]);
  });

  it("takes a node-id in the file URL as saying where to look, as node_id does", async () => {
    // A pasted frame URL is how a node is usually named. Read as no scope, it brought the project's default in, and
    // a frame on an excluded page was refused as if the call had excluded that page itself.
    const key = "ARCHIVEDKEY1";
    // FIGMA_FILES_DIRS is shared with the list-files tests, which count what is in it, so this leaves nothing behind.
    const local = join(listed, `Archived [${key}].fig`);
    copyFileSync(archived, local);
    try {
      const r = await call("figma_search", { file: `https://www.figma.com/design/${key}/Archived?node-id=1-1`, query: "request" });
      assert.deepEqual([r.total, r.searchedNode, r.results[0].page, r.excludedPages], [1, "1:1", "Archive", undefined]);
    } finally {
      rmSync(local, { force: true });
    }
  });

  it("refuses an exclusion that names no page, or the very page it is asked to search", async () => {
    // A typo excluded nothing and searched the page it meant to skip.
    await assert.rejects(
      call("figma_search", { file: archived, query: "request", exclude_pages: ["Archiv"] }),
      /no page named "Archiv" to exclude; pages: "Archive", "Screens", "Templates"/,
    );
    await assert.rejects(call("figma_search", { file: archived, query: "request", page: "Archive", exclude_pages: ["Archive"] }), /both searched and in exclude_pages/);
    await assert.rejects(
      call("figma_search", { file: archived, query: "request", node_id: "1:1", exclude_pages: ["Archive"] }),
      /node 1:1 is on page "Archive", which exclude_pages leaves out/,
    );
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

// A handoff called 12 node ids "gone" after looking up 5 of them, one process per id: 5 of the other 7 were there.
describe("figma_locate", () => {
  const file = figFile("locate", [
    page,
    { id: "1:1", type: "FRAME", parent: "0:1", name: "Card" },
    { id: "1:2", type: "TEXT", parent: "1:1", name: "Label", textData: { characters: "hi" } },
    { id: "0:2", type: "CANVAS", parent: "0:0", name: "Archive" },
    { id: "2:1", type: "SYMBOL", parent: "0:2", name: "Button" },
  ]);

  it("answers every id, in the order given, with where it is or that it is not there", async () => {
    const r = await call("figma_locate", { file, node_ids: ["1:2", "9:9", "2:1", "0:1"] });
    assert.deepEqual([r.found, r.missing, r.invalid], [3, 1, 0]);
    assert.deepEqual(r.results, [
      { id: "1:2", found: true, type: "TEXT", name: "Label", page: "Page", path: "Page / Card / Label" },
      { id: "9:9", found: false },
      // The type as every other tool reports it, and the page the node is on, not the first one.
      { id: "2:1", found: true, type: "COMPONENT", name: "Button", page: "Archive", path: "Archive / Button" },
      { id: "0:1", found: true, type: "PAGE", name: "Page", page: "Page", path: "Page" },
    ]);
  });

  it("takes the 12-34 spelling of a URL and answers in the 12:34 one", async () => {
    const r = await call("figma_locate", { file, node_ids: ["1-1", "9-9"] });
    assert.deepEqual(r.results.map((e: { id: string; found: boolean }) => [e.id, e.found]), [["1:1", true], ["9:9", false]]);
  });

  it("tells a string that is not a node id from a node the file does not have", async () => {
    // A missing node and a malformed id are different mistakes: counting "x" as missing says the file was searched
    // for something it could never have held.
    const r = await call("figma_locate", { file, node_ids: ["1:1/1:2", "x", "1:1:1", "", "9:9"] });
    assert.deepEqual([r.found, r.missing, r.invalid], [0, 1, 4]);
    // The id get-text and search give text rendered inside an instance is the likeliest one to be handed back, and the
    // error says which part of it is a node.
    assert.equal(r.results[0].id, "1:1/1:2");
    assert.match(r.results[0].error, /not a node id: .*only the instance, 1:1, is a node of the file/);
    for (const e of r.results.slice(1, 4)) assert.match(e.error, /^not a node id: node ids look like 12:34 \(or 12-34\)$/, e.id);
    assert.equal(r.results[4].found, false);
  });

  it("needs at least one id", () => {
    const shape = z.object(byName.get("figma_locate")!.shape).strict();
    assert.equal(shape.safeParse({ file, node_ids: [] }).success, false);
    assert.equal(shape.safeParse({ file, node_ids: ["1:1"] }).success, true);
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

  it("dates a file out_file wrote in the note after the answer, and never in the file", async () => {
    // get-variables and get-styles answer with the artifact itself, so a date or an account inside it would land in
    // a committed tokens.css and change on every run. The note after it says when the copy it came from was read.
    for (const [name, args] of [["figma_get_variables", { format: "css" }], ["figma_get_variables", {}], ["figma_get_styles", {}]] as const) {
      const out = join(root, "written", `${name}-${Object.keys(args).length}.out`);
      const answer = await body(name, { file, ...args, out_file: out });
      const note = `\n\n(written to ${out}; fileModifiedAt ${taken.toISOString()})`;
      assert.ok(answer.endsWith(note), answer);
      assert.equal(readFileSync(out, "utf8"), answer.slice(0, -note.length), `${name}: the file is the answer without its note`);
    }
  });

  it("dates a local .fig by its file time, without claiming to have exported it", async () => {
    for (const [name, args] of [
      ["figma_load_file", {}],
      ["figma_get_node", { node_id: "0:1" }],
      ["figma_search", { query: "Label" }],
      ["figma_get_text", {}],
      ["figma_token_usage", {}],
      ["figma_get_components", {}],
      ["figma_dev_status", {}],
      ["figma_locate", { node_ids: ["1:1"] }],
      ["figma_changes", { since: "7d" }],
    ] as [string, Record<string, unknown>][]) {
      const r = await call(name, { file, ...args });
      assert.equal(r.fileModifiedAt, taken.toISOString(), name);
      assert.equal(r.exportedAt, undefined, `${name} called a file it did not export a snapshot`);
      // No login and no account's cache had any part in reading it, so naming one would claim one did.
      assert.equal(r.account, undefined, `${name} named an account for a file no account read`);
    }
    // The age of a copy is not the age of the design, so nothing here reports one for a file we did not export.
    const loaded = await call("figma_load_file", { file });
    assert.deepEqual([loaded.source, loaded.snapshotAgeMinutes], ["local", undefined]);
    // get-tree answers in text, so it was the one reading tool with nothing to date it by. It now leads with a header
    // line holding the same field, and the outline under it is exactly what it was.
    const [header, ...rest] = (await body("figma_get_tree", { file })).split("\n");
    assert.equal(header, `# ${JSON.stringify({ fileModifiedAt: taken.toISOString() })}`);
    const doc = FigDocument.fromFile("dated", file, taken);
    assert.equal(rest.join("\n"), outline(doc, doc.get(doc.rootId)!, 2, 400));
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

  it("names the snapshot a key was answered from, so a task can stay on that one export", async () => {
    // A key re-exports once its snapshot is past the max age, so a task that keeps passing the key can read two
    // exports and report them as one design. The path load-file names is the way to stay on the first: a path is
    // never exported again, and it dates the answer by the same instant exportedAt did.
    const key = "SNAPSHOT1234";
    const snapshot = join(root, "cache", "accounts", "tools-test", `${key}.fig`);
    mkdirSync(join(root, "cache", "accounts", "tools-test"), { recursive: true });
    copyFileSync(figFile("snapshot", [page, { id: "1:1", type: "FRAME", parent: "0:1", name: "Card" }]), snapshot);
    const taken = new Date(Date.now() - 60_000);
    utimesSync(snapshot, taken, taken);
    const loaded = await call("figma_load_file", { file: key });
    assert.deepEqual([loaded.source, loaded.snapshotPath, loaded.path, loaded.exportedAt], ["web", snapshot, undefined, taken.toISOString()]);
    assert.equal((await call("figma_get_node", { file: loaded.snapshotPath, node_id: "1:1" })).fileModifiedAt, loaded.exportedAt);

    // Past the max age the key exports again (a browser that cannot start, here); the path still answers from disk.
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(snapshot, old, old);
    await assert.rejects(byName.get("figma_get_node")!.run({ file: key, node_id: "1:1" }), /browser/i);
    assert.equal((await call("figma_get_node", { file: snapshot, node_id: "1:1" })).name, "Card");
    // A file the caller already holds is named by path; there is no snapshot of ours to name.
    assert.equal((await call("figma_load_file", { file })).snapshotPath, undefined);
  });

  it("says on the result that a refresh could not be honoured for a path", async () => {
    // refresh has nothing to export a path from, and it used to be dropped in silence: an agent that asked for live
    // data got a file of any age back with nothing on it to say the request was ignored.
    const r = await call("figma_search", { file, query: "Label", refresh: true });
    assert.equal(r.refreshIgnored, true);
    assert.equal((await call("figma_search", { file, query: "Label" })).refreshIgnored, undefined);
    // get-tree takes refresh too, and says so in its header.
    assert.equal(JSON.parse((await body("figma_get_tree", { file, refresh: true })).split("\n")[0].slice(2)).refreshIgnored, true);
  });
});

// A key whose snapshot is in this account's cache is answered the way an export is, minus the browser: so these are
// the answers an export gives. Every one names the account it was read through. An agent run from a scratch
// directory read a client file through the wrong login twice, and nothing in any answer said which login it was.
describe("an answer through the account's snapshot cache", () => {
  const key = "CACHEDKEY123";
  const snapshot = join(root, "cache", "accounts", "tools-test", `${key}.fig`);
  // Made here: the store makes its directory only with its first export, and this snapshot stands for one.
  mkdirSync(join(root, "cache", "accounts", "tools-test"), { recursive: true });
  copyFileSync(figFile("cached", [page, { id: "1:1", type: "TEXT", parent: "0:1", name: "Label", textData: { characters: "hi" } }]), snapshot);
  // Younger than FIGMA_SNAPSHOT_MAX_AGE_MIN's 30, so it is served rather than exported again; in whole seconds, for a
  // filesystem that keeps no finer time.
  const exported = new Date(Math.floor(Date.now() / 1000) * 1000 - 5 * 60_000);
  utimesSync(snapshot, exported, exported);
  const named = { name: "tools-test", source: "FIGMA_ACCOUNT" };
  const label = 'account "tools-test" (source: FIGMA_ACCOUNT)';

  it("names the account beside exportedAt in every dated result", async () => {
    for (const [name, args] of [
      ["figma_load_file", {}],
      ["figma_get_node", { node_id: "0:1" }],
      ["figma_search", { query: "Label" }],
      ["figma_get_text", {}],
      ["figma_token_usage", {}],
      ["figma_get_components", {}],
      ["figma_dev_status", {}],
      ["figma_locate", { node_ids: ["1:1"] }],
      ["figma_changes", { since: "7d" }],
    ] as [string, Record<string, unknown>][]) {
      const r = await call(name, { file: key, ...args });
      assert.equal(r.exportedAt, exported.toISOString(), name);
      assert.deepEqual(r.account, named, name);
    }
    // figma_diff dates each of its two sides, and each side read through the account names it.
    const d = await call("figma_diff", { old: key, new: key });
    assert.deepEqual([d.old.exportedAt, d.old.account, d.new.exportedAt, d.new.account], [exported.toISOString(), named, exported.toISOString(), named]);
    assert.deepEqual((await call("figma_load_file", { file: `https://www.figma.com/design/${key}/Cached` })).account, named, "a URL is the same key");
  });

  it("names the date and the account in the note out_file adds, and puts neither in the file", async () => {
    for (const name of ["figma_get_variables", "figma_get_styles"]) {
      const out = join(root, "written", `${name}-cached.json`);
      const answer = await body(name, { file: key, out_file: out });
      const note = `\n\n(written to ${out}; exportedAt ${exported.toISOString()}, ${label})`;
      assert.ok(answer.endsWith(note), answer);
      assert.equal(readFileSync(out, "utf8"), answer.slice(0, -note.length), name);
      assert.doesNotMatch(readFileSync(out, "utf8"), /exportedAt|tools-test/);
    }
  });

  it("gives get-tree a header with both, and leaves the outline as it was", async () => {
    const [header, ...rest] = (await body("figma_get_tree", { file: key })).split("\n");
    assert.equal(header, `# ${JSON.stringify({ exportedAt: exported.toISOString(), account: named })}`);
    const doc = FigDocument.fromFile(key, snapshot, exported);
    assert.equal(rest.join("\n"), outline(doc, doc.get(doc.rootId)!, 2, 400));
  });

  it("names the account in an error from figma.com as well", async () => {
    // A file that is "not found" there may only be one this login cannot see, so the error is where the account
    // matters most. The export fails here because no browser can start.
    await assert.rejects(
      byName.get("figma_get_tree")!.run({ file: key, refresh: true }),
      (e: Error) => /browser/i.test(e.message) && e.message.endsWith(` [${label}]`),
    );
  });

  it("names it in an error raised after the snapshot was read, too", async () => {
    // A node missing from a cached snapshot is missing from what that login exported: the account is as much the
    // answer's here as in an export that failed. A local file read by path names none, as no account read it.
    await assert.rejects(byName.get("figma_get_node")!.run({ file: key, node_id: "9:9" }), (e: Error) => e.message === `node 9:9 not found in file ${key} [${label}]`);
    await assert.rejects(byName.get("figma_search")!.run({ file: key, query: "x", page: "Nope" }), (e: Error) => e.message.endsWith(` [${label}]`));
    const local = figFile("unnamed", [page]);
    await assert.rejects(byName.get("figma_get_node")!.run({ file: local, node_id: "9:9" }), (e: Error) => /^node 9:9 not found in file [^[]+$/.test(e.message));
  });
});

// What figma.com itself answers, with FigmaWeb's own methods standing in for the browser: the tools' instance resolves
// them through the prototype, so a replacement there is what it calls. Each test puts back what it replaced.
describe("an answer from figma.com", () => {
  const key = "CACHEDKEY123";
  const label = 'account "tools-test" (source: FIGMA_ACCOUNT)';
  const proto = FigmaWeb.prototype as unknown as Record<string, unknown>;
  /** The result's text block: the only one, or the note beside a screenshot's image. */
  const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.find((c) => c.type === "text")!.text!;
  async function standingIn<T>(methods: Record<string, (...a: any[]) => unknown>, body: () => Promise<T>): Promise<T> {
    const saved = Object.fromEntries(Object.keys(methods).map((m) => [m, proto[m]]));
    Object.assign(proto, methods);
    try {
      return await body();
    } finally {
      Object.assign(proto, saved);
    }
  }

  it("ends a screenshot's note with the account it was rendered through", async () => {
    const png = { base64: "iVBORw0KGgo=", width: 40, height: 20, originalWidth: 40, originalHeight: 20 };
    const res = await standingIn({ copyAsPng: async () => png }, () => byName.get("figma_screenshot")!.run({ file: key, node_id: "1:1" }));
    assert.equal(res.content[0].type, "image");
    assert.equal(textOf(res), `node 1:1: 40x20; ${label}`);
  });

  it("names the account beside a web file listing", async () => {
    const files = [{ key: "ABCDEFGHIJ12", name: "App", editorType: "design", teamId: null, updatedAt: "", touchedAt: "", url: "" }];
    const r = JSON.parse(textOf(await standingIn({ recentFiles: async () => files }, () => byName.get("figma_list_files")!.run({ source: "web" }))));
    assert.deepEqual(r.account, { name: "tools-test", source: "FIGMA_ACCOUNT" });
    assert.equal(r.searchedDirs, undefined, "a web listing searched no local directory");
  });

  it("names the account in what login answers and in the error it ends in", async () => {
    // The login check is that login's: a failure of it used to come back as Figma's bare status line.
    await assert.rejects(
      standingIn({ whoami: async () => { throw new Error("GET /api/user: 503 Service Unavailable"); } }, () => byName.get("figma_login")!.run({})),
      (e: Error) => e.message === `GET /api/user: 503 Service Unavailable [${label}]`,
    );
    // The window it opens is for this account, as it came to be chosen.
    const opened = await standingIn({ whoami: async () => null, openLogin: async () => {} }, () => byName.get("figma_login")!.run({}));
    assert.ok(textOf(opened).startsWith(`Login window opened for ${label}. `), textOf(opened));
    const user = { id: "1", handle: "someone", email: "someone@example.com" };
    const done = JSON.parse(textOf(await standingIn({ whoami: async () => user }, () => byName.get("figma_login")!.run({}))));
    assert.deepEqual([done.account, done.loggedIn], [{ name: "tools-test", source: "FIGMA_ACCOUNT" }, true]);
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

describe("figma_dev_status", () => {
  // The schema above declares SectionStatus an enum, as Figma's does, so the handler reads what decoding a real export
  // gives it: the value's name, not its number. 101 frames marked a second apart, and one whose Completed mark came
  // off a second before the first of them.
  const at = 1790848800;
  const file = figFile("dev-status", [
    page,
    ...many(101, (i) => ({
      id: `1:${i + 1}`, type: "FRAME", parent: "0:1", name: `frame ${i}`,
      sectionStatusInfo: { status: "BUILD", prevStatus: "NONE", lastUpdateUnixTimestamp: at + i, userId: "1234567" },
    })),
    { id: "2:1", type: "FRAME", parent: "0:1", name: "unmarked", sectionStatusInfo: { status: "NONE", prevStatus: "COMPLETED", lastUpdateUnixTimestamp: at - 1 } },
  ]);

  it("returns 100 by default, newest change first, and says what it left out", async () => {
    const r = await call("figma_dev_status", { file });
    assert.deepEqual([r.returned, r.total, r.truncated, r.nodes.length], [100, 102, true, 100]);
    assert.deepEqual(r.nodes[0], {
      id: "1:101", type: "FRAME", name: "frame 100", page: "Page", path: "Page / frame 100",
      status: "ready_for_dev", raw: "BUILD", previous: "none", previousRaw: "NONE", changedAt: "2026-10-01T10:01:40.000Z", by: "1234567",
    });
    const all = await call("figma_dev_status", { file, limit: 102 });
    assert.deepEqual([all.returned, all.total, all.truncated], [102, 102, false]);
    assert.deepEqual([all.nodes[101].id, all.nodes[101].status, all.nodes[101].previous, all.nodes[101].previousRaw], ["2:1", "none", "completed", "COMPLETED"]);
  });

  it("filters by status and page, and refuses a page or status that does not exist", async () => {
    const off = await call("figma_dev_status", { file, status: "none", page: "Page" });
    assert.deepEqual([off.total, off.truncated, off.nodes.map((n: { id: string }) => n.id)], [1, false, ["2:1"]]);
    await assert.rejects(body("figma_dev_status", { file, page: "Pag" }), /no page named "Pag"; pages: "Page"/);
    // The CLI and the MCP server both validate against this shape, so a status nobody spells this way is refused there.
    assert.equal(z.object(byName.get("figma_dev_status")!.shape).strict().safeParse({ file, status: "ready" }).success, false);
  });

  it("says how many never-marked records the default left out, and only when it left some out", async () => {
    // A frame ready for dev, and a component carrying the record Figma writes on what nobody marked.
    const quiet = figFile("dev-status-quiet", [
      page,
      { id: "1:1", type: "FRAME", parent: "0:1", name: "Ready", sectionStatusInfo: { status: "BUILD", prevStatus: "NONE", lastUpdateUnixTimestamp: at, userId: "1234567" } },
      { id: "1:2", type: "SYMBOL", parent: "0:1", name: "Icon", sectionStatusInfo: { status: "NONE", prevStatus: "NONE", lastUpdateUnixTimestamp: at } },
    ]);
    const shown = await call("figma_dev_status", { file: quiet });
    assert.deepEqual([shown.total, shown.neverMarked, shown.nodes.map((n: { id: string }) => n.id)], [1, 1, ["1:1"]]);
    assert.deepEqual(Object.keys(shown).slice(-2), ["neverMarked", "nodes"], "beside the counts, before the list");
    // Asked for, they are listed, and nothing was left out to count.
    for (const status of ["any", "none"]) {
      const all = await call("figma_dev_status", { file: quiet, status });
      assert.equal(all.neverMarked, undefined, status);
      assert.ok(all.nodes.some((n: { id: string }) => n.id === "1:2"), status);
    }
    // A file whose every record says something has nothing to count.
    assert.equal((await call("figma_dev_status", { file })).neverMarked, undefined);
  });
});

describe("figma_diff", () => {
  const before = figFile("diff-before", [
    page,
    { id: "1:1", type: "FRAME", parent: "0:1", name: "Login" },
    ...many(101, (i) => ({ id: `2:${i + 1}`, type: "FRAME", parent: "1:1", name: `field ${i}` })),
  ]);
  const after = figFile("diff-after", [page, { id: "1:1", type: "FRAME", parent: "0:1", name: "Sign in" }]);
  const old = new Date("2026-09-25T13:44:10.000Z");
  const now = new Date("2026-10-05T14:15:09.000Z");
  utimesSync(before, old, old);
  utimesSync(after, now, now);

  it("compares two .fig files, each dated as the other tools date a local file", async () => {
    const r = await call("figma_diff", { old: before, new: after });
    assert.deepEqual(r.old, { source: "local", path: before, fileModifiedAt: old.toISOString() });
    assert.deepEqual(r.new, { source: "local", path: after, fileModifiedAt: now.toISOString() });
    assert.deepEqual(r.layers.renamed.map((l: { id: string; oldName: string }) => [l.id, l.oldName]), [["1:1", "Login"]]);
    // 101 nodes went from inside a frame still there: one more than the default limit.
    assert.deepEqual([r.limit, r.truncated, r.counts.removedNodes, r.removedNodes.length], [100, true, 101, 100]);
    assert.equal(r.removedNodes[0].path, "Page / Login / field 0");
    const all = await call("figma_diff", { old: before, new: after, limit: 101 });
    assert.deepEqual([all.truncated, all.removedNodes.length], [false, 101]);
  });

  it("says a refresh could not be honoured for a path, on the side it was asked for", async () => {
    const r = await call("figma_diff", { old: before, new: after, refresh: true });
    assert.deepEqual([r.old.refreshIgnored, r.new.refreshIgnored], [undefined, true]);
  });

  it("leaves out the project's excludePages before the limit, says so, and takes page and exclude_pages as search does", async () => {
    // This test's project file excludes Archive (and Gone, which no file here has). An archive page full of moves
    // would otherwise take the list's place, and its changes are still counted in byPage.
    const ids = (l: { id: string }[]) => l.map((e) => e.id);
    const edited = { editInfo: { createdAt: Date.parse("2026-10-01T00:00:00Z") / 1000, lastEditedAt: Date.parse("2026-10-02T00:00:00Z") / 1000 } };
    const screens = { id: "0:1", type: "CANVAS", parent: "0:0", name: "Screens" } as TestNode;
    const archive = { id: "0:2", type: "CANVAS", parent: "0:0", name: "Archive" } as TestNode;
    const was = figFile("diff-pages-before", [screens, archive, ...many(5, (i) => ({ id: `2:${i + 1}`, type: "FRAME", parent: "0:2", name: `old ${i}` }))]);
    const is = figFile("diff-pages-after", [
      screens, archive,
      { id: "1:1", type: "FRAME", parent: "0:1", name: "Paywall", ...edited },
      ...many(5, (i) => ({ id: `3:${i + 1}`, type: "FRAME", parent: "0:2", name: `archived ${i}`, ...edited })),
    ]);
    const r = await call("figma_diff", { old: was, new: is });
    assert.deepEqual([r.excludedPages, r.excludedPagesFrom], [["Archive"], projectFile]);
    assert.deepEqual([ids(r.layers.added), ids(r.layers.removed), r.counts.layersAdded, r.counts.removedNodes], [["1:1"], [], 1, 0]);
    assert.deepEqual(r.byPage, { Archive: { removedNodes: 5, added: 5, removed: 5 }, Screens: { added: 1 } });
    // [] covers every page; a page asked for sets the default aside; a name neither file has is refused.
    const every = await call("figma_diff", { old: was, new: is, exclude_pages: [], limit: 2 });
    assert.deepEqual([every.excludedPages, ids(every.layers.added), every.truncated], [undefined, ["1:1", "3:1"], true], "shared between the two pages");
    assert.deepEqual(ids((await call("figma_diff", { old: was, new: is, page: "Archive" })).layers.removed).length, 5);
    await assert.rejects(body("figma_diff", { old: was, new: is, page: "Archiv" }), /no page named "Archiv"; pages: "Screens", "Archive"/);
    await assert.rejects(body("figma_diff", { old: was, new: is, exclude_pages: ["Old"] }), /no page named "Old" to exclude/);
    await assert.rejects(body("figma_diff", { old: was, new: is, page: "Archive", exclude_pages: ["Archive"] }), /page "Archive" is both asked for and in exclude_pages/);
    // changes takes the same, over one file.
    const c = await call("figma_changes", { file: is, since: "2026-09-30" });
    assert.deepEqual([c.excludedPages, c.excludedPagesFrom, ids(c.layers), c.editedNodes], [["Archive"], projectFile, ["1:1"], 1]);
    assert.deepEqual(c.byPage, { Screens: { editedNodes: 1, layers: 1 }, Archive: { editedNodes: 5, layers: 5 } });
    await assert.rejects(body("figma_changes", { file: is, since: "7d", page: "Nope" }), /no page named "Nope"/);
  });

  describe("against previous", () => {
    const key = "PREVKEY12345";
    const cache = join(root, "cache", "accounts", "tools-test");
    mkdirSync(cache, { recursive: true });
    copyFileSync(before, join(cache, `${key}.previous.fig`));
    copyFileSync(after, join(cache, `${key}.fig`));
    utimesSync(join(cache, `${key}.previous.fig`), old, old);

    it("compares the key's previous snapshot with its current one, both dated as exports", async () => {
      const current = statSync(join(cache, `${key}.fig`)).mtime.toISOString();
      // A local copy named for the key would answer any other tool. previous is the cache's, so the snapshot it is
      // compared with has to be the cache's too: a copy the user saved is some other moment of the file.
      const local = join(listed, `Diff [${key}].fig`);
      copyFileSync(before, local);
      try {
        for (const old of ["previous", "Previous"]) {
          const r = await call("figma_diff", { old, new: `https://www.figma.com/design/${key}/Diff?node-id=1-1` });
          // Both from this account's cache, so both name it, as any answer read through the account does.
          const account = { name: "tools-test", source: "FIGMA_ACCOUNT" };
          assert.deepEqual(r.old, { key, source: "previous", path: join(cache, `${key}.previous.fig`), exportedAt: "2026-09-25T13:44:10.000Z", account });
          assert.deepEqual(r.new, { key, source: "web", exportedAt: current, account });
          assert.deepEqual([r.counts.layersRenamed, r.counts.removedNodes], [1, 101]);
        }
      } finally {
        rmSync(local, { force: true });
      }
    });

    it("says there is none rather than comparing with something else", async () => {
      copyFileSync(after, join(cache, "NOPREVKEY123.fig"));
      await assert.rejects(
        byName.get("figma_diff")!.run({ old: "previous", new: "NOPREVKEY123" }),
        /no previous snapshot of NOPREVKEY123 in account "tools-test"'s cache, only the current one \(exported .*\).*Pass refresh/,
      );
    });

    it("needs the key, since a path has no previous snapshot", async () => {
      await assert.rejects(byName.get("figma_diff")!.run({ old: "previous", new: after }), /new must be that key or URL, not a path/);
    });
  });
});

describe("figma_changes", () => {
  const T = Date.parse("2026-10-01T00:00:00Z") / 1000;
  const file = figFile("changes", [
    page,
    { id: "1:1", type: "FRAME", parent: "0:1", name: "Login", editInfo: { createdAt: T - 100, lastEditedAt: T - 100 } },
    { id: "1:2", type: "FRAME", parent: "1:1", name: "Form", editInfo: { createdAt: T - 100, lastEditedAt: T + 60 } },
    ...many(51, (i) => ({ id: `2:${i + 1}`, type: "FRAME", parent: "0:1", name: `new ${i}`, editInfo: { createdAt: T + i, lastEditedAt: T + i } })),
  ]);

  it("lists the top-level layers edited since, rolled up, newest first, 50 by default", async () => {
    const r = await call("figma_changes", { file, since: "2026-10-01" });
    assert.deepEqual([r.since, r.returned, r.total, r.truncated, r.limit], ["2026-10-01T00:00:00.000Z", 50, 52, true, 50]);
    assert.deepEqual(r.layers[0], {
      id: "1:1", name: "Login", type: "FRAME", page: "Page", path: "Page / Login",
      lastEditedAt: new Date((T + 60) * 1000).toISOString(), created: false, editedNodes: 1,
    });
    assert.deepEqual([r.layers[1].id, r.layers[1].created], ["2:51", true]);
  });

  it("reports a since it cannot read, instead of reading it somehow", async () => {
    await assert.rejects(byName.get("figma_changes")!.run({ file, since: "last week" }), /since "last week" is neither an ISO-8601 date/);
  });

  it("reports a bad since before it reads any file", async () => {
    // A file that is not there would answer "not found" if it were opened first; for a key it would be an export.
    const missing = join(root, "not-there.fig");
    for (const since of ["2026-02-29", "99999999999w"]) {
      await assert.rejects(byName.get("figma_changes")!.run({ file: missing, since }), /since "[^"]+" (names a date|reaches back)/, since);
    }
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
describe("figma_get_tree, with every lane's part of it at once", () => {
  // Four lanes write into one outline: a header line (dated, with the account when one read it), the Dev Mode hint,
  // the budget spent a level at a time with a marker on the branch it cut, and a drawing counted in one line. Each was
  // tested on its own; here they have to compose on one file without one of them pushing another out.
  it("dates it, hints the dev status, cuts the widest branch with a marker and counts a drawing", async () => {
    const at = Date.parse("2026-10-01T10:00:00Z") / 1000;
    const file = figFile("tree-all", [
      { id: "0:1", type: "CANVAS", parent: "0:0", name: "Screens" },
      { id: "1:1", type: "FRAME", parent: "0:1", name: "Checkout", sectionStatusInfo: { status: "BUILD", prevStatus: "NONE", lastUpdateUnixTimestamp: at } },
      ...many(3, (i) => ({ id: `1:${10 + i}`, type: "FRAME", parent: "1:1", name: `step ${i + 1}` })),
      { id: "1:2", type: "FRAME", parent: "0:1", name: "Logo" },
      ...many(3, (i) => ({ id: `1:${20 + i}`, type: "VECTOR", parent: "1:2", name: `path ${i + 1}` })),
      { id: "1:3", type: "FRAME", parent: "0:1", name: "Icons" },
      ...many(30, (i) => ({ id: `1:${100 + i}`, type: "INSTANCE", parent: "1:3", name: `icon ${i + 1}` })),
      { id: "1:4", type: "FRAME", parent: "0:1", name: "Old checkout", sectionStatusInfo: { status: "NONE", prevStatus: "BUILD", lastUpdateUnixTimestamp: at } },
      { id: "0:2", type: "CANVAS", parent: "0:0", name: "Archive" },
      { id: "2:1", type: "FRAME", parent: "0:2", name: "v1" },
    ]);
    const taken = new Date("2026-10-05T14:15:09.000Z");
    utimesSync(file, taken, taken);
    const tree = await body("figma_get_tree", { file, max_nodes: 13 });
    assert.equal(
      tree,
      [
        `# {"fileModifiedAt":"${taken.toISOString()}"}`,
        '- 0:1 PAGE "Screens"',
        '  - 1:1 FRAME "Checkout" (ready for dev)',
        '    - 1:10 FRAME "step 1"',
        '    - 1:11 FRAME "step 2"',
        '    - 1:12 FRAME "step 3"',
        '  - 1:2 FRAME "Logo" (3 vectors)',
        '  - 1:3 FRAME "Icons"',
        '    - 1:100 INSTANCE "icon 1"',
        '    - 1:101 INSTANCE "icon 2"',
        "    - ... 28 more children",
        '  - 1:4 FRAME "Old checkout" (was ready for dev)',
        '- 0:2 PAGE "Archive"',
        '  - 2:1 FRAME "v1"',
        "... truncated at 13 nodes; use a node_id or smaller depth",
      ].join("\n"),
    );
    // The drawing's id lists what it counted, and the header stays on top of a tree asked for by node.
    const logo = (await body("figma_get_tree", { file, node_id: "1:2" })).split("\n");
    assert.deepEqual(logo.slice(1), ['- 1:2 FRAME "Logo"', '  - 1:20 VECTOR "path 1"', '  - 1:21 VECTOR "path 2"', '  - 1:22 VECTOR "path 3"']);
    assert.match(logo[0], /^# \{"fileModifiedAt":/);
  });
});

describe("the defaults", () => {
  const chain = (n: number, from: string) =>
    many(n, (i) => ({ id: `1:${i + 1}`, type: "FRAME", parent: i ? `1:${i}` : from, name: `level ${i + 1}` }));

  it("show a page, its top-level layers and one level under those", async () => {
    const file = figFile("tree", [page, ...chain(4, "0:1")]);
    // The first line is the header (see "dating a result"); the outline is the rest.
    const [header, ...tree] = (await body("figma_get_tree", { file })).split("\n");
    assert.match(header, /^# \{/);
    // Three levels from a document start, not two: with no node_id the pages themselves are level 0.
    assert.deepEqual(tree.map((l) => l.trim().split(" ")[1]), ["0:1", "1:1", "1:2"]);
    // The layer the cut-off stopped at says what is under it, so nothing is missing in silence.
    assert.match(tree[2], /- 1:2 FRAME "level 2" \(1 child\)/);
    assert.equal((await body("figma_get_tree", { file, node_id: "1:1", depth: 0 })).split("\n")[1], '- 1:1 FRAME "level 1" (1 child)');
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
