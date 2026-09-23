// Decoding and indexing a .fig: every tool reads the scene graph through FigDocument.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, zipSync } from "fflate";
import { currentCopy, FigDocument } from "../src/fig-file.ts";
import { figBytes, figDoc, type TestNode } from "./fixtures.ts";

const at = new Date(0);

test("a .fig archive decodes to its pages, meta, images and keyed nodes", () => {
  const doc = FigDocument.fromBytes("KEY", at, figBytes(
    [
      { id: "0:1", type: "CANVAS", parent: "0:0", name: "Page 1" },
      { id: "1:2", type: "FRAME", parent: "0:1", name: "Card", key: "pub-key" },
    ],
    { meta: { file_name: "My App" }, images: { ab12: new Uint8Array([0x89, 0x50]) } },
  ));
  assert.equal(doc.version, 15);
  assert.equal(doc.meta.file_name, "My App");
  assert.deepEqual([...doc.images.keys()], ["ab12"]);
  assert.deepEqual(doc.pages().map((p) => p.name), ["Page 1"]);
  assert.equal(doc.byKey.get("pub-key")?.id, "1:2");
  assert.equal(doc.path(doc.require("1:2")), "Page 1 / Card");
});

test("a bare canvas.fig (no zip) decodes too", () => {
  const canvas = unzipSync(figBytes([{ id: "0:1", type: "CANVAS", parent: "0:0", name: "P" }]))["canvas.fig"];
  assert.deepEqual(FigDocument.fromBytes("k", at, canvas).pages().map((p) => p.name), ["P"]);
});

test("broken files fail with what is wrong", () => {
  assert.throws(() => FigDocument.fromBytes("k", at, zipSync({ "meta.json": new Uint8Array() })), /canvas\.fig missing/);
  assert.throws(() => FigDocument.fromBytes("k", at, new TextEncoder().encode("PNG not a canvas...")), /unexpected canvas header/);
  assert.throws(() => new FigDocument("k", at, { nodeChanges: [{ guid: { sessionID: 0, localID: 1 }, type: "FRAME" }] }), /no DOCUMENT node/);
});

test("children follow fractional-index position by code unit, not list order or locale", () => {
  const doc = figDoc([
    { id: "0:1", type: "CANVAS", parent: "0:0" },
    { id: "1:1", type: "FRAME", parent: "0:1", position: "b" },
    { id: "1:2", type: "FRAME", parent: "0:1", position: "B" },
    { id: "1:3", type: "FRAME", parent: "0:1", position: "a" },
  ]);
  // Code-unit order puts uppercase first; a locale compare would give a, b, B or a, B, b.
  assert.deepEqual(doc.require("0:1").childIds, ["1:2", "1:3", "1:1"]);
  assert.deepEqual([...doc.walk(doc.require("0:1"))].map((n) => n.id), ["0:1", "1:2", "1:3", "1:1"]);
});

test("require accepts URL-style ids with every '-' as ':' and names the file when missing", () => {
  const doc = figDoc([{ id: "0:1", type: "CANVAS", parent: "0:0" }, { id: "12:34", type: "FRAME", parent: "0:1" }], "FILEKEY");
  assert.equal(doc.require("12-34").id, "12:34");
  assert.throws(() => doc.require("9-9"), /node 9-9 not found in file FILEKEY/);
});

test("internal-only pages are hidden and refs resolve by guid, then by library key", () => {
  const doc = figDoc([
    { id: "0:1", type: "CANVAS", parent: "0:0", name: "Visible" },
    { id: "0:2", type: "CANVAS", parent: "0:0", name: "Internal", internalOnly: true },
    { id: "5:5", type: "SYMBOL", parent: "0:2", name: "Lib", key: "lib-key" },
  ]);
  assert.deepEqual(doc.pages().map((p) => p.name), ["Visible"]);
  assert.equal(doc.resolveRef({ guid: { sessionID: 5, localID: 5 } })?.name, "Lib");
  assert.equal(doc.resolveRef({ guid: { sessionID: 9, localID: 9 }, assetRef: { key: "lib-key" } })?.name, "Lib");
  assert.equal(doc.resolveRef({ assetRef: { key: "nope" } }), undefined);
  assert.equal(doc.pageOf(doc.require("5:5"))?.name, "Internal");
});

test("a truncated canvas or one without a message chunk fails with what is wrong", () => {
  const canvas = unzipSync(figBytes([{ id: "0:1", type: "CANVAS", parent: "0:0", name: "P" }]))["canvas.fig"];
  assert.throws(() => FigDocument.fromBytes("k", at, canvas.subarray(0, canvas.length - 3)), /truncated canvas: chunk 1/);
  const schemaOnly = canvas.subarray(0, 16 + new DataView(canvas.buffer, canvas.byteOffset).getUint32(12, true));
  assert.throws(() => FigDocument.fromBytes("k", at, schemaOnly), /canvas has 1 chunk\(s\)/);
});

test("require turns every '-' of a nested instance id into ':'", () => {
  const doc = figDoc([{ id: "0:1", type: "CANVAS", parent: "0:0" }]);
  // Instance sublayer ids ("I1:2;3:4") never come from a guid, so index one by hand.
  doc.nodes.set("I1:2;3:4", { id: "I1:2;3:4", type: "TEXT", name: "Label", childIds: [] });
  assert.equal(doc.require("I1-2;3-4").name, "Label");
});

