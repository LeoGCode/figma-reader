// figma_dev_status answers "which frames are ready for dev": what it lists by default, what each filter adds or takes
// away, the order, and the records it must not believe.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { devStatusList } from "../src/dev-status.ts";
import { figDoc, guid, internalPage, type TestNode } from "./fixtures.ts";

// Seconds, as lastUpdateUnixTimestamp stores them: 30 Sep, 1, 2 and 3 Oct 2026.
const [sep30, oct1, oct2, oct3] = [1790756100, 1790848800, 1790958600, 1791020700];
// Every record a person made in real files names its user, and none of those Figma writes on its own does.
const info = (status: string, prevStatus: string, at?: number, extra: object = { userId: "1234567" }) => ({
  sectionStatusInfo: { status, prevStatus, ...(at ? { lastUpdateUnixTimestamp: at } : {}), ...extra },
});

const nodes: TestNode[] = [
  {
    id: "0:1", type: "CANVAS", parent: "0:0", name: "Design system",
    // The page's own index of statuses, as stale as real files carry it: one entry names a node deleted since, and one
    // still says 1:3 is ready for dev, which its node stopped saying. Neither may show up.
    handoffStatusMap: {
      entries: [
        { guid: guid("4:4"), handoffStatus: { status: "BUILD", prevStatus: "NONE" } },
        { guid: guid("1:3"), handoffStatus: { status: "BUILD", prevStatus: "NONE" } },
      ],
    },
  },
  { id: "1:1", type: "FRAME", parent: "0:1", name: "Buttons", isStateGroup: true, ...info("BUILD", "NONE", oct1) },
  { id: "1:2", type: "SYMBOL", parent: "1:1", name: "Size=Large", ...info("NONE", "NONE", oct1, {}) },
  { id: "1:3", type: "FRAME", parent: "0:1", name: "Inputs", ...info("NONE", "BUILD", oct2) },
  { id: "1:4", type: "SYMBOL", parent: "0:1", name: "Icon", ...info("NONE", "NONE", oct3, {}) },
  // None and none, but with a user on it: a person's doing, so it is listed like a mark.
  { id: "1:5", type: "SYMBOL", parent: "0:1", name: "Badge", ...info("NONE", "NONE", sep30) },
  { id: "0:2", type: "CANVAS", parent: "0:0", name: "Checkout" },
  { id: "2:1", type: "SECTION", parent: "0:2", name: "Payment", ...info("COMPLETED", "BUILD", sep30) },
  // Marked in the same second as the set above: the id decides, the way Figma allocated them, 2:9 before 2:10.
  { id: "2:10", type: "FRAME", parent: "0:2", name: "Summary", ...info("BUILD", "NONE", oct1) },
  { id: "2:9", type: "FRAME", parent: "0:2", name: "Cart", ...info("BUILD", "NONE", oct1) },
  // A record with no time at all goes last rather than first or nowhere.
  { id: "2:3", type: "FRAME", parent: "0:2", name: "Undated", ...info("BUILD", "NONE") },
  // None of these is on the canvas a designer handed off: in the trash, an older copy of a library component kept for
  // old instances, a page only Figma sees, and a node with no page at all.
  { id: "2:4", type: "FRAME", parent: "0:2", name: "Deleted", isSoftDeleted: true, ...info("BUILD", "NONE", oct3) },
  { id: "2:5", type: "SYMBOL", parent: "0:2", name: "Chip", key: "chip", version: "1:0", ...info("BUILD", "NONE", oct3) },
  { id: "2:6", type: "SYMBOL", parent: "0:2", name: "Chip", key: "chip", version: "2:0", ...info("BUILD", "NONE", sep30) },
  internalPage,
  { id: "9:1", type: "SYMBOL", parent: "0:9", name: "Hidden", ...info("BUILD", "NONE", oct3) },
  { id: "9:2", type: "FRAME", name: "Orphan", ...info("BUILD", "NONE", oct3) },
];
const doc = figDoc(nodes);
const ids = (opts: Parameters<typeof devStatusList>[1] = {}) => devStatusList(doc, opts).map((e) => e.id);

describe("devStatusList", () => {
  it("lists every node marked now or before, newest change first", () => {
    // 1:3 was unmarked on 2 Oct, which is what a handoff most needs to hear about; the never-marked variant and icon
    // are left out, or a component library buries the few frames that were handed off.
    assert.deepEqual(ids(), ["1:3", "1:1", "2:9", "2:10", "1:5", "2:1", "2:6", "2:3"]);
  });

  it("carries where each node is and the same status fields as get-node", () => {
    const [unmarked] = devStatusList(doc);
    assert.deepEqual(unmarked, {
      id: "1:3", type: "FRAME", name: "Inputs", page: "Design system", path: "Design system / Inputs",
      status: "none", raw: "NONE", previous: "ready_for_dev", previousRaw: "BUILD", changedAt: "2026-10-02T16:30:00.000Z", by: "1234567",
    });
    const set = devStatusList(doc).find((e) => e.id === "1:1");
    assert.deepEqual([set?.type, set?.status, set?.raw], ["COMPONENT_SET", "ready_for_dev", "BUILD"]);
  });

  it("narrows to one status, and widens to every record with any", () => {
    assert.deepEqual(ids({ status: "ready_for_dev" }), ["1:1", "2:9", "2:10", "2:6", "2:3"]);
    assert.deepEqual(ids({ status: "completed" }), ["2:1"]);
    // none is everything not marked now: the mark that came off, and the records that were never anything else.
    assert.deepEqual(ids({ status: "none" }), ["1:4", "1:3", "1:2", "1:5"]);
    assert.deepEqual(ids({ status: "any" }), ["1:4", "1:3", "1:1", "1:2", "2:9", "2:10", "1:5", "2:1", "2:6", "2:3"]);
  });

  it("narrows to a page by name", () => {
    assert.deepEqual(ids({ page: "Checkout" }), ["2:9", "2:10", "2:1", "2:6", "2:3"]);
    assert.deepEqual(ids({ page: "Checkout", status: "completed" }), ["2:1"]);
    assert.deepEqual(ids({ page: "Internal", status: "any" }), [], "an internal-only page is not one of the file's pages");
  });
});
