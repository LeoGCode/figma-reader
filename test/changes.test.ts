// What changed between two snapshots, and what one snapshot's edit times say changed. A diff that lists a layer as
// removed when it moved, or misses an id removed deep in a frame, sends an agent to report a deletion that never
// happened, or to cite an id that is gone - both happened by hand before these tools existed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { changesSince, diffDocuments, parseSince, topLevelLayers } from "../src/changes.ts";
import { figDoc, internalPage, type TestNode } from "./fixtures.ts";

const ids = (l: Record<string, any>[]) => l.map((e) => e.id);

describe("topLevelLayers", () => {
  it("are a page's children and, through sections, what the sections hold, each section followed by its layers", () => {
    const doc = figDoc([
      { id: "0:1", type: "CANVAS", parent: "0:0", name: "Page" },
      { id: "1:1", type: "FRAME", parent: "0:1", name: "Loose" },
      { id: "1:2", type: "FRAME", parent: "1:1", name: "inside a frame" },
      { id: "2:1", type: "SECTION", parent: "0:1", name: "Flow" },
      { id: "2:2", type: "FRAME", parent: "2:1", name: "Screen" },
      { id: "2:3", type: "TEXT", parent: "2:2", name: "inside a screen" },
      { id: "2:4", type: "SECTION", parent: "2:1", name: "Nested" },
      { id: "2:5", type: "FRAME", parent: "2:4", name: "Deep screen" },
      { id: "3:1", type: "FRAME", parent: "0:1", name: "Last" },
    ]);
    assert.deepEqual(ids(topLevelLayers(doc, doc.get("0:1")!)), ["1:1", "2:1", "2:2", "2:4", "2:5", "3:1"]);
  });

  it("takes a section of any width, in both tools", () => {
    // Its children were spread into one push, one argument each, and 150,000 of them overflowed the stack.
    const n = 150_000;
    const nodes: TestNode[] = [
      { id: "0:1", type: "CANVAS", parent: "0:0", name: "Icons" },
      { id: "1:1", type: "SECTION", parent: "0:1", name: "All icons" },
    ];
    for (let i = 0; i < n; i++) {
      nodes.push({ id: `2:${i + 1}`, type: "FRAME", parent: "1:1", name: "icon", position: String(i).padStart(6, "0"), editInfo: { createdAt: 1, lastEditedAt: 2 } });
    }
    const doc = figDoc(nodes);
    assert.equal(topLevelLayers(doc, doc.get("0:1")!).length, n + 1);
    assert.equal(diffDocuments(doc, doc, 1).counts.layersAdded, 0);
    assert.equal(changesSince(doc, new Date(0), 1).total, n + 1);
  });
});

