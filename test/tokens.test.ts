// Variables and styles are read straight from the file (no Enterprise REST API), then rendered as JSON, CSS or DTCG;
// these pin the reading (modes, aliases, remote) and the naming rules each format depends on.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cssIdent, extractStyles, extractVariables, stylesToCss, variablesToCss, variablesToDtcg, type Collection } from "../src/tokens.ts";
import type { Raw } from "../src/fig-file.ts";
import { figDoc, guid, internalPage as internal, variable, variableSet as set, type TestNode } from "./fixtures.ts";

// Primitives (one mode) feed a Semantic collection with Light and Dark modes.
const tokens: TestNode[] = [
  internal,
  set("5:0", "Primitives", [["6:1", "Value"]]),
  variable("5:1", "5:0", "blue/500", "COLOR", { "6:1": { color: [0, 0, 1] } }),
  variable("5:2", "5:0", "gray/900", "COLOR", { "6:1": { color: [0.1, 0.1, 0.1, 0.5] } }),
  variable("5:3", "5:0", "space/md", "FLOAT", { "6:1": { float: 16.000001 } }, { variableScopes: ["GAP"] }),
  variable("5:4", "5:0", "opacity/muted", "FLOAT", { "6:1": { float: 50 } }, { variableScopes: ["OPACITY"] }),
  variable("5:5", "5:0", "Old", "COLOR", { "6:1": { color: [1, 0, 0] } }, { isSoftDeleted: true }),
  variable("5:6", "5:0", "space/none", "FLOAT", { "6:1": { float: 0 } }, { variableScopes: ["GAP"] }),
  set("7:0", "Semantic", [["8:1", "Light"], ["8:2", "Dark"]]),
  variable("7:1", "7:0", "bg", "COLOR", { "8:1": { alias: "5:1" }, "8:2": { alias: "5:2" } }, { description: "Page background" }),
  variable("7:2", "7:0", "font/family", "STRING", { "8:1": { text: "Inter" }, "8:2": { text: "Inter" } }),
  variable("7:3", "7:0", "brand", "COLOR", { "8:1": { libraryAlias: "lib-brand" }, "8:2": { libraryAlias: "lib-brand" } }),
];

// A partial library copy, of the shape a file gets when only some of a library's values came across: a target with no
// value in the default mode, an alias chain that leaves the file one hop in, and a raw value in no field we read.
// Each of these was named by a var() or a {…} reference that resolved to nothing.
const partial: TestNode[] = [
  internal,
  set("5:0", "C", [["6:1", "Light"], ["6:2", "Dark"]]),
  variable("5:1", "5:0", "base", "COLOR", { "6:2": { color: [1, 0, 0] } }),
  variable("5:2", "5:0", "fg", "COLOR", { "6:1": { alias: "5:1" }, "6:2": { alias: "5:1" } }),
  variable("5:3", "5:0", "mid", "COLOR", { "6:1": { libraryAlias: "absent" } }),
  variable("5:4", "5:0", "outer", "COLOR", { "6:1": { alias: "5:3" } }),
  {
    id: "5:5", type: "VARIABLE", parent: "0:9", name: "odd", variableResolvedType: "COLOR", variableSetID: { guid: guid("5:0") },
    variableDataValues: { entries: [{ modeID: guid("6:1"), variableData: { value: {} } }] },
  },
  variable("5:6", "5:0", "ref", "COLOR", { "6:1": { alias: "5:5" } }),
];

