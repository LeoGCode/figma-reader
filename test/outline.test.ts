// figma_get_tree's outline is what an agent reads first to find node ids, so its hints and its cut-off are pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { outline } from "../src/outline.ts";
import { figDoc, guid, type TestNode } from "./fixtures.ts";

const nodes: TestNode[] = [
  { id: "0:1", type: "CANVAS", parent: "0:0", name: "Screens" },
  { id: "1:1", type: "FRAME", parent: "0:1", name: "Login", size: { x: 390.4, y: 844 }, stackMode: "VERTICAL" },
  { id: "1:2", type: "TEXT", parent: "1:1", name: "Title", textData: { characters: "Welcome\n  back" } },
  { id: "1:3", type: "TEXT", parent: "1:1", name: "Terms", visible: false, textData: { characters: "x".repeat(80) } },
  { id: "1:4", type: "INSTANCE", parent: "1:1", name: "CTA", symbolData: { symbolID: guid("2:1") } },
  { id: "0:2", type: "CANVAS", parent: "0:0", name: "Components" },
  { id: "2:1", type: "SYMBOL", parent: "0:2", name: "Button" },
  { id: "0:3", type: "CANVAS", parent: "0:0", name: "Internal", internalOnly: true },
];
const doc = figDoc(nodes);

test("each line carries id, type, name, size and the hints that identify a layer", () => {
  assert.equal(outline(doc, doc.require("1:1"), 1, 100), [
    '- 1:1 FRAME "Login" 390x844 (auto-layout vertical)',
    '  - 1:2 TEXT "Title" ("Welcome back")',
    `  - 1:3 TEXT "Terms" (hidden, "${"x".repeat(57)}...")`,
    '  - 1:4 INSTANCE "CTA" (of "Button")',
  ].join("\n"));
});

test("the document root lists visible pages, and nodes below the depth are counted, not listed", () => {
  assert.equal(outline(doc, doc.get(doc.rootId)!, 0, 100), [
    '- 0:1 PAGE "Screens" (1 children)',
    '- 0:2 PAGE "Components" (1 children)',
  ].join("\n"));
});

test("output stops at max_nodes and says so, but only when something was left out", () => {
  const cut = outline(doc, doc.require("1:1"), 1, 2).split("\n");
  assert.equal(cut.length, 3);
  assert.match(cut[2], /truncated at 2 nodes/);
  // Exactly max_nodes nodes fit: nothing was cut, so no truncation note.
  assert.doesNotMatch(outline(doc, doc.require("1:1"), 1, 4), /truncated/);
});