describe("diffDocuments", () => {
  const pageA: TestNode = { id: "0:1", type: "CANVAS", parent: "0:0", name: "Screens" };
  const pageB: TestNode = { id: "0:2", type: "CANVAS", parent: "0:0", name: "Archive" };
  const before = figDoc([
    pageA, pageB, internalPage,
    { id: "1:1", type: "FRAME", parent: "0:1", name: "Login" },
    { id: "1:2", type: "FRAME", parent: "1:1", name: "Form" },
    { id: "1:3", type: "TEXT", parent: "1:2", name: "Password hint" },
    { id: "2:1", type: "FRAME", parent: "0:1", name: "Signup" },
    { id: "2:2", type: "FRAME", parent: "2:1", name: "Header" },
    { id: "2:3", type: "INSTANCE", parent: "2:2", name: "Logo" },
    { id: "3:1", type: "FRAME", parent: "0:1", name: "Onboarding" },
    { id: "4:1", type: "FRAME", parent: "0:1", name: "Settings" },
    { id: "5:1", type: "SECTION", parent: "0:1", name: "v1" },
    { id: "5:2", type: "FRAME", parent: "5:1", name: "Home" },
    { id: "5:3", type: "SECTION", parent: "0:1", name: "v2" },
    { id: "6:1", type: "SECTION", parent: "0:1", name: "Flows" },
    { id: "6:2", type: "FRAME", parent: "6:1", name: "Checkout" },
    { id: "7:1", type: "FRAME", parent: "0:1", name: "Popover" },
    { id: "7:2", type: "VECTOR", parent: "7:1", name: "Arrow" },
    { id: "8:1", type: "SYMBOL", parent: "0:9", name: "Library copy" },
  ]);
  const after = figDoc([
    { ...pageA, name: "Screens v2" }, pageB, internalPage,
    { id: "0:3", type: "CANVAS", parent: "0:0", name: "New page" },
    { id: "1:1", type: "FRAME", parent: "0:1", name: "Sign in" }, // renamed
    { id: "1:2", type: "FRAME", parent: "1:1", name: "Form" }, // 1:3 removed from inside it
    // 2:1 Signup removed, with everything in it
    { id: "3:1", type: "FRAME", parent: "0:2", name: "Onboarding" }, // to another page
    { id: "4:1", type: "FRAME", parent: "1:1", name: "Settings" }, // into a frame, no longer top-level
    { id: "5:1", type: "SECTION", parent: "0:1", name: "v1" },
    { id: "5:3", type: "SECTION", parent: "0:1", name: "v2" },
    { id: "5:2", type: "FRAME", parent: "5:3", name: "Home" }, // from one section to another
    { id: "6:1", type: "SECTION", parent: "0:2", name: "Flows" }, // a whole section to another page
    { id: "6:2", type: "FRAME", parent: "6:1", name: "Checkout" }, // carried along, not moved itself
    { id: "7:1", type: "FRAME", parent: "0:1", name: "Popover" }, // 7:2 removed from it
    { id: "9:1", type: "FRAME", parent: "0:1", name: "Paywall" }, // added
    { id: "9:2", type: "FRAME", parent: "5:1", name: "Home v2" }, // added inside a section
    // 8:1 on the internal-only page is gone too
  ]);
  const d = diffDocuments(before, after, 100);

  it("reports pages added, removed and renamed by id", () => {
    assert.deepEqual(d.pages, {
      added: [{ id: "0:3", name: "New page" }],
      removed: [],
      renamed: [{ id: "0:1", oldName: "Screens", name: "Screens v2" }],
    });
  });

  it("calls a layer renamed or moved, never removed and added, as long as its id is there", () => {
    // Page order: the section v1 comes before Paywall.
    assert.deepEqual(ids(d.layers.added), ["9:2", "9:1"]);
    assert.equal(d.layers.added[0].path, "Screens v2 / v1 / Home v2", "a layer added inside a section is a top-level layer too");
    assert.deepEqual(ids(d.layers.removed), ["2:1"]);
    assert.deepEqual(d.layers.renamed, [{ id: "1:1", type: "FRAME", oldName: "Login", name: "Sign in", page: "Screens v2", path: "Screens v2 / Sign in" }]);
    const moved = Object.fromEntries(d.layers.moved.map((m) => [m.id, [m.from.page, m.from.parentId, m.to.page, m.to.parentId]]));
    assert.deepEqual(moved, {
      "3:1": ["Screens", "0:1", "Archive", "0:2"], // between pages
      "5:2": ["Screens", "5:1", "Screens v2", "5:3"], // between sections on one page
      "6:1": ["Screens", "0:1", "Archive", "0:2"],
      // Dropped into a frame: no longer top-level, and still in the file, so it is a move and not a removal.
      "4:1": ["Screens", "0:1", "Screens v2", "1:1"],
    });
    assert.ok(!d.layers.moved.some((m) => m.id === "6:2"), "a layer carried inside a moved section kept its parent");
    assert.equal(d.layers.moved.find((m) => m.id === "4:1")!.to.path, "Screens v2 / Sign in / Settings");
  });

  it("lists every node removed from the visible pages, the top of each removed subtree first", () => {
    // 1:3 went from inside a frame that is still there: the cited-id case a top-level comparison cannot see.
    assert.deepEqual(d.removedNodes.map((r) => [r.id, r.page, r.path, r.removedWith]), [
      ["1:3", "Screens", "Screens / Login / Form / Password hint", undefined],
      ["2:1", "Screens", "Screens / Signup", undefined],
      ["7:2", "Screens", "Screens / Popover / Arrow", undefined],
      ["2:2", "Screens", "Screens / Signup / Header", "2:1"],
      ["2:3", "Screens", "Screens / Signup / Header / Logo", "2:1"],
    ]);
    assert.ok(!d.removedNodes.some((r) => r.id === "8:1"), "the internal-only page holds library copies, not layers");
    assert.deepEqual(d.counts, {
      pagesAdded: 1, pagesRemoved: 0, pagesRenamed: 1,
      layersAdded: 2, layersRemoved: 1, layersRenamed: 1, layersMoved: 4,
      removedNodes: 5,
    });
    assert.equal(d.truncated, false);
  });

  it("stops every list at the limit, and says so while counts keeps the totals", () => {
    const cut = diffDocuments(before, after, 3);
    assert.deepEqual([cut.limit, cut.truncated, cut.layers.moved.length, cut.counts.layersMoved], [3, true, 3, 4]);
    // In document order the cut would fall inside Signup, and 7:2 - gone from a frame still there - would be left out.
    assert.deepEqual(ids(cut.removedNodes), ["1:3", "2:1", "7:2"], "every removed subtree's top, ahead of what they took with them");
    // Exactly the limit is not a cut.
    assert.equal(diffDocuments(before, after, 5).truncated, false);
  });

  it("finds nothing between a snapshot and itself", () => {
    const same = diffDocuments(before, before, 100);
    assert.ok(Object.values(same.counts).every((c) => c === 0), JSON.stringify(same.counts));
    assert.equal(same.truncated, false);
  });

  it("names a page removed, and lists what was on it as removed", () => {
    const gone = diffDocuments(after, figDoc([{ ...pageA, name: "Screens v2" }, internalPage]), 100);
    assert.deepEqual(gone.pages.removed, [{ id: "0:2", name: "Archive" }, { id: "0:3", name: "New page" }]);
    assert.deepEqual(ids(gone.layers.removed).sort(), ["1:1", "3:1", "5:1", "5:2", "5:3", "6:1", "6:2", "7:1", "9:1", "9:2"]);
  });
});