test("with several copies of one library asset, byKey keeps the newest and refs naming a version get that copy", () => {
  const copies: TestNode[] = [
    { id: "5:2", type: "VARIABLE", parent: "0:2", name: "Neutral/700", key: "k", version: "2710:0" },
    { id: "5:1", type: "VARIABLE", parent: "0:2", name: "Neutral/700", key: "k", version: "2002:352" },
    // A "@S2_DEDUPE" copy has the same version: the plain one is canonical, and holds the higher id here so that
    // nothing but that rule can pick it.
    { id: "6:1", type: "TEXT", parent: "0:2", name: "Body", key: "s", version: "44:13@S2_DEDUPE_263:16082", styleType: "TEXT" },
    { id: "6:2", type: "TEXT", parent: "0:2", name: "Body", key: "s", version: "44:13", styleType: "TEXT" },
    // Byte-identical versions: nothing but the id orders these two, and both orders must pick the same one.
    { id: "7:2", type: "VARIABLE", parent: "0:2", name: "Accent", key: "t", version: "31:4" },
    { id: "7:1", type: "VARIABLE", parent: "0:2", name: "Accent", key: "t", version: "31:4" },
  ];
  const internal: TestNode = { id: "0:2", type: "CANVAS", parent: "0:0", name: "Internal", internalOnly: true };
  // Each rule is checked in both node orders: the fixture's order alone would decide every one of them.
  for (const order of [copies, [...copies].reverse()]) {
    const doc = figDoc([internal, ...order]);
    assert.equal(doc.byKey.get("k")?.id, "5:2");
    assert.equal(doc.byKey.get("s")?.id, "6:2");
    assert.equal(doc.byKey.get("t")?.id, "7:1");
    // resolveRef prefers the copy at the version a reference names, so that index needs the same tie-break: before,
    // the last node change in file order won it, and an instance could read a copy byKey calls superseded.
    assert.equal(doc.resolveRef({ assetRef: { key: "t", version: "31:4" } })?.id, "7:1");
    assert.equal(doc.isSuperseded(doc.resolveRef({ assetRef: { key: "t", version: "31:4" } })!), false);
  }
  const doc = figDoc([internal, ...copies]);
  assert.equal(doc.resolveRef({ assetRef: { key: "k", version: "2002:352" } })?.id, "5:1");
  assert.equal(doc.resolveRef({ assetRef: { key: "k", version: "9999:0" } })?.id, "5:2", "an unknown version falls back to the newest");
  assert.equal(doc.resolveRef({ assetRef: { key: "k" } })?.id, "5:2");
  assert.deepEqual(["5:1", "5:2", "6:1", "6:2"].map((id) => doc.isSuperseded(doc.require(id))), [true, false, true, false]);
  // An instance made before a library update names the copy of its own version by guid. Reading that copy is how two
  // answers about one variable came apart: the text an instance rendered was the old copy's, while the token export
  // listed only the new one, so nothing in the export explained the string.
  assert.equal(currentCopy(doc, { guid: { sessionID: 5, localID: 1 } })?.id, "5:2");
  assert.equal(currentCopy(doc, { assetRef: { key: "k", version: "2002:352" } })?.id, "5:2");
  assert.equal(currentCopy(doc, { guid: { sessionID: 5, localID: 2 } })?.id, "5:2");
  // A node with no publish key is nobody's stale copy: it is returned as it is.
  assert.equal(currentCopy(doc, { guid: { sessionID: 0, localID: 2 } })?.id, "0:2");
  assert.equal(currentCopy(doc, { assetRef: { key: "gone" } }), undefined);
});

test("a file with two DOCUMENT nodes keeps the first, which is where the pages hang", () => {
  const doc = figDoc([
    { id: "0:0", type: "DOCUMENT", name: "Document" },
    { id: "0:1", type: "CANVAS", parent: "0:0", name: "Page 1" },
    { id: "9:0", type: "DOCUMENT", name: "Second document" },
  ]);
  assert.equal(doc.rootId, "0:0");
  assert.deepEqual(doc.pages().map((p) => p.name), ["Page 1"]);
});

test("a node change with no guid is counted, not indexed under an undefined id", () => {
  const doc = new FigDocument("k", at, {
    nodeChanges: [{ guid: { sessionID: 0, localID: 0 }, type: "DOCUMENT", name: "Document" }, { type: "FRAME", name: "no guid" }],
  });
  assert.deepEqual([...doc.nodes.keys()], ["0:0"]);
  assert.equal(doc.skippedNodeChanges, 1);
});

test("a canvas chunk in neither compression fails naming the chunk and what it is not", () => {
  const chunk = (b: Uint8Array) => {
    const out = new Uint8Array(4 + b.length);
    new DataView(out.buffer).setUint32(0, b.length, true);
    out.set(b, 4);
    return out;
  };
  const canvas = (first: Uint8Array) => {
    const header = new Uint8Array(12);
    header.set(new TextEncoder().encode("fig-kiwi"));
    return new Uint8Array([...header, ...chunk(first), ...chunk(first)]);
  };
  // Before, both of these surfaced as a bare "unexpected EOF" from the compression library.
  assert.throws(() => FigDocument.fromBytes("k", at, canvas(new Uint8Array([1, 2, 3, 4]))), /schema chunk of this "fig-kiwi" canvas is not raw deflate data/);
  assert.throws(() => FigDocument.fromBytes("k", at, canvas(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0, 0]))), /schema chunk of this "fig-kiwi" canvas is not zstd data/);
});

test("a parent cycle in a corrupt file does not hang path, pageOf or walk", () => {
  const doc = figDoc([
    { id: "0:1", type: "CANVAS", parent: "0:0", name: "P" },
    { id: "2:1", type: "FRAME", parent: "2:2", name: "A" },
    { id: "2:2", type: "FRAME", parent: "2:1", name: "B" },
  ]);
  assert.equal(doc.path(doc.require("2:1")), "B / A");
  assert.equal(doc.pageOf(doc.require("2:1")), undefined);
  assert.deepEqual([...doc.walk(doc.require("2:1"))].map((n) => n.id), ["2:1", "2:2"]);
});
