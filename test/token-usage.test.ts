// figma_token_usage groups text into typography combos; a combo must stay one style, never two merged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenUsage } from "../src/token-usage.ts";
import { figDoc, type TestNode } from "./fixtures.ts";

const font = { family: "Inter", style: "Regular" };
const text = (id: string, fields: object = {}, styleOverrideTable?: object[]): TestNode => ({
  id, type: "TEXT", parent: "0:1", name: `t${id}`, fontName: font, fontSize: 14,
  textData: { characters: "Label", ...(styleOverrideTable ? { characterStyleIDs: [0, 0, 1, 1, 1], styleOverrideTable } : {}) }, ...fields,
});
const all = (nodes: TestNode[], opts: { includeHidden?: boolean } = {}) => {
  const doc = figDoc([{ id: "0:1", type: "CANVAS", parent: "0:0", name: "Page" }, ...nodes]);
  return tokenUsage(doc, doc.pages(), opts);
};
const usage = (nodes: TestNode[]) => all(nodes).typography.map(({ count, ...t }) => [t, count]);
const plain = { fontFamily: "Inter", fontStyle: "Regular", fontSize: 14 };

test("text case, decoration and paragraph spacing make distinct combos", () => {
  // The key used to stop at letter spacing: all four merged into one entry described by whichever came first.
  assert.deepEqual(usage([text("1:1"), text("1:2", { textCase: "UPPER" }), text("1:3", { textCase: "UPPER" }), text("1:4", { textDecoration: "UNDERLINE" }), text("1:5", { paragraphSpacing: 8 })]), [
    [{ fontFamily: "Inter", fontStyle: "Regular", fontSize: 14, textCase: "UPPER" }, 2],
    [{ fontFamily: "Inter", fontStyle: "Regular", fontSize: 14 }, 1],
    [{ fontFamily: "Inter", fontStyle: "Regular", fontSize: 14, textDecoration: "UNDERLINE" }, 1],
    [{ fontFamily: "Inter", fontStyle: "Regular", fontSize: 14, paragraphSpacing: 8 }, 1],
  ]);
});

test("runs that change only case or decoration count as their own combo; runs that only recolor do not", () => {
  assert.deepEqual(usage([
    text("1:1", {}, [{ styleID: 1, textDecoration: "UNDERLINE" }]),
    text("1:2", { textCase: "UPPER" }, [{ styleID: 1, textCase: "ORIGINAL" }]),
    text("1:3", {}, [{ styleID: 1, fillPaints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }] }]),
  ]), [
    [{ fontFamily: "Inter", fontStyle: "Regular", fontSize: 14 }, 3],
    [{ fontFamily: "Inter", fontStyle: "Regular", fontSize: 14, textDecoration: "UNDERLINE" }, 1],
    [{ fontFamily: "Inter", fontStyle: "Regular", fontSize: 14, textCase: "UPPER" }, 1],
  ]);
});

test("a run that resets line height or letter spacing reports the style it leaves, not the node's twice", () => {
  // Normalizer.textStyle leaves out "Auto" line height (PERCENT 100) and zero letter spacing too, so merging the
  // run over the node changed nothing and the node's own combo was counted a second time.
  assert.deepEqual(usage([
    text("1:1", { lineHeight: { units: "PIXELS", value: 20 } }, [{ styleID: 1, lineHeight: { units: "PERCENT", value: 100 } }]),
    text("1:2", { letterSpacing: { units: "PIXELS", value: 2 } }, [{ styleID: 1, letterSpacing: { units: "PIXELS", value: 0 } }]),
    // A reset of what the node never set leaves the node's own style: one text node, counted once.
    text("1:3", {}, [{ styleID: 1, letterSpacing: { units: "PIXELS", value: 0 } }]),
  ]), [
    [plain, 3],
    [{ ...plain, lineHeight: 20 }, 1],
    [{ ...plain, letterSpacing: 2 }, 1],
  ]);
});

test("a styleOverrideTable entry no character points at is not a combo in use", () => {
  // Stale entries pile up as runs are edited; textRuns keys the table by characterStyleIDs, which here are 0 and 1.
  assert.deepEqual(usage([text("1:1", {}, [{ styleID: 1, textCase: "UPPER" }, { styleID: 7, fontSize: 40 }])]), [
    [plain, 1],
    [{ ...plain, textCase: "UPPER" }, 1],
  ]);
});

test("the characters past the end of characterStyleIDs render style 0, so its entry is in use", () => {
  // Figma writes characterStyleIDs only as far as the runs it has edited, and textRuns reads everything past the end
  // as style 0. Here that is four of the six characters, and the table's entry for 0 is the size they render at: a
  // stale-entry rule that skipped it dropped a typography size the design really shows.
  assert.deepEqual(usage([text("1:1", {
    textData: {
      characters: "abcdef",
      characterStyleIDs: [1, 1],
      styleOverrideTable: [{ styleID: 1, textCase: "UPPER" }, { styleID: 0, fontSize: 40 }],
    },
  })]), [
    [plain, 1],
    [{ ...plain, textCase: "UPPER" }, 1],
    [{ ...plain, fontSize: 40 }, 1],
  ]);
});

test("per-side stroke weights are reported as the four sides, and a paint's opacity is part of its colour", () => {
  const out = all([{
    id: "1:1", type: "RECTANGLE", parent: "0:1", name: "divider",
    strokePaints: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
    fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 0.5 }],
    borderStrokeWeightsIndependent: true, borderBottomWeight: 1, strokeWeight: 1,
  }]);
  assert.deepEqual(out.strokeWidths, [{ value: "0 0 1 0", count: 1 }]);
  assert.deepEqual(out.colors.map((c) => c.value), ["#00000080", "#FFFFFF"]);
});

test("nothing inside a hidden node is counted, as scanText also skips a hidden subtree", () => {
  const nodes: TestNode[] = [
    { id: "1:1", type: "FRAME", parent: "0:1", name: "hidden", visible: false },
    { id: "1:2", type: "RECTANGLE", parent: "1:1", name: "inside", fillPaints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }] },
  ];
  assert.deepEqual(all(nodes).colors, []);
  assert.deepEqual(all(nodes, { includeHidden: true }).colors.map((c) => c.value), ["#FF0000"]);
});

test("counts text that records no typography instead of listing a combo of nothing", () => {
  // Every field textStyle reads is inherited or unset here, so the entry used to be {count: n} on its own: an
  // entry in a list of "the raw values this subtree uses" that names no value.
  const bare: TestNode = { id: "1:9", type: "TEXT", parent: "0:1", name: "bare", textData: { characters: "Label" } };
  const u = all([bare, { ...bare, id: "1:10" }]);
  assert.equal(u.typography.length, 0, JSON.stringify(u.typography));
  assert.equal(u.textWithoutTypography, 2);
});

test("text that records no typography still counts the stroke and effect it does record", () => {
  // Counting the node instead of listing an empty combo skipped the rest of the node with it: the shadow under a
  // label whose type is all inherited is a value the subtree uses, and it went missing from the answer.
  const u = all([{
    id: "1:9", type: "TEXT", parent: "0:1", name: "bare", textData: { characters: "Label" },
    strokePaints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }], strokeWeight: 2,
    effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 2 }, radius: 4 }],
  }]);
  assert.equal(u.textWithoutTypography, 1);
  assert.deepEqual(u.strokeWidths, [{ value: 2, count: 1 }]);
  assert.deepEqual(u.effects.map((e) => e.type), ["DROP_SHADOW"]);
});