describe("parseSince", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");

  it("reads an ISO-8601 date as midnight UTC, and a date and time as written", () => {
    assert.equal(parseSince("2026-10-01", now).toISOString(), "2026-10-01T00:00:00.000Z");
    assert.equal(parseSince("2026-10-01T09:30:00Z", now).toISOString(), "2026-10-01T09:30:00.000Z");
    assert.equal(parseSince("2026-10-01T09:30:00-05:00", now).toISOString(), "2026-10-01T14:30:00.000Z");
    assert.equal(parseSince(" 2026-10-01T09:30Z ", now).toISOString(), "2026-10-01T09:30:00.000Z");
  });

  it("reads a duration back from now", () => {
    assert.equal(parseSince("30m", now).toISOString(), "2026-10-05T11:30:00.000Z");
    assert.equal(parseSince("12h", now).toISOString(), "2026-10-05T00:00:00.000Z");
    assert.equal(parseSince("7d", now).toISOString(), "2026-09-28T12:00:00.000Z");
    assert.equal(parseSince("2w", now).toISOString(), "2026-09-21T12:00:00.000Z");
  });

  it("refuses anything else rather than guessing at it", () => {
    // Date.parse takes most of these, each some way the answer would not show.
    for (const bad of ["yesterday", "7", "7days", "-7d", "1.5d", "", "Oct 1", "10/01/2026", "2026", "2026-10-01 09:30"]) {
      assert.throws(() => parseSince(bad, now), /is neither an ISO-8601 date .* nor a duration like 30m, 12h, 7d or 2w/, JSON.stringify(bad));
    }
  });

  it("refuses a date the calendar does not have, which Date.parse moves into the next month", () => {
    for (const bad of ["2026-02-29", "2026-04-31", "1900-02-29", "2026-13-01", "2026-00-10", "2026-10-00", "2026-10-01T24:00Z", "2026-10-01T12:60Z", "2026-10-01T12:00:60Z", "2026-10-01T12:00+24:00"]) {
      assert.throws(() => parseSince(bad, now), /names a date or time that does not exist/, bad);
    }
    // Leap days that are there.
    assert.equal(parseSince("2024-02-29", now).toISOString(), "2024-02-29T00:00:00.000Z");
    assert.equal(parseSince("2000-02-29", now).toISOString(), "2000-02-29T00:00:00.000Z");
  });

  it("refuses a duration reaching back past any date, instead of an instant that cannot be written down", () => {
    // It returned an invalid Date, and the answer's toISOString threw only after the whole file had been read.
    assert.throws(() => parseSince("99999999999w", now), /since "99999999999w" reaches back further than any date/);
    assert.throws(() => parseSince(`${"9".repeat(400)}d`, now), /reaches back further than any date/);
  });
});

