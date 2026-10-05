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
const root = (d: ReturnType<typeof figDoc>) => d.get(d.rootId)!;
/** n children of parent, ids prefix:1..n, in that order. */
const kids = (parent: string, prefix: string, n: number, make: (i: number) => Partial<TestNode> = () => ({})): TestNode[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}:${i + 1}`, type: "FRAME", parent, name: `${prefix}.${i + 1}`, position: String(i).padStart(6, "0"), ...make(i),
  }));

test("each line carries id, type, name, size and the hints that identify a layer", () => {
  assert.equal(outline(doc, doc.require("1:1"), 1, 100), [
    '- 1:1 FRAME "Login" 390x844 (auto-layout vertical)',
    '  - 1:2 TEXT "Title" ("Welcome back")',
    `  - 1:3 TEXT "Terms" (hidden, "${"x".repeat(57)}...")`,
    '  - 1:4 INSTANCE "CTA" (of "Button")',
  ].join("\n"));
});

test("the document root lists visible pages, and nodes below the depth are counted, not listed", () => {
  assert.equal(outline(doc, root(doc), 0, 100), [
    '- 0:1 PAGE "Screens" (1 child)',
    '- 0:2 PAGE "Components" (1 child)',
  ].join("\n"));
});

test("a frame's Dev Mode status is a hint, and so is the status a frame had before its mark came off", () => {
  const info = (status: string, prevStatus: string) => ({ sectionStatusInfo: { status, prevStatus, lastUpdateUnixTimestamp: 1790848800 } });
  const marked = figDoc([
    { id: "0:1", type: "CANVAS", parent: "0:0", name: "Handoff" },
    { id: "1:1", type: "FRAME", parent: "0:1", name: "Ready", visible: false, ...info("BUILD", "NONE") },
    { id: "1:2", type: "FRAME", parent: "0:1", name: "Done", ...info("COMPLETED", "BUILD") },
    { id: "1:3", type: "FRAME", parent: "0:1", name: "Unmarked", ...info("NONE", "BUILD") },
    { id: "1:4", type: "SECTION", parent: "0:1", name: "Reopened", ...info("NONE", "COMPLETED") },
    // The records Figma keeps on components nobody marked say nothing, so they add no hint.
    { id: "1:5", type: "SYMBOL", parent: "0:1", name: "Never", ...info("NONE", "NONE") },
    { id: "1:6", type: "FRAME", parent: "0:1", name: "Later", ...info("IN_REVIEW", "NONE") },
    // A person left this one, which get-node shows, but none and none names no status for a hint to give.
    { id: "1:7", type: "FRAME", parent: "0:1", name: "Touched", sectionStatusInfo: { status: "NONE", prevStatus: "NONE", userId: "1234567" } },
  ]);
  assert.equal(outline(marked, marked.require("0:1"), 1, 100), [
    '- 0:1 PAGE "Handoff"',
    '  - 1:1 FRAME "Ready" (hidden, ready for dev)',
    '  - 1:2 FRAME "Done" (completed)',
    '  - 1:3 FRAME "Unmarked" (was ready for dev)',
    '  - 1:4 SECTION "Reopened" (was completed)',
    '  - 1:5 COMPONENT "Never"',
    '  - 1:6 FRAME "Later" (dev status IN_REVIEW)',
    '  - 1:7 FRAME "Touched"',
  ].join("\n"));
});

test("output stops at max_nodes and says so, but only when something was left out", () => {
  // The marker for what a branch left out is a line too, so max_nodes still bounds the output.
  assert.deepEqual(outline(doc, doc.require("1:1"), 1, 3).split("\n"), [
    '- 1:1 FRAME "Login" 390x844 (auto-layout vertical)',
    '  - 1:2 TEXT "Title" ("Welcome back")',
    "  - ... 2 more children",
    "... truncated at 3 nodes; use a node_id or smaller depth",
  ]);
  // No room for a child and its marker: the frame says how many children it has instead, as it does at the depth,
  // and the last line says which level did not start and what it would take, since nothing above it was cut.
  assert.deepEqual(outline(doc, doc.require("1:1"), 1, 2).split("\n"), [
    '- 1:1 FRAME "Login" 390x844 (auto-layout vertical, 3 children)',
    "... level 1 not shown: 1 layer has children, 1 of 2 lines left; open one with node_id, or pass max_nodes 3",
  ]);
  assert.equal(outline(doc, doc.require("1:1"), 1, 3).split("\n")[1], '  - 1:2 TEXT "Title" ("Welcome back")', "and 3 starts it");
  // Exactly max_nodes nodes fit: nothing was cut, so no truncation note.
  assert.doesNotMatch(outline(doc, doc.require("1:1"), 1, 4), /truncated|more/);
});

test("prints what fits in tree order, exactly as depth-first did, when nothing is cut", () => {
  // Spending the budget breadth first picks nodes in a different order from the one they are printed in. An outline
  // that is not cut must still be the plain depth-first listing it always was, hint for hint.
  const tree = figDoc([
    { id: "0:1", type: "CANVAS", parent: "0:0", name: "A" },
    { id: "1:1", type: "FRAME", parent: "0:1", name: "a1" },
    { id: "1:2", type: "FRAME", parent: "1:1", name: "a1.1" },
    { id: "1:3", type: "TEXT", parent: "1:2", name: "deep" },
    { id: "1:4", type: "FRAME", parent: "1:1", name: "a1.2" },
    { id: "1:5", type: "FRAME", parent: "0:1", name: "a2" },
    { id: "0:2", type: "CANVAS", parent: "0:0", name: "B" },
    { id: "2:1", type: "FRAME", parent: "0:2", name: "b1" },
  ]);
  const expected = [
    '- 0:1 PAGE "A"',
    '  - 1:1 FRAME "a1"',
    '    - 1:2 FRAME "a1.1" (1 child)',
    '    - 1:4 FRAME "a1.2"',
    '  - 1:5 FRAME "a2"',
    '- 0:2 PAGE "B"',
    '  - 2:1 FRAME "b1"',
  ].join("\n");
  assert.equal(outline(tree, root(tree), 2, 7), expected, "exactly max_nodes");
  assert.equal(outline(tree, root(tree), 2, 400), expected);
});

test("a huge first section cannot take the budget from the pages after it", () => {
  // The real case: page 1's icon section of 1,513 instances took all 900 lines of --depth 2 --max-nodes 900, and no
  // other page appeared. Every page and every top-level layer comes first now, and the level under them is shared.
  const big = figDoc([
    { id: "0:1", type: "CANVAS", parent: "0:0", name: "Icons" },
    { id: "1:1", type: "SECTION", parent: "0:1", name: "Phosphor" },
    ...kids("1:1", "10", 1000, () => ({ type: "INSTANCE" })),
    { id: "1:2", type: "FRAME", parent: "0:1", name: "Legend" },
    ...kids("1:2", "11", 2),
    { id: "0:2", type: "CANVAS", parent: "0:0", name: "Screens" },
    { id: "2:1", type: "FRAME", parent: "0:2", name: "Login" },
    ...kids("2:1", "20", 3),
    { id: "0:3", type: "CANVAS", parent: "0:0", name: "Empty" },
  ]);
  const lines = outline(big, root(big), 2, 50).split("\n");
  assert.ok(lines.length <= 51, `${lines.length} lines for max_nodes 50`);
  const ids = lines.map((l) => l.trim().split(" ")[1]);
  for (const id of ["0:1", "1:1", "1:2", "11:1", "11:2", "0:2", "2:1", "20:1", "20:2", "20:3", "0:3"]) assert.ok(ids.includes(id), id);
  // The section shows what the rest leave: 3 pages, 3 layers and 5 children elsewhere, its marker, so 38 of its own.
  assert.equal(lines.filter((l) => l.startsWith('    - 10:')).length, 38);
  // The marker is on the branch that was cut, where the rest of that branch would be, and the last line still says so.
  assert.equal(lines[ids.indexOf("10:38") + 1], "    - ... 962 more children");
  assert.equal(lines[ids.indexOf("10:38") + 2], '  - 1:2 FRAME "Legend"');
  assert.equal(lines.at(-1), "... truncated at 50 nodes; use a node_id or smaller depth");
});

test("parents on one level share it evenly, and a level that cannot give each one child is not started", () => {
  const two = figDoc([
    { id: "0:1", type: "CANVAS", parent: "0:0", name: "P" },
    { id: "1:1", type: "FRAME", parent: "0:1", name: "first" },
    ...kids("1:1", "10", 10),
    { id: "1:2", type: "FRAME", parent: "0:1", name: "second" },
    ...kids("1:2", "20", 10),
  ]);
  // 12 lines: the page and both frames, then 9 for the level under them. Each frame gets 3 children and a marker
  // (8 lines), and the one line over goes to the first frame.
  const shared = outline(two, root(two), 2, 12).split("\n");
  assert.deepEqual(shared.map((l) => l.trim().split(" ")[1]), [
    "0:1", "1:1", "10:1", "10:2", "10:3", "10:4", "...", "1:2", "20:1", "20:2", "20:3", "...", "truncated",
  ]);
  assert.deepEqual(shared.filter((l) => l.includes("more children")).map((l) => l.trim()), ["- ... 6 more children", "- ... 7 more children"]);
  // A marker never stands for a single child, since that child fits in its line: an even share of 2 each would have
  // left "1 more" under a frame of 3.
  const uneven = figDoc([
    { id: "0:1", type: "CANVAS", parent: "0:0", name: "P" },
    { id: "1:1", type: "FRAME", parent: "0:1", name: "small" },
    ...kids("1:1", "10", 3),
    { id: "1:2", type: "FRAME", parent: "0:1", name: "large" },
    ...kids("1:2", "20", 10),
  ]);
  assert.deepEqual(outline(uneven, root(uneven), 2, 9).split("\n").map((l) => l.trim().split(" ").slice(1, 3).join(" ")), [
    "0:1 PAGE", "1:1 FRAME", "10:1 FRAME", "10:2 FRAME", "10:3 FRAME", "1:2 FRAME", "20:1 FRAME", "20:2 FRAME", "... 8", "truncated at",
  ]);
  // 4 lines leave one for the level under the frames: not enough for a child each, so each frame counts its own.
  // Nothing shown was cut, so "truncated, use a smaller depth" would be false: the last line says the level did not
  // start, and the max_nodes that starts it - a child and a marker for each of the two frames, 3 + 4.
  assert.deepEqual(outline(two, root(two), 2, 4).split("\n"), [
    '- 0:1 PAGE "P"',
    '  - 1:1 FRAME "first" (10 children)',
    '  - 1:2 FRAME "second" (10 children)',
    "... level 2 not shown: 2 layers have children, 1 of 4 lines left; open one with node_id, or pass max_nodes 7",
  ]);
  assert.deepEqual(outline(two, root(two), 2, 7).split("\n").slice(1, 4), ['  - 1:1 FRAME "first"', '    - 10:1 FRAME "10.1"', "    - ... 9 more children"]);
  assert.match(outline(two, root(two), 2, 6), /level 2 not shown/, "and one less does not");
});

test("a parent with one child needs no marker line to start a level", () => {
  // The needed max_nodes counts one line for an only child and two (a child and its marker) for more.
  const mixed = figDoc([
    { id: "0:1", type: "CANVAS", parent: "0:0", name: "P" },
    { id: "1:1", type: "FRAME", parent: "0:1", name: "only" },
    ...kids("1:1", "10", 1),
    { id: "1:2", type: "FRAME", parent: "0:1", name: "many" },
    ...kids("1:2", "20", 5),
  ]);
  assert.equal(outline(mixed, root(mixed), 2, 3).split("\n").at(-1), "... level 2 not shown: 2 layers have children, 0 of 3 lines left; open one with node_id, or pass max_nodes 6");
  assert.match(outline(mixed, root(mixed), 2, 6), /- 10:1 FRAME "10\.1"\n.*- 20:1 FRAME "20\.1"\n.*- \.\.\. 4 more children\n\.\.\. truncated at 6 nodes/s);
  // The only child counts as one, and says so in the singular.
  assert.match(outline(mixed, root(mixed), 1, 10), /- 1:1 FRAME "only" \(1 child\)/);
});

test("more pages than max_nodes are cut like any other level", () => {
  const pages = figDoc(kids("0:0", "0", 6, () => ({ type: "CANVAS" })).map((p) => ({ ...p, id: `0:${p.id.split(":")[1]}` })));
  assert.deepEqual(outline(pages, root(pages), 0, 3).split("\n"), [
    '- 0:1 PAGE "0.1"',
    '- 0:2 PAGE "0.2"',
    "- ... 4 more pages",
    "... truncated at 3 nodes; use a node_id or smaller depth",
  ]);
});

test("a layer drawn only with vector shapes is one line counting them", () => {
  // One frame at depth 6 printed 31 VECTOR lines for two logos, and agents piped the tree through grep -v VECTOR.
  const drawn = figDoc([
    { id: "0:1", type: "CANVAS", parent: "0:0", name: "P" },
    { id: "1:1", type: "FRAME", parent: "0:1", name: "Header" },
    { id: "2:1", type: "GROUP", parent: "1:1", name: "Logo", size: { x: 120, y: 32 } },
    ...kids("2:1", "21", 25, (i) => ({ type: ["VECTOR", "ELLIPSE", "STAR", "LINE", "REGULAR_POLYGON"][i % 5] })),
    // A boolean operation is one shape whatever its operands are.
    { id: "2:2", type: "BOOLEAN_OPERATION", parent: "2:1", name: "Union", position: "~1" },
    { id: "2:3", type: "VECTOR", parent: "2:2", name: "a" },
    { id: "2:4", type: "VECTOR", parent: "2:2", name: "b" },
    { id: "3:1", type: "FRAME", parent: "1:1", name: "icon" },
    { id: "3:2", type: "VECTOR", parent: "3:1", name: "path" },
    // Not drawings: text next to the shapes, a rectangle (a background as often as a shape), a picture in a circle,
    // and a photo used as a circle's border, which is as much an image as a fill.
    { id: "4:1", type: "GROUP", parent: "1:1", name: "Badge" },
    { id: "4:2", type: "VECTOR", parent: "4:1", name: "star" },
    { id: "4:3", type: "TEXT", parent: "4:1", name: "label" },
    { id: "5:1", type: "GROUP", parent: "1:1", name: "Bars" },
    { id: "5:2", type: "RECTANGLE", parent: "5:1", name: "bar" },
    { id: "6:1", type: "FRAME", parent: "1:1", name: "Avatar" },
    { id: "6:2", type: "ELLIPSE", parent: "6:1", name: "photo", fillPaints: [{ type: "IMAGE" }] },
    { id: "7:1", type: "FRAME", parent: "1:1", name: "Framed" },
    { id: "7:2", type: "ELLIPSE", parent: "7:1", name: "border", strokePaints: [{ type: "IMAGE" }] },
  ]);
  assert.equal(outline(drawn, drawn.require("1:1"), 6, 400), [
    '- 1:1 FRAME "Header"',
    '  - 2:1 GROUP "Logo" 120x32 (26 vectors)',
    '  - 3:1 FRAME "icon" (1 vector)',
    '  - 4:1 GROUP "Badge"',
    '    - 4:2 VECTOR "star"',
    '    - 4:3 TEXT "label"',
    '  - 5:1 GROUP "Bars"',
    '    - 5:2 RECTANGLE "bar"',
    '  - 6:1 FRAME "Avatar"',
    '    - 6:2 ELLIPSE "photo"',
    '  - 7:1 FRAME "Framed"',
    '    - 7:2 ELLIPSE "border"',
  ].join("\n"));
  // Past the depth the count names what it counts.
  assert.match(outline(drawn, drawn.require("1:1"), 0, 400), /^- 1:1 FRAME "Header" \(6 children\)$/);
  assert.match(outline(drawn, drawn.get(drawn.rootId)!, 2, 400), /- 2:1 GROUP "Logo" 120x32 \(26 vectors\)/);
  // Asking for the drawing itself is how its shapes are seen: the node asked for is always listed.
  const logo = outline(drawn, drawn.require("2:1"), 1, 400).split("\n");
  assert.equal(logo.length, 27);
  assert.deepEqual([logo[0], logo[26]], ['- 2:1 GROUP "Logo" 120x32', '  - 2:2 BOOLEAN_OPERATION "Union" (2 vectors)']);
  // Shapes counted on their parent's line are not lines, so they spend none of max_nodes: the twelve above fit twelve.
  assert.doesNotMatch(outline(drawn, drawn.require("1:1"), 6, 12), /truncated/);
});