/** Every `{a.b.c}` reference in a DTCG tree, and whether it lands on a token with a $value. */
function dtcgRefs(tree: Raw): { ref: string; ok: boolean }[] {
  const out: { ref: string; ok: boolean }[] = [];
  const walk = (o: Raw) => {
    for (const v of Object.values(o)) {
      if (!v || typeof v !== "object") continue;
      if (typeof v.$value === "string" && /^\{.*\}$/.test(v.$value)) {
        const target = v.$value.slice(1, -1).split(".").reduce((c: Raw | undefined, p: string) => c?.[p], tree);
        out.push({ ref: v.$value, ok: target?.$value !== undefined });
      } else walk(v);
    }
  };
  walk(tree);
  return out;
}
/** Every node carrying $type but no $value: neither a token a consumer can read nor a group it can walk into. */
function typedWithoutValue(tree: Raw, path: string[] = []): string[] {
  const out: string[] = [];
  for (const [name, v] of Object.entries(tree)) {
    if (name.startsWith("$") || !v || typeof v !== "object") continue;
    if (v.$type !== undefined && v.$value === undefined) out.push([...path, name].join("."));
    out.push(...typedWithoutValue(v, [...path, name]));
  }
  return out;
}
const rootNames = (css: string) => [...css.slice(0, css.indexOf("\n}")).matchAll(/^ {2}(--[^:\s]+):/gm)].map((m) => m[1]);
/** The sheet with its comments taken out: what a browser is left to parse, and where a name that closed one shows. */
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("extractVariables", () => {
  const cols = extractVariables(figDoc(tokens));
  const semantic = cols.find((c) => c.name === "Semantic")!;
  const primitives = cols.find((c) => c.name === "Primitives")!;

  it("orders modes by sortPosition and takes the first as the default", () => {
    assert.deepEqual(semantic.modes.map((m) => m.name), ["Light", "Dark"]);
    assert.equal(semantic.defaultMode, "Light");
  });

  it("reads values per mode name, as hex colors and rounded floats (0 included), skipping soft-deleted variables", () => {
    assert.deepEqual(primitives.variables.map((v) => v.name), ["blue/500", "gray/900", "opacity/muted", "space/md", "space/none"]);
    const byName = Object.fromEntries(primitives.variables.map((v) => [v.name, v.values.Value.value]));
    assert.deepEqual(byName, { "blue/500": "#0000FF", "gray/900": "#1A1A1A80", "opacity/muted": 50, "space/md": 16, "space/none": 0 });
  });

  it("resolves aliases per mode", () => {
    const bg = semantic.variables.find((v) => v.name === "bg")!;
    assert.deepEqual(bg.values.Light, { alias: "blue/500", aliasId: "5:1", resolved: "#0000FF" });
    assert.deepEqual(bg.values.Dark, { alias: "gray/900", aliasId: "5:2", resolved: "#1A1A1A80" });
    assert.equal(bg.description, "Page background");
  });

  it("names an alias to a library variable that is not in the file by its key", () => {
    const brand = semantic.variables.find((v) => v.name === "brand")!;
    assert.deepEqual(brand.values.Light, { alias: "library:lib-brand", aliasId: undefined });
  });

  it("follows alias chains, keeping the mode within a collection and taking another collection's default mode", () => {
    const cols = extractVariables(figDoc([
      internal,
      set("5:0", "Palette", [["6:1", "Light"], ["6:2", "Dark"]]),
      variable("5:1", "5:0", "base", "COLOR", { "6:1": { color: [1, 1, 1] }, "6:2": { color: [0, 0, 0] } }),
      set("7:0", "Theme", [["8:1", "Light"], ["8:2", "Dark"]]),
      variable("7:1", "7:0", "surface", "COLOR", { "8:1": { color: [1, 0, 0] }, "8:2": { color: [0, 1, 0] } }),
      variable("7:2", "7:0", "card", "COLOR", { "8:1": { alias: "7:1" }, "8:2": { alias: "7:1" } }),
      variable("7:3", "7:0", "panel", "COLOR", { "8:1": { alias: "7:2" }, "8:2": { alias: "7:2" } }),
      variable("7:4", "7:0", "page", "COLOR", { "8:1": { alias: "5:1" }, "8:2": { alias: "5:1" } }),
    ]));
    const theme = cols.find((c) => c.name === "Theme")!;
    const resolved = (name: string) => Object.fromEntries(Object.entries(theme.variables.find((v) => v.name === name)!.values).map(([m, v]) => [m, v.resolved]));
    // Two hops, each in the same mode.
    assert.deepEqual(resolved("panel"), { Light: "#FF0000", Dark: "#00FF00" });
    // Palette's mode is set on its own (per frame), so without one it is Palette's default, not Theme's "Dark".
    assert.deepEqual(resolved("page"), { Light: "#FFFFFF", Dark: "#FFFFFF" });
  });

  it("finds library variables' collection and alias targets by publish key (assetRef only)", () => {
    const cols = extractVariables(figDoc([
      internal,
      set("5:0", "Library", [["6:1", "Mode"]], { key: "set-key", sourceLibraryKey: "lib" }),
      variable("5:1", { key: "set-key" }, "blue", "COLOR", { "6:1": { color: [0, 0, 1] } }, { key: "blue-key", sourceLibraryKey: "lib" }),
      variable("5:2", { key: "set-key" }, "link", "COLOR", { "6:1": { libraryAlias: "blue-key" } }, { key: "link-key", sourceLibraryKey: "lib" }),
    ]));
    assert.deepEqual(cols[0].variables.map((v) => v.name), ["blue", "link"]);
    assert.deepEqual(cols[0].variables[1].values.Mode, { alias: "blue", aliasId: "5:1", resolved: "#0000FF" });
    assert.match(variablesToCss(cols), /--link: var\(--blue\);/);
  });

  it("marks library collections and their variables remote, and can leave them out", () => {
    const nodes = [...tokens, set("9:0", "Library", [["9:1", "Mode"]], { sourceLibraryKey: "lib" }), variable("9:2", "9:0", "x", "BOOLEAN", { "9:1": { bool: true } })];
    const lib = extractVariables(figDoc(nodes)).find((c) => c.name === "Library")!;
    assert.equal(lib.remote, true);
    assert.equal(lib.variables[0].remote, true);
    assert.equal(extractVariables(figDoc(nodes)).find((c) => c.name === "Primitives")!.variables[0].remote, false);
    assert.deepEqual(extractVariables(figDoc(nodes), false).map((c) => c.name), ["Primitives", "Semantic"]);
  });

  it("skips soft-deleted collections", () => {
    const cols = extractVariables(figDoc([...tokens, set("9:0", "Deleted", [["9:1", "Mode"]], { isSoftDeleted: true })]));
    assert.deepEqual(cols.map((c) => c.name), ["Primitives", "Semantic"]);
  });

  it("takes a collection's modes from its variables when it carries no variableSetModes", () => {
    // Without them the collection has no mode to write and vanished from CSS and DTCG, while `format: json` still
    // listed its variables; its values are keyed by the raw mode id, so that is the name they get.
    const cols = extractVariables(figDoc([
      internal,
      { id: "5:0", type: "VARIABLE_SET", parent: "0:9", name: "Copied" },
      variable("5:1", "5:0", "blue", "COLOR", { "6:1": { color: [0, 0, 1] } }),
      variable("5:2", "5:0", "link", "COLOR", { "6:1": { alias: "5:1" } }),
    ]));
    assert.deepEqual(cols[0].modes, [{ id: "6:1", name: "6:1" }]);
    assert.equal(cols[0].defaultMode, "6:1");
    const css = variablesToCss(cols);
    assert.match(css, /--blue: #0000FF;/);
    assert.match(css, /--link: var\(--blue\);/);
    assert.deepEqual(variablesToDtcg(cols).Copied["6:1"].blue, { $type: "color", $value: "#0000FF" });
  });

  it("takes the same modes and default mode however the file decoded", () => {
    // Local ids 9 and 10: the order Figma allocated these two modes in is the one a string compare gets wrong, so
    // the collection's default is 6:9 only if the ids are read as the two numbers they are.
    const md = variable("5:1", "5:0", "radius/md", "FLOAT", { "6:9": { float: 10 }, "6:10": { float: 20 } });
    const sm = variable("5:2", "5:0", "radius/sm", "FLOAT", { "6:10": { float: 4 } });
    const cols = (vars: TestNode[]) => extractVariables(figDoc([
      internal,
      // A partial library copy carries no variableSetModes, so its modes are known only from its values.
      { id: "5:0", type: "VARIABLE_SET", parent: "0:9", name: "Copied" },
      ...vars,
      set("7:0", "Semantic", [["8:1", "Light"]]),
      variable("7:1", "7:0", "card/radius", "FLOAT", { "8:1": { alias: "5:1" } }),
    ]));
    // Nodes are decoded in whatever order the file holds them, and the first mode found became the default: the one
    // :root is written in, and the one an alias from another collection reads its target in.
    assert.equal(variablesToCss(cols([md, sm])), variablesToCss(cols([sm, md])));
    assert.deepEqual(cols([sm, md])[0].modes.map((m) => m.name), ["6:9", "6:10"]);
    const css = variablesToCss(cols([sm, md]));
    assert.match(css, /^ {2}--radius-md: 10px;$/m);
    assert.match(css, /\[data-copied="6-10"\] \{\n {2}--radius-md: 20px;\n {2}--radius-sm: 4px;\n\}/);
    assert.equal(variablesToDtcg(cols([sm, md])).Semantic.Light.card.radius.$value, "{Copied.6:9.radius.md}");
  });

  it("keeps a value whose mode its collection does not list", () => {
    // Also seen on partial copies: the collection lists some modes, and a variable carries an id that is not one of
    // them. Both CSS and DTCG walk collection.modes, so that value was reported by `format: json` alone.
    const cols = extractVariables(figDoc([
      internal,
      set("5:0", "Semantic", [["6:1", "Light"], ["6:2", "Dark"]]),
      variable("5:1", "5:0", "text/primary", "COLOR", { "6:1": { color: [0, 0, 0] }, "6:2": { color: [1, 1, 1] }, "6:3": { color: [0.5, 0, 0] } }),
    ]));
    assert.deepEqual(cols[0].modes.map((m) => m.name), ["Light", "Dark", "6:3"]);
    assert.equal(cols[0].defaultMode, "Light");
    assert.match(variablesToCss(cols), /\[data-semantic="6-3"\] \{\n {2}--text-primary: #800000;\n\}/);
    assert.equal(variablesToDtcg(cols).Semantic["6:3"].text.primary.$value, "#800000");
  });

  it("leaves out a stale copy of a library variable and points aliases to it at the current one", () => {
    const cols = extractVariables(figDoc([
      internal,
      set("5:0", "Neutral", [["6:1", "Mode"]]),
      variable("5:2", "5:0", "Neutral/700", "COLOR", { "6:1": { color: [0.46, 0.46, 0.46] } }, { key: "n700", version: "2710:0" }),
      variable("5:1", "5:0", "Neutral/700", "COLOR", { "6:1": { color: [0.54, 0.54, 0.54] } }, { key: "n700", version: "2002:352" }),
      variable("5:3", "5:0", "text", "COLOR", { "6:1": { alias: "5:1" } }),
    ]));
    assert.deepEqual(cols[0].variables.map((v) => `${v.id} ${v.name}`), ["5:2 Neutral/700", "5:3 text"]);
    assert.deepEqual(cols[0].variables[1].values.Mode, { alias: "Neutral/700", aliasId: "5:2", resolved: "#757575" });
  });

  it("keeps modes with the same name apart", () => {
    const cols = extractVariables(figDoc([
      internal,
      set("5:0", "C", [["6:1", "Mode"], ["6:2", "Mode"]]),
      variable("5:1", "5:0", "x", "FLOAT", { "6:1": { float: 1 }, "6:2": { float: 2 } }),
    ]));
    assert.deepEqual(cols[0].modes.map((m) => m.name), ["Mode", "Mode 2"]);
    assert.deepEqual(cols[0].variables[0].values, { Mode: { value: 1 }, "Mode 2": { value: 2 } });
    assert.match(variablesToCss(cols), /\[data-c="mode-2"\] \{\n {2}--x: 2px;\n\}/);
    assert.deepEqual(Object.keys(variablesToDtcg(cols).C), ["Mode", "Mode 2"]);
  });

  it("reads an alias target that has no value in the mode in the default mode, then in whatever mode it has", () => {
    const cols = extractVariables(figDoc([
      internal,
      set("5:0", "C", [["6:1", "Light"], ["6:2", "Dark"], ["6:3", "Extra"]]),
      // Values are stored in their own order, so the default mode's is not the first one to hand.
      variable("5:1", "5:0", "a", "COLOR", { "6:3": { color: [0, 0, 1] }, "6:1": { color: [1, 0, 0] } }),
      variable("5:2", "5:0", "b", "COLOR", { "6:3": { color: [0, 1, 0] } }),
      variable("5:3", "5:0", "usesA", "COLOR", { "6:2": { alias: "5:1" } }),
      variable("5:4", "5:0", "usesB", "COLOR", { "6:1": { alias: "5:2" } }),
    ]));
    const v = (name: string) => cols[0].variables.find((x) => x.name === name)!;
    // a has no Dark value, so the collection's default mode answers for it, not whatever value comes first.
    assert.equal(v("usesA").values.Dark.resolved, "#FF0000");
    // b has none in Light nor in the default mode, so its only value does.
    assert.equal(v("usesB").values.Light.resolved, "#00FF00");
  });

  it("leaves an alias cycle unresolved instead of looping", () => {
    const cols = extractVariables(figDoc([
      internal,
      set("5:0", "C", [["6:1", "M"]]),
      variable("5:1", "5:0", "a", "COLOR", { "6:1": { alias: "5:2" } }),
      variable("5:2", "5:0", "b", "COLOR", { "6:1": { alias: "5:1" } }),
    ]));
    assert.deepEqual(cols[0].variables.map((v) => v.values.M.resolved), [undefined, undefined]);
  });
});

describe("variablesToCss", () => {
  const css = variablesToCss(extractVariables(figDoc(tokens)));

  it("puts default-mode values on :root, with px only where the scope takes a length", () => {
    assert.match(css, /^:root \{$/m);
    assert.match(css, /^ {2}--space-md: 16px;$/m);
    assert.match(css, /^ {2}--space-none: 0px;$/m);
    // Opacity variables hold 0-100.
    assert.match(css, /^ {2}--opacity-muted: 0\.5;$/m);
    assert.match(css, /^ {2}--font-family: "Inter";$/m);
  });

  it("writes line heights and letter spacing in px, weights and font axes unitless", () => {
    const out = variablesToCss(extractVariables(figDoc([
      internal,
      set("5:0", "Type", [["6:1", "M"]]),
      variable("5:1", "5:0", "lineHeight/body", "FLOAT", { "6:1": { float: 24 } }, { variableScopes: ["LINE_HEIGHT"] }),
      variable("5:2", "5:0", "tracking", "FLOAT", { "6:1": { float: -0.5 } }, { variableScopes: ["LETTER_SPACING"] }),
      variable("5:3", "5:0", "weight/bold", "FLOAT", { "6:1": { float: 700 } }, { variableScopes: ["FONT_STYLE"] }),
      variable("5:4", "5:0", "wght", "FLOAT", { "6:1": { float: 650 } }, { variableScopes: ["FONT_VARIATIONS"] }),
      variable("5:5", "5:0", "any", "FLOAT", { "6:1": { float: 3 } }, { variableScopes: ["ALL_SCOPES"] }),
      variable("5:6", "5:0", "mixed", "FLOAT", { "6:1": { float: 400 } }, { variableScopes: ["FONT_WEIGHT", "GAP"] }),
      variable("5:7", "5:0", "scrim", "FLOAT", { "6:1": { float: 50 } }, { variableScopes: ["OPACITY", "GAP"] }),
    ])));
    // Figma binds line height in pixels: unitless 24 would mean 24 times the font size.
    assert.match(out, /--line-height-body: 24px;/);
    assert.match(out, /--tracking: -0\.5px;/);
    assert.match(out, /--weight-bold: 700;/);
    assert.match(out, /--wght: 650;/);
    assert.match(out, /--any: 3px;/);
    // A variable in several scopes is unitless only when every one of them is.
    assert.match(out, /--mixed: 400px;/);
    // And it is the percentage an opacity variable holds only when opacity is all it is for: a gap of 50 is 50px.
    assert.match(out, /--scrim: 50px;/);
  });

  it("writes aliases as var() references to the target's custom property", () => {
    assert.match(css, /^ {2}--bg: var\(--blue-500\);$/m);
  });

  it("comments out an alias to a library variable absent from the file instead of referencing an undefined name", () => {
    assert.match(css, /^ {2}\/\* --brand: alias of library:lib-brand, which is not in this file \*\/$/m);
    assert.doesNotMatch(css, /var\(--library/);
  });

  it("references only a target that is itself declared in the mode being written", () => {
    const out = variablesToCss(extractVariables(figDoc(partial)));
    const root = out.slice(0, out.indexOf("\n}"));
    // The target's own value lives in another mode, so :root has no --base to point at.
    assert.deepEqual(rootNames(out), ["--fg"]);
    assert.doesNotMatch(root, /var\(/);
    assert.match(out, /^ {2}--fg: #FF0000; \/\* alias of base \*\/$/m);
    // One hop further than a direct library alias: mid is in this file, what mid aliases is not.
    assert.match(out, /^ {2}\/\* --mid: alias of library:absent, which is not in this file \*\/$/m);
    assert.match(out, /^ {2}\/\* --outer: alias of mid, which has no value here \*\/$/m);
    assert.match(out, /^ {2}\/\* --ref: alias of odd, which has no value here \*\/$/m);
    // Where the target is declared, the reference stands: both land in the same block.
    assert.match(out, /\[data-c="dark"\] \{\n {2}--base: #FF0000;\n {2}--fg: var\(--base\);\n\}/);
    const defined = new Set([...out.matchAll(/^ {2}(--[^\s:]+):/gm)].map((m) => m[1]));
    assert.deepEqual([...out.matchAll(/var\((--[^)]+)\)/g)].map((m) => m[1]).filter((n) => !defined.has(n)), []);
  });

  it("references a target whose own declaration only follows from a later variable's", () => {
    // An inverse pair, which is how a theme names the surface that swaps with the page: surface/default is the
    // inverse in Dark and surface/inverse is it in Light. surface/default's Dark property stands only because
    // surface/inverse's Light one does, and the scrim pointing at it only after that; reading the values in one pass
    // over them left whichever came later undeclared, and the scrim fell back to a comment naming nothing.
    const out = variablesToCss(extractVariables(figDoc([
      internal,
      set("5:0", "Semantic", [["6:1", "Light"], ["6:2", "Dark"]]),
      variable("5:1", "5:0", "surface/default", "COLOR", { "6:1": { color: [1, 1, 1] }, "6:2": { alias: "5:2" } }),
      variable("5:2", "5:0", "surface/inverse", "COLOR", { "6:1": { alias: "5:1" } }),
      variable("5:3", "5:0", "overlay/scrim", "COLOR", { "6:2": { alias: "5:1" } }),
    ])));
    assert.match(out, /\[data-semantic="dark"\] \{\n {2}--overlay-scrim: var\(--surface-default\);\n {2}--surface-default: var\(--surface-inverse\);\n\}/);
    assert.doesNotMatch(out, /which has no value here/);
  });

  it("gives other modes a [data-collection] block holding only what differs", () => {
    const at = css.indexOf('[data-semantic="dark"] {');
    assert.ok(at > 0, css);
    const dark = css.slice(at);
    assert.match(dark, /--bg: var\(--gray-900\);/);
    assert.doesNotMatch(dark, /font-family/);
  });

  it("tells an alias to a variable this file drops apart from one to a variable it never had", () => {
    const out = variablesToCss(extractVariables(figDoc([
      internal,
      set("5:0", "C", [["6:1", "M"]]),
      variable("5:1", "5:0", "old", "COLOR", { "6:1": { color: [1, 0, 0] } }, { isSoftDeleted: true }),
      variable("5:2", "5:0", "fg", "COLOR", { "6:1": { alias: "5:1" } }),
    ])));
    assert.match(out, /^ {2}\/\* --fg: alias of old, which this file does not export \*\/$/m);
  });

  it("writes no block for a mode in which nothing differs from the default", () => {
    const out = variablesToCss(extractVariables(figDoc([
      internal,
      set("5:0", "C", [["6:1", "Light"], ["6:2", "Dark"]]),
      variable("5:1", "5:0", "x", "COLOR", { "6:1": { color: [1, 0, 0] }, "6:2": { color: [1, 0, 0] } }),
    ])));
    assert.doesNotMatch(out, /\[data-/);
  });

  it("escapes string values as CSS reads them, and keeps a name from closing the comment it sits in", () => {
    const out = variablesToCss(extractVariables(figDoc([
      internal,
      set("5:0", "C */ body { color: red }", [["6:1", "M"]]),
      variable("5:1", "5:0", "quote", "STRING", { "6:1": { text: 'a "b"\nc' } }),
      // Values a type scale really carries: a stack naming a family in quotes, and one outside ASCII.
      variable("5:2", "5:0", "font/stack", "STRING", { "6:1": { text: '"Noto Sans JP", ヒラギノ角ゴ, sans-serif' } }),
      // A path pasted from Windows ends in a backslash, which would escape the closing quote.
      variable("5:3", "5:0", "asset/dir", "STRING", { "6:1": { text: "C:\\Fonts\\" } }),
      // Text pasted from a binary source brings a NUL along; CSS preprocessing turns a raw one into U+FFFD.
      variable("5:4", "5:0", "legacy/label", "STRING", { "6:1": { text: "a\u0000b" } }),
      variable("5:5", "5:0", "ghost", "COLOR", { "6:1": { libraryAlias: "k */ body { color: red }" } }),
    ])));
    // JSON escapes are not CSS escapes: "\n" in a CSS string is the letter n, and a newline is "\A ".
    assert.match(out, /--quote: "a \\"b\\"\\A c";/);
    assert.ok(out.includes('  --font-stack: "\\"Noto Sans JP\\", ヒラギノ角ゴ, sans-serif";'), out);
    assert.ok(out.includes('  --asset-dir: "C:\\\\Fonts\\\\";'), out);
    assert.ok(out.includes('  --legacy-label: "a\\0 b";'), out);
    assert.doesNotMatch(out, /\u0000/);
    // Names are written into comments as they are, and "*/" in one would leave a live declaration behind.
    assert.doesNotMatch(out, /\*\/ body/);
    assert.doesNotMatch(withoutComments(out), /color: red/);
  });

  it("splits camelCase names into words", () => {
    const cols = extractVariables(figDoc([internal, set("5:0", "C", [["6:1", "M"]]), variable("5:1", "5:0", "fontSize/bodyLarge", "FLOAT", { "6:1": { float: 18 } })]));
    assert.match(variablesToCss(cols), /--font-size-body-large: 18px;/);
  });

  it("keeps names outside ASCII, and falls back to ids when nothing usable is left", () => {
    const cols = extractVariables(figDoc([
      internal,
      set("5:0", "颜色", [["6:1", "默认"], ["6:2", "暗色"]]),
      variable("5:1", "5:0", "主色", "COLOR", { "6:1": { color: [1, 0, 0] }, "6:2": { color: [0, 0, 0] } }),
      set("7:0", "🎨", [["8:1", "☀️"], ["8:2", "🌙"], ["8:3", "🌚"]]),
      variable("7:1", "7:0", "🔥", "COLOR", { "8:1": { color: [1, 0, 0] }, "8:2": { color: [0, 0, 0] }, "8:3": { color: [0, 0, 1] } }),
    ]));
    const out = variablesToCss(cols);
    assert.match(out, /--主色: #FF0000;/);
    assert.match(out, /\[data-颜色="暗色"\] \{/);
    assert.match(out, /--var-7-1: #FF0000;/);
    assert.match(out, /\[data-collection-7-0="mode-2"\] \{\n {2}--var-7-1: #000000;/);
    assert.match(out, /\[data-collection-7-0="mode-3"\] \{/);
    assert.doesNotMatch(out, /--:|data-=|=""/);
  });

  it("prefixes a name shared by two collections with its collection, and applies the global prefix", () => {
    const cols = extractVariables(figDoc([
      internal,
      set("5:0", "Brand A", [["6:1", "M"]]),
      variable("5:1", "5:0", "primary", "COLOR", { "6:1": { color: [1, 0, 0] } }),
      set("7:0", "Brand B", [["8:1", "M"]]),
      variable("7:1", "7:0", "primary", "COLOR", { "8:1": { color: [0, 1, 0] } }),
      variable("7:2", "7:0", "accent", "COLOR", { "8:1": { alias: "7:1" } }),
    ]));
    const out = variablesToCss(cols, "ds-");
    assert.match(out, /--ds-brand-a-primary: #FF0000;/);
    assert.match(out, /--ds-brand-b-primary: #00FF00;/);
    // The alias follows the renamed target, not the bare name.
    assert.match(out, /--ds-accent: var\(--ds-brand-b-primary\);/);
  });

  it("names and references everything as the full export does when only some collections are written", () => {
    const cols = extractVariables(figDoc([
      internal,
      set("5:0", "Prim", [["6:1", "V"]]),
      variable("5:1", "5:0", "blue", "COLOR", { "6:1": { color: [0, 0, 1] } }),
      set("7:0", "Sem", [["8:1", "L"]]),
      variable("7:1", "7:0", "bg", "COLOR", { "8:1": { alias: "5:1" } }),
      variable("7:2", "7:0", "blue", "COLOR", { "8:1": { alias: "5:1" } }),
      variable("7:3", "7:0", "link", "COLOR", { "8:1": { alias: "7:2" } }),
    ]));
    const out = variablesToCss(cols, "ds-", (c) => c.name === "Sem");
    assert.doesNotMatch(out, /Prim \(|--ds-prim-blue:/);
    // The target is not written, so its value is, rather than a var() to an undefined name or to itself.
    assert.match(out, /--ds-sem-blue: #0000FF; \/\* alias of blue \*\//);
    assert.match(out, /--ds-bg: #0000FF; \/\* alias of blue \*\//);
    assert.match(out, /--ds-link: var\(--ds-sem-blue\);/);
  });

  // Real files hold several collections with one name: partial copies of variables from different libraries.
  const twoColors = () => extractVariables(figDoc([
    internal,
    set("5:0", "Colors", [["6:1", "Light"], ["6:2", "Dark"]]),
    variable("5:1", "5:0", "primary", "COLOR", { "6:1": { color: [1, 0, 0] }, "6:2": { color: [0.5, 0, 0] } }),
    set("7:0", "Colors", [["8:1", "Light"], ["8:2", "Dark"]]),
    variable("7:1", "7:0", "primary", "COLOR", { "8:1": { color: [0, 0, 1] }, "8:2": { color: [0, 0, 0.5] } }),
    variable("7:2", "7:0", "link", "COLOR", { "8:1": { alias: "7:1" }, "8:2": { alias: "7:1" } }),
  ]));

  it("keeps same-named collections apart instead of writing one custom property twice", () => {
    const out = variablesToCss(twoColors());
    assert.deepEqual(rootNames(out), ["--colors-primary", "--link", "--colors-2-primary"]);
    assert.match(out, /--link: var\(--colors-2-primary\);/);
    // Each copy's other modes get their own selector too.
    assert.match(out, /\[data-colors="dark"\] \{\n {2}--colors-primary: #800000;\n\}/);
    assert.match(out, /\[data-colors-2="dark"\] \{\n {2}--colors-2-primary: #000080;\n\}/);
  });

  it("numbers names that still collide once written as CSS", () => {
    const cols = extractVariables(figDoc([
      internal,
      set("5:0", "C", [["6:1", "M"], ["6:2", "m"]]),
      variable("5:1", "5:0", "Primary", "COLOR", { "6:1": { color: [1, 0, 0] } }),
      variable("5:2", "5:0", "primary", "COLOR", { "6:1": { color: [0, 1, 0] }, "6:2": { color: [0, 0, 1] } }),
    ]));
    const out = variablesToCss(cols);
    const names = rootNames(out);
    assert.equal(new Set(names).size, 2, names.join(" "));
    // Mode selectors too ("M" and "m" differ in Figma, not once lowercased).
    assert.match(out, /\[data-c="m-2"\]/);
  });
});

describe("variablesToDtcg", () => {
  const out = variablesToDtcg(extractVariables(figDoc(tokens)));

  it("nests tokens by '/' under collection and mode, with DTCG types", () => {
    assert.deepEqual(out.Primitives.Value.blue["500"], { $type: "color", $value: "#0000FF" });
    assert.deepEqual(out.Primitives.Value.space.md, { $type: "number", $value: 16 });
    assert.deepEqual(out.Semantic.Light.font.family, { $type: "string", $value: "Inter" });
  });

  it("references alias targets by their full path, so every reference resolves", () => {
    assert.deepEqual(out.Semantic.Dark.bg, { $type: "color", $value: "{Primitives.Value.gray.900}", $description: "Page background" });
    assert.ok(dtcgRefs(out).length > 0);
    assert.deepEqual(dtcgRefs(out).filter((r) => !r.ok), []);
  });

  it("reads a target in its own collection in the same mode, and one in another collection in its default mode", () => {
    const out = variablesToDtcg(extractVariables(figDoc([
      internal,
      set("5:0", "Palette", [["6:1", "Light"], ["6:2", "Dark"]]),
      variable("5:1", "5:0", "base", "COLOR", { "6:1": { color: [1, 1, 1] }, "6:2": { color: [0, 0, 0] } }),
      set("7:0", "Theme", [["8:1", "Light"], ["8:2", "Dark"]]),
      variable("7:1", "7:0", "surface", "COLOR", { "8:1": { color: [1, 0, 0] }, "8:2": { color: [0, 1, 0] } }),
      variable("7:2", "7:0", "card", "COLOR", { "8:1": { alias: "7:1" }, "8:2": { alias: "7:1" } }),
      variable("7:3", "7:0", "page", "COLOR", { "8:1": { alias: "5:1" }, "8:2": { alias: "5:1" } }),
    ])));
    assert.equal(out.Theme.Dark.card.$value, "{Theme.Dark.surface}");
    assert.equal(out.Theme.Dark.page.$value, "{Palette.Light.base}");
    assert.deepEqual(dtcgRefs(out).filter((r) => !r.ok), []);
  });

  it("keeps every hop of an alias chain a reference, whatever order the names sort in", () => {
    // The ordinary shape of a design system: a semantic name points at another semantic name, which points at a
    // primitive in the palette collection. Tokens are written in name order, so action/background is reached before
    // the surface it names has a value of its own; resolving them in a single pass flattened it to the palette's
    // literal, and a consumer retheming by editing the palette saw that one token keep the old colour.
    const out = variablesToDtcg(extractVariables(figDoc([
      internal,
      set("5:0", "Primitives", [["6:1", "Value"]]),
      variable("5:1", "5:0", "zinc/900", "COLOR", { "6:1": { color: [0.1, 0.1, 0.1] } }),
      set("7:0", "Semantic", [["8:1", "Light"]]),
      variable("7:1", "7:0", "action/background", "COLOR", { "8:1": { alias: "7:2" } }),
      variable("7:2", "7:0", "surface/raised", "COLOR", { "8:1": { alias: "5:1" } }),
    ])));
    assert.equal(out.Semantic.Light.action.background.$value, "{Semantic.Light.surface.raised}");
    assert.equal(out.Semantic.Light.surface.raised.$value, "{Primitives.Value.zinc.900}");
    assert.deepEqual(dtcgRefs(out).filter((r) => !r.ok), []);
  });

  it("notes an alias to a library variable absent from the file instead of a reference to nothing", () => {
    // With no value to write it is not a token: a token is an object with a $value, and $type without one is a node
    // consumers either drop or throw on. What is left says where it pointed.
    assert.deepEqual(out.Semantic.Light.brand, { $extensions: { "com.figma": { aliasOf: "library:lib-brand" } } });
    assert.deepEqual(typedWithoutValue(out), []);
  });

  it("writes no half token for an alias that resolves to nothing, an alias cycle included", () => {
    const out = variablesToDtcg(extractVariables(figDoc([
      internal,
      set("5:0", "Semantic", [["6:1", "Mode"]]),
      // Two aliases pointing at each other, which a designer makes by renaming one onto the other; neither can be
      // resolved, and nor can the third variable that reads one of them.
      variable("5:1", "5:0", "text/default", "COLOR", { "6:1": { alias: "5:2" } }),
      variable("5:2", "5:0", "text/primary", "COLOR", { "6:1": { alias: "5:1" } }),
      variable("5:3", "5:0", "text/muted", "COLOR", { "6:1": { alias: "5:1" } }),
    ])));
    assert.deepEqual(typedWithoutValue(out), []);
    assert.deepEqual(Object.keys(out.Semantic.Mode.text), ["default", "muted", "primary"]);
    assert.deepEqual(out.Semantic.Mode.text.muted, { $extensions: { "com.figma": { aliasOf: "text/default" } } });
    assert.deepEqual(dtcgRefs(out).filter((r) => !r.ok), []);
  });

  it("writes the resolved value for an alias whose collection is left out", () => {
    const cols = extractVariables(figDoc(tokens));
    const only = variablesToDtcg(cols, (c: Collection) => c.name === "Semantic");
    assert.deepEqual(Object.keys(only), ["Semantic"]);
    assert.deepEqual(only.Semantic.Light.bg, {
      $type: "color", $value: "#0000FF", $extensions: { "com.figma": { aliasOf: "blue/500" } }, $description: "Page background",
    });
  });

  it("keeps same-named collections as separate groups, and references the right one", () => {
    const out = variablesToDtcg(extractVariables(figDoc([
      internal,
      set("5:0", "Colors", [["6:1", "M"]]),
      variable("5:1", "5:0", "primary", "COLOR", { "6:1": { color: [1, 0, 0] } }),
      set("7:0", "Colors", [["8:1", "M"]]),
      variable("7:1", "7:0", "accent", "COLOR", { "8:1": { color: [0, 0, 1] } }),
      variable("7:2", "7:0", "link", "COLOR", { "8:1": { alias: "5:1" } }),
    ])));
    assert.deepEqual(Object.keys(out), ["Colors", "Colors 2"]);
    assert.deepEqual(Object.keys(out.Colors.M), ["primary"]);
    assert.equal(out["Colors 2"].M.link.$value, "{Colors.M.primary}");
  });

  it("scales opacity variables as CSS does: DTCG has no unit that could say 50 means 0.5", () => {
    assert.deepEqual(out.Primitives.Value.opacity.muted, { $type: "number", $value: 0.5 });
    // A length keeps the plain number, which is what a unitless DTCG number means.
    assert.deepEqual(out.Primitives.Value.space.md, { $type: "number", $value: 16 });
  });

  it("numbers a token whose path another token already took, instead of dropping it", () => {
    const cols = extractVariables(figDoc([
      internal,
      set("5:0", "C", [["6:1", "M"]]),
      variable("5:1", "5:0", "brand", "COLOR", { "6:1": { color: [1, 0, 0] } }),
      variable("5:2", "5:0", "brand", "COLOR", { "6:1": { color: [0, 0, 1] } }),
      variable("5:3", "5:0", "link", "COLOR", { "6:1": { alias: "5:1" } }),
    ]));
    const out = variablesToDtcg(cols);
    assert.deepEqual(Object.keys(out.C.M), ["brand", "brand-2", "link"]);
    assert.equal(out.C.M.brand.$value, "#FF0000");
    assert.equal(out.C.M["brand-2"].$value, "#0000FF");
    // Blind assignment kept only the second, and this reference to the first then resolved to it: red became blue.
    assert.equal(out.C.M.link.$value, "{C.M.brand}");
    // The same two names CSS writes.
    assert.deepEqual(rootNames(variablesToCss(cols)), ["--brand", "--brand-2", "--link"]);
  });

  it("keeps a token whose name is also a group prefix out of the token it would live inside", () => {
    const cols = extractVariables(figDoc([
      internal,
      set("5:0", "C", [["6:1", "M"]]),
      variable("5:1", "5:0", "space", "FLOAT", { "6:1": { float: 8 } }),
      variable("5:2", "5:0", "space/md", "FLOAT", { "6:1": { float: 16 } }),
      // A group named what "space" would be numbered to, and two names DTCG cannot spell apart.
      variable("5:3", "5:0", "space-2/x", "FLOAT", { "6:1": { float: 4 } }),
      variable("5:4", "5:0", "size.1/sm", "FLOAT", { "6:1": { float: 2 } }),
      variable("5:5", "5:0", "size_1/sm", "FLOAT", { "6:1": { float: 3 } }),
    ]));
    const out = variablesToDtcg(cols);
    // {"space": {"$type": "number", "$value": 8, "md": {…}}} is a token holding a token: Style Dictionary errors on
    // it or drops the child.
    assert.deepEqual(out.C.M.space, { $type: "number", $value: 8 });
    assert.deepEqual(out.C.M["space-2"], { x: { $type: "number", $value: 4 } });
    // "space/md" can use neither "space" (a token) nor "space-2" (the group another name was given).
    assert.deepEqual(out.C.M["space-3"], { md: { $type: "number", $value: 16 } });
    // "size.1" and "size_1" are one name in DTCG, so they are one group and the second token is numbered inside it,
    // as two variables named alike are; what a group must not be is one a different name was numbered into.
    assert.deepEqual(Object.keys(out.C.M.size_1), ["sm", "sm-2"]);
    // Every variable keeps a name of its own in CSS too, which writes the whole path.
    assert.deepEqual(rootNames(variablesToCss(cols)), ["--size_1-sm", "--size-1-sm", "--space", "--space-2-x", "--space-md"]);
  });

  it("numbers mode names and paths that collide only once the reserved characters are replaced", () => {
    const out = variablesToDtcg(extractVariables(figDoc([
      internal,
      set("5:0", "C", [["6:1", "v1.0"], ["6:2", "v1_0"]]),
      variable("5:1", "5:0", "size/1.5", "FLOAT", { "6:1": { float: 6 }, "6:2": { float: 7 } }),
      variable("5:2", "5:0", "size/1_5", "FLOAT", { "6:1": { float: 8 }, "6:2": { float: 9 } }),
    ])));
    assert.deepEqual(Object.keys(out.C), ["v1_0", "v1_0 2"]);
    // "size/1_5" sorts first, so it keeps the name and "size/1.5" is the one numbered.
    assert.deepEqual(Object.keys(out.C.v1_0.size), ["1_5", "1_5-2"]);
    assert.equal(out.C.v1_0.size["1_5"].$value, 8);
    assert.equal(out.C.v1_0.size["1_5-2"].$value, 6);
    assert.equal(out.C["v1_0 2"].size["1_5"].$value, 9);
  });

  it("writes a reference only to a token that has a value of its own", () => {
    const out = variablesToDtcg(extractVariables(figDoc(partial)));
    // base has no token at all in Light, so fg keeps the value rather than naming an empty path.
    assert.deepEqual(out.C.Light.fg, { $type: "color", $value: "#FF0000", $extensions: { "com.figma": { aliasOf: "base" } } });
    assert.equal(out.C.Dark.fg.$value, "{C.Dark.base}");
    // mid is in the file but aliases out of it, and odd's raw value is in no field we read.
    assert.deepEqual(out.C.Light.outer, { $extensions: { "com.figma": { aliasOf: "mid" } } });
    assert.deepEqual(out.C.Light.ref, { $extensions: { "com.figma": { aliasOf: "odd" } } });
    // odd itself has no value to write either, and a raw value we cannot read leaves nothing to say about it.
    assert.deepEqual(out.C.Light.odd, {});
    assert.deepEqual(dtcgRefs(out).filter((r) => !r.ok), []);
    assert.deepEqual(typedWithoutValue(out), []);
  });

  it("replaces the characters DTCG reserves in names, in tokens and references alike", () => {
    const out = variablesToDtcg(extractVariables(figDoc([
      internal,
      set("5:0", "C", [["6:1", "M"]]),
      variable("5:1", "5:0", "space/0.5", "FLOAT", { "6:1": { float: 2 } }),
      variable("5:2", "5:0", "gap", "FLOAT", { "6:1": { alias: "5:1" } }),
    ])));
    assert.equal(out.C.M.space["0_5"].$value, 2);
    assert.equal(out.C.M.gap.$value, "{C.M.space.0_5}");
  });
});

describe("styles", () => {
  const styles = extractStyles(figDoc([
    internal,
    { id: "3:1", type: "RECTANGLE", parent: "0:9", name: "Brand/Primary", styleType: "FILL", fillPaints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }] },
    {
      id: "3:2", type: "RECTANGLE", parent: "0:9", name: "Fade", styleType: "FILL",
      fillPaints: [{ type: "GRADIENT_LINEAR", stops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 0 } }] }],
    },
    {
      id: "3:3", type: "RECTANGLE", parent: "0:9", name: "Elevation 1", styleType: "EFFECT",
      effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 2 }, radius: 4 }, { type: "LAYER_BLUR", radius: 8, visible: false }],
    },
    {
      id: "3:4", type: "TEXT", parent: "0:9", name: "Heading/H1", styleType: "TEXT",
      fontName: { family: "Inter", style: "Bold" }, fontSize: 32, lineHeight: { units: "PERCENT", value: 120 }, textCase: "UPPER",
    },
    { id: "3:5", type: "RECTANGLE", parent: "0:9", name: "Gone", styleType: "FILL", isSoftDeletedStyle: true },
    // Real files mark most deleted styles with isSoftDeleted alone.
    { id: "3:6", type: "RECTANGLE", parent: "0:9", name: "Also gone", styleType: "FILL", isSoftDeleted: true },
    // A stale library copy: the same key at an older version.
    { id: "3:7", type: "TEXT", parent: "0:9", name: "Body", styleType: "TEXT", key: "body", version: "44:13@S2_DEDUPE_1:1", fontSize: 14 },
    { id: "3:8", type: "TEXT", parent: "0:9", name: "Body", styleType: "TEXT", key: "body", version: "44:13", fontSize: 16 },
  ]));

  it("reads each kind of style, sorted by type then name, skipping deleted ones and stale library copies", () => {
    assert.deepEqual(styles.map((s) => `${s.type} ${s.name}`), ["EFFECT Elevation 1", "FILL Brand/Primary", "FILL Fade", "TEXT Body", "TEXT Heading/H1"]);
    assert.equal(styles[3].id, "3:8");
    assert.deepEqual(styles[4].value, { fontFamily: "Inter", fontStyle: "Bold", fontSize: 32, lineHeight: "120%", textCase: "UPPER" });
  });

  it("renders fills and shadows as custom properties and text styles as classes", () => {
    const css = stylesToCss(styles);
    assert.match(css, /--brand-primary: #FF0000;/);
    // Figma's untransformed gradient runs left to right.
    assert.match(css, /--fade: linear-gradient\(90deg, #000000 0%, #FFFFFF00 100%\);/);
    assert.match(css, /--elevation-1: 0px 2px 4px 0px #00000040;/);
    assert.match(css, /\.heading-h1 \{\n {2}font-family: "Inter";\n {2}\/\* font-style: Bold \*\/\n {2}font-size: 32px;\n {2}line-height: 120%;\n {2}text-transform: uppercase;\n\}/);
  });

  const fill = (id: string, name: string, fillPaints: Raw[]): TestNode => ({ id, type: "RECTANGLE", parent: "0:9", name, styleType: "FILL", fillPaints });
  const solid = (r: number, g: number, b: number, opacity?: number) => ({ type: "SOLID", color: { r, g, b, a: 1 }, ...(opacity === undefined ? {} : { opacity }) });
  const stops = [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }];
  const css = (nodes: TestNode[]) => stylesToCss(extractStyles(figDoc([internal, ...nodes])));

  it("numbers custom properties and classes whose names collide, and escapes a class starting with a digit", () => {
    const out = css([
      fill("3:1", "White", [solid(0.92, 0.95, 0.96)]),
      fill("3:2", "White", [solid(1, 1, 1)]),
      { id: "3:3", type: "TEXT", parent: "0:9", name: "Body", styleType: "TEXT", fontSize: 14 },
      { id: "3:4", type: "TEXT", parent: "0:9", name: "body", styleType: "TEXT", fontSize: 16 },
      { id: "3:5", type: "TEXT", parent: "0:9", name: "2xl", styleType: "TEXT", fontSize: 24 },
    ]);
    assert.match(out, /--white: #EBF2F5;/);
    assert.match(out, /--white-2: #FFFFFF;/);
    assert.match(out, /^\.body \{$/m);
    assert.match(out, /^\.body-2 \{$/m);
    assert.match(out, /^\.\\32 xl \{$/m);
  });

  it("folds paint opacity into the color and composites stacked solid fills into one", () => {
    const out = css([
      fill("3:1", "Scrim", [solid(0, 0, 0, 0.5)]),
      fill("3:2", "Pressed", [solid(1, 1, 1), solid(0, 0, 0, 0.2)]),
    ]);
    assert.match(out, /--scrim: #00000080;/);
    assert.match(out, /--pressed: #CCCCCC; \/\* 2 solid fills composited \*\//);
  });

  it("turns gradients into CSS gradients, with the angle from the gradient transform", () => {
    // Rotated a quarter turn: the handles run from the top edge to the bottom edge.
    const down = { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 };
    const out = css([
      fill("3:1", "Down", [{ type: "GRADIENT_LINEAR", transform: down, stops }]),
      fill("3:2", "Glow", [{ type: "GRADIENT_RADIAL", stops, opacity: 0.5 }]),
      fill("3:3", "Sweep", [{ type: "GRADIENT_ANGULAR", stops }]),
      fill("3:4", "Diamond", [{ type: "GRADIENT_DIAMOND", stops }]),
      fill("3:5", "Tinted", [{ type: "GRADIENT_LINEAR", stops }, solid(1, 0, 0, 0.5)]),
    ]);
    assert.match(out, /--down: linear-gradient\(180deg, #000000 0%, #FFFFFF 100%\);/);
    assert.match(out, /--glow: radial-gradient\(50% 50% at 50% 50%, #00000080 0%, #FFFFFF80 100%\);/);
    assert.match(out, /--sweep: conic-gradient\(from 90deg at 50% 50%, #000000 0%, #FFFFFF 100%\);/);
    assert.match(out, /\/\* --diamond: GRADIENT_DIAMOND fill has no CSS equivalent \*\//);
    // Background layers list the top fill first; Figma lists it last.
    assert.match(out, /--tinted: linear-gradient\(#FF000080, #FF000080\), linear-gradient\(90deg, #000000 0%, #FFFFFF 100%\);/);
  });

  it("marks inner shadows inset, keeps effects with no shadow syntax out, and names a missing line height", () => {
    const out = css([
      {
        id: "3:1", type: "RECTANGLE", parent: "0:9", name: "Inset", styleType: "EFFECT",
        effects: [
          { type: "INNER_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 1, y: 2 }, radius: 3, spread: 4 },
          // Normalizer.effect already drops an invisible effect, so only a visible blur reaches the filter here.
          { type: "LAYER_BLUR", radius: 8 },
        ],
      },
      { id: "3:2", type: "TEXT", parent: "0:9", name: "Plain", styleType: "TEXT", fontSize: 14 },
    ]);
    assert.match(out, /--inset: inset 1px 2px 3px 4px #00000080;/);
    assert.doesNotMatch(out, /undefined/);
    // "line-height: 0" is a real value; a text style that sets none means the font's own.
    assert.match(out, /\.plain \{\n {2}font-size: 14px;\n {2}line-height: normal;\n\}/);
  });

  it("takes a radial gradient's two radii from the transform, and rounds stop positions", () => {
    // Half as tall as it is wide: the vertical radius reaches the layer's edge, the horizontal one stops halfway.
    const squashed = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 0.5, m12: 0.25 };
    // 0.29 * 100 is 28.999999999999996 in binary floating point, so the percentage is rounded.
    const graded = [{ position: 0.29, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }];
    const out = css([fill("3:1", "Halo", [{ type: "GRADIENT_RADIAL", transform: squashed, stops: graded }])]);
    assert.match(out, /--halo: radial-gradient\(50% 100% at 50% 50%, #000000 29%, #FFFFFF 100%\);/);
  });

  it("writes stroke styles as custom properties too", () => {
    const out = css([{ id: "3:1", type: "RECTANGLE", parent: "0:9", name: "Border", styleType: "STROKE", fillPaints: [solid(0, 0, 0, 0.1)] }]);
    assert.match(out, /--border: #0000001A;/);
  });

  it("escapes a text style's family and keeps a font style name from ending the comment it sits in", () => {
    const out = css([
      {
        id: "3:1", type: "TEXT", parent: "0:9", name: "Body/Default", styleType: "TEXT",
        // A family named outside ASCII and quoting part of itself is ordinary; the style name is what a hostile or
        // broken file carries, and it used to close the comment and leave "color: red" live inside .body-default.
        fontName: { family: 'Noto Sans "JP"\n', style: "*/ color: red; /*" }, fontSize: 16,
      },
      // Two styles whose names differ only where CSS identifiers cannot: the second is numbered, and the comment
      // that says which style it is carries the name as written.
      { id: "3:2", type: "TEXT", parent: "0:9", name: "Caption */ x", styleType: "TEXT", fontSize: 14 },
      { id: "3:3", type: "TEXT", parent: "0:9", name: "Caption **/ x", styleType: "TEXT", fontSize: 12 },
    ]);
    // JSON.stringify wrote a newline in a family as the letter n, so "Ev\nil" became "Evnil".
    assert.ok(out.includes('  font-family: "Noto Sans \\"JP\\"\\A ";'), out);
    assert.doesNotMatch(out, /\*\/ color/);
    assert.match(out, /\/\* Caption \*+ \/ x \(TEXT\) \*\/\n\.caption-x-2 \{/);
    assert.doesNotMatch(withoutComments(out), /color: red/);
  });

  it("names the style a numbered custom property came from, which its own name no longer does", () => {
    // Fill, stroke and effect styles are numbered as one sequence, so "--brand-2" here is the style "Brand".
    const out = css([
      { id: "3:1", type: "RECTANGLE", parent: "0:9", name: "Brand", styleType: "EFFECT", effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 1 }, radius: 2 }] },
      fill("3:2", "Brand", [solid(1, 0, 0)]),
      fill("3:3", "Brand 2", [solid(0, 1, 0)]),
      { id: "3:4", type: "RECTANGLE", parent: "0:9", name: "Brand", styleType: "STROKE", fillPaints: [solid(0, 0, 1)] },
    ]);
    assert.match(out, /^ {2}--brand: 0px 1px 2px 0px #00000040;$/m);
    assert.match(out, /^ {2}--brand-2: #FF0000; \/\* Brand \(FILL\) \*\/$/m);
    assert.match(out, /^ {2}--brand-2-2: #00FF00; \/\* Brand 2 \(FILL\) \*\/$/m);
    assert.match(out, /^ {2}--brand-3: #0000FF; \/\* Brand \(STROKE\) \*\/$/m);
  });

  it("gives a style with no usable name an id-based one", () => {
    assert.match(css([fill("3:1", "🎨", [solid(1, 0, 0)])]), /--style-3-1: #FF0000;/);
  });
});

describe("cssIdent", () => {
  it("hyphenates separators and camelCase, keeps non-ASCII letters, and never returns an empty identifier", () => {
    assert.equal(cssIdent(" Brand/Primary.Dark "), "brand-primary-dark");
    assert.equal(cssIdent("bodyLarge"), "body-large");
    assert.equal(cssIdent("Café/Crème"), "café-crème");
    assert.equal(cssIdent("/Primary/"), "primary");
    assert.equal(cssIdent("✨", "fallback"), "fallback");
  });
});