describe("changesSince", () => {
  const T = Date.parse("2026-10-01T00:00:00Z") / 1000;
  const since = new Date(T * 1000);
  const at = (created: number, edited = created) => ({ editInfo: { createdAt: created, lastEditedAt: edited } });
  const doc = figDoc([
    { id: "0:1", type: "CANVAS", parent: "0:0", name: "Screens", ...at(T - 999) },
    internalPage,
    // A frame whose own time never moved while a layer deep in it was edited: what the roll-up is for.
    { id: "1:1", type: "FRAME", parent: "0:1", name: "Login", ...at(T - 500) },
    { id: "1:2", type: "FRAME", parent: "1:1", name: "Form", ...at(T - 500) },
    { id: "1:3", type: "RECTANGLE", parent: "1:2", name: "Field", ...at(T - 500, T + 300) },
    { id: "1:4", type: "TEXT", parent: "1:2", name: "Label" }, // text records no edit time
    { id: "2:1", type: "FRAME", parent: "0:1", name: "Untouched", ...at(T - 500) },
    { id: "3:1", type: "FRAME", parent: "0:1", name: "Paywall", ...at(T + 100) }, // new since
    { id: "3:2", type: "FRAME", parent: "3:1", name: "Plan", ...at(T + 100, T + 200) },
    // Exactly at since counts: "at or after".
    { id: "4:1", type: "FRAME", parent: "0:1", name: "Edge", ...at(T - 500, T) },
    { id: "5:1", type: "SECTION", parent: "0:1", name: "Flows", ...at(T - 500) },
    { id: "5:2", type: "FRAME", parent: "5:1", name: "Checkout", ...at(T - 500, T + 50) },
    { id: "9:1", type: "VARIABLE", parent: "0:9", name: "color", ...at(T + 900) },
  ]);

  it("rolls each top-level layer up from everything under it, newest first", () => {
    const r = changesSince(doc, since, 50);
    assert.deepEqual(r.layers.map((l) => [l.id, l.lastEditedAt, l.created, l.editedNodes]), [
      ["1:1", new Date((T + 300) * 1000).toISOString(), false, 1],
      ["3:1", new Date((T + 200) * 1000).toISOString(), true, 2],
      // A section is listed with what is in it, and its layers again on their own.
      ["5:1", new Date((T + 50) * 1000).toISOString(), false, 1],
      ["5:2", new Date((T + 50) * 1000).toISOString(), false, 1],
      ["4:1", new Date(T * 1000).toISOString(), false, 1],
    ]);
    assert.deepEqual([r.layers[0].name, r.layers[0].type, r.layers[0].page, r.layers[0].path], ["Login", "FRAME", "Screens", "Screens / Login"]);
    assert.equal(r.layers[3].path, "Screens / Flows / Checkout");
    // Each edited node once, though the section and its frame both list 5:2; the internal-only page is not read.
    assert.deepEqual([r.since, r.editedNodes, r.undatedNodes], [since.toISOString(), 5, 1]);
    assert.deepEqual([r.returned, r.total, r.truncated, r.limit], [5, 5, false, 50]);
  });

  it("stops at the limit and says how many there were", () => {
    const r = changesSince(doc, since, 2);
    assert.deepEqual([r.returned, r.total, r.truncated, ids(r.layers)], [2, 5, true, ["1:1", "3:1"]]);
  });

  it("lists nothing when nothing is that recent", () => {
    const r = changesSince(doc, new Date((T + 1000) * 1000), 50);
    assert.deepEqual([r.total, r.layers, r.editedNodes], [0, [], 0]);
  });

  it("dates a node by its creation alone when that is all it records, and rolls that up", () => {
    // Every fixture above records both times, so a reading of lastEditedAt alone passed them all, and missed every
    // node that records only that it was made.
    const created = figDoc([
      { id: "0:1", type: "CANVAS", parent: "0:0", name: "Screens" },
      { id: "1:1", type: "FRAME", parent: "0:1", name: "New", editInfo: { createdAt: T + 10 } },
      { id: "2:1", type: "FRAME", parent: "0:1", name: "Old", ...at(T - 500) },
      { id: "2:2", type: "FRAME", parent: "2:1", name: "Old group", ...at(T - 500) },
      { id: "2:3", type: "RECTANGLE", parent: "2:2", name: "Added inside", editInfo: { createdAt: T + 20 } },
    ]);
    const r = changesSince(created, since, 50);
    assert.deepEqual(r.layers.map((l) => [l.id, l.lastEditedAt, l.created, l.editedNodes]), [
      ["2:1", new Date((T + 20) * 1000).toISOString(), false, 1],
      ["1:1", new Date((T + 10) * 1000).toISOString(), true, 1],
    ]);
  });

  it("counts edit metadata with no time in it as undated, never as 1970", () => {
    // Every one of these used to read as a time of 0: dated, and listed as edited at the epoch for a since before it.
    const partial = figDoc([
      { id: "0:1", type: "CANVAS", parent: "0:0", name: "Screens" },
      { id: "1:1", type: "FRAME", parent: "0:1", name: "Empty record", editInfo: {} },
      { id: "2:1", type: "FRAME", parent: "0:1", name: "Zeroes", editInfo: { createdAt: 0, lastEditedAt: 0 } },
      // In the real export a createdAt of 0 sits beside a real lastEditedAt: the edit is dated, the creation is not.
      { id: "3:1", type: "FRAME", parent: "0:1", name: "Edited only", editInfo: { createdAt: 0, lastEditedAt: T + 5 } },
    ]);
    const r = changesSince(partial, new Date(-1000), 50);
    assert.deepEqual([r.undatedNodes, r.editedNodes], [2, 1]);
    assert.deepEqual(r.layers.map((l) => [l.id, l.lastEditedAt, l.created]), [["3:1", new Date((T + 5) * 1000).toISOString(), false]]);
  });
});
