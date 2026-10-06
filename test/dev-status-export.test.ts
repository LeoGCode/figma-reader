// What Dev Mode status the editor writes, from a real export rather than from what we believe the format is. Source: a
// Figma draft on the Free (Starter) plan with four frames, each set with the editor's own controls: "Ready for dev"
// toggled ready for dev; "Completed" toggled ready, then "Mark as completed"; "Ready then removed" toggled ready, then
// "Remove status"; "Never marked" left alone. Exported with "Save local copy" and committed as-is: see
// test/files/dev-status-export.fig. It holds no design work, only the four empty frames.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { FigDocument } from "../src/fig-file.ts";
import { devStatus } from "../src/normalize.ts";
import { devStatusList, neverMarked } from "../src/dev-status.ts";
import { outline } from "../src/outline.ts";

const doc = FigDocument.fromFile("dev-status-export", join(import.meta.dirname, "files", "dev-status-export.fig"), new Date(0));
const frame = (name: string) => {
  const n = [...doc.nodes.values()].find((x) => x.type === "FRAME" && x.name === name);
  assert.ok(n, `no frame "${name}"`);
  return n;
};

describe("a real export with Dev Mode status set in the editor", () => {
  it("decodes to the file Figma saved", () => {
    assert.equal(doc.meta.file_name, "figma-reader dev status");
    assert.deepEqual(doc.pages().map((p) => p.name), ["Page 1"]);
    assert.deepEqual(doc.children(doc.pages()[0]).map((n) => n.name), ["Ready for dev", "Completed", "Ready then removed", "Never marked"]);
  });

  it("stores Ready for dev as BUILD and Completed as COMPLETED, on the frame itself", () => {
    // The names the decoder gives these values were an assumption until this file: the editor's "Ready for dev" is
    // BUILD, "Mark as completed" is COMPLETED, and "Remove status" leaves NONE with the status it took off as previous.
    const stored = (name: string) => {
      const s = frame(name).sectionStatusInfo;
      return s && { status: s.status, prevStatus: s.prevStatus };
    };
    assert.deepEqual(stored("Ready for dev"), { status: "BUILD", prevStatus: "NONE" });
    assert.deepEqual(stored("Completed"), { status: "COMPLETED", prevStatus: "BUILD" });
    assert.deepEqual(stored("Ready then removed"), { status: "NONE", prevStatus: "BUILD" });
    // A frame nobody marked has no record at all here, unlike the NONE/NONE records Figma keeps on library components.
    assert.equal(frame("Never marked").sectionStatusInfo, undefined);
    // Each record names the person who set it and when, in seconds; the export carries the id, not a name.
    for (const name of ["Ready for dev", "Completed", "Ready then removed"]) {
      const s = frame(name).sectionStatusInfo;
      assert.match(String(s.userId), /^\d+$/, name);
      assert.ok(s.lastUpdateUnixTimestamp > 1.7e9 && s.lastUpdateUnixTimestamp < 1e10, name);
    }
  });

  it("is read back with the editor's names", () => {
    const read = (name: string) => {
      const d = devStatus(frame(name))!;
      return { status: d.status, raw: d.raw, previous: d.previous };
    };
    assert.deepEqual(read("Ready for dev"), { status: "ready_for_dev", raw: "BUILD", previous: "none" });
    assert.deepEqual(read("Completed"), { status: "completed", raw: "COMPLETED", previous: "ready_for_dev" });
    assert.deepEqual(read("Ready then removed"), { status: "none", raw: "NONE", previous: "ready_for_dev" });
    assert.equal(devStatus(frame("Never marked")), undefined);

    // The default listing holds the three a person set, newest change first, and nothing was left out.
    assert.deepEqual(devStatusList(doc).map((e) => e.name), ["Ready then removed", "Completed", "Ready for dev"]);
    assert.equal(neverMarked(doc), 0);

    const tree = outline(doc, doc.get(doc.rootId)!, 1, 400);
    for (const line of ['"Ready for dev" 150x100 (ready for dev)', '"Completed" 190x127 (completed)', '"Ready then removed" 160x120 (was ready for dev)']) {
      assert.ok(tree.includes(line), line);
    }
    assert.match(tree, /"Never marked" 160x120$/m);
  });
});
