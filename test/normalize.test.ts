// Turning raw kiwi values into the JSON the tools return.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Normalizer, propValue, propValueOf } from "../src/normalize.ts";
import { figDoc, guid, internalPage, variable, variableSet } from "./fixtures.ts";

describe("propValue", () => {
  it("reads the inline ComponentPropValue shape", () => {
    assert.equal(propValue({ textValue: { characters: "Login" } }), "Login");
    assert.equal(propValue({ boolValue: false }), false);
    assert.equal(propValue({ floatValue: 3 }), 3);
  });

  it("reads the variable-backed shape, where value is an empty object", () => {
    const varValue = { value: { textDataValue: { characters: "Request quote" } }, dataType: "TEXT_DATA" };
    assert.equal(propValue({}, varValue), "Request quote");
    assert.equal(propValue(undefined, varValue), "Request quote");
    assert.equal(propValue({}, { value: { boolValue: false } }), false);
    assert.equal(propValue({}, { value: { textValue: "plain string" } }), "plain string");
    assert.equal(propValue({}, { value: { symbolIdValue: { guid: guid("5:7") } } }), "5:7");
  });

  it("prefers the inline value when a property carries both", () => {
    assert.equal(propValue({ textValue: { characters: "inline" } }, { value: { textDataValue: { characters: "var" } } }), "inline");
  });

  it("returns undefined rather than guessing for shapes it does not know", () => {
    assert.equal(propValue(undefined, undefined), undefined);
    assert.equal(propValue({}, { value: { paintValue: {} } }), undefined);
  });
});

describe("propValue on a property bound to a variable", () => {
  // The shape Figma writes once a property is bound to a variable: an ALIAS naming the variable that holds the value.
  const alias = (id: string) => ({ value: { alias: { guid: guid(id) } }, dataType: "ALIAS", resolvedDataType: "TEXT_DATA" });
  const doc = figDoc([
    internalPage,
    variableSet("9:0", "Copy", [["9:1", "Light"], ["9:2", "Dark"]]),
    // Stored with the second mode first, so reading the entries in order would give "Comprar".
    variable("9:3", "9:0", "cta/label", "STRING", { "9:2": { text: "Comprar" }, "9:1": { text: "Buy now" } }),
    variable("9:4", "9:0", "cta/alias", "STRING", { "9:1": { alias: "9:3" }, "9:2": { alias: "9:3" } }),
    variable("9:5", "9:0", "cta/loop", "STRING", { "9:1": { alias: "9:6" }, "9:2": { alias: "9:6" } }),
    variable("9:6", "9:0", "cta/loop2", "STRING", { "9:1": { alias: "9:5" }, "9:2": { alias: "9:5" } }),
  ]);

  it("reads the variable's value in the collection's default mode, following alias chains", () => {
    // Before, this shape was not decoded at all and the instance silently rendered the component's default.
    assert.equal(propValue({}, alias("9:3"), doc), "Buy now");
    assert.equal(propValue({}, alias("9:4"), doc), "Buy now");
  });

  it("reads a variable through the copy the file exports, not the stale one the binding names", () => {
    // A binding made before a library update keeps naming the copy of its own version, which is still in the file;
    // the token export lists only the current copy. Before, figma_get_text answered with the old copy's string while
    // figma_get_variables reported the new one, and nothing in the export accounted for the text on the canvas.
    const updated = figDoc([
      internalPage,
      variableSet("9:0", "Copy", [["9:1", "Mode 1"]]),
      variable("5:1", "9:0", "cta/label", "STRING", { "9:1": { text: "Buy now" } }, { key: "cta-key", version: "1:0" }),
      variable("5:2", "9:0", "cta/label", "STRING", { "9:1": { text: "Add to basket" } }, { key: "cta-key", version: "2:0" }),
    ]);
    assert.equal(propValue({}, alias("5:1"), updated), "Add to basket");
    assert.equal(propValue({}, alias("5:2"), updated), "Add to basket");
  });

  it("reads every variable of a collection that declares no modes in the same mode", () => {
    // Partial library copies carry no variableSetModes, and the mode ids then live only on the variables' values. Two
    // variables of one collection do not store their entries in a common order, so reading each one's first entry
    // answered in a different mode per variable: one label came back light-mode and the next dark-mode. The mode
    // ids are 9 and 10 apart, the pair a string compare puts in the wrong order: the lowest id is the mode both
    // variables are read in, and the token export decides it the same way.
    const partial = figDoc([
      internalPage,
      variableSet("7:0", "Theme copy", []),
      variable("7:3", "7:0", "cta/label", "STRING", { "7:9": { text: "Buy now" }, "7:10": { text: "Buy now (dark)" } }),
      variable("7:4", "7:0", "cta/hint", "STRING", { "7:10": { text: "Ships free (dark)" }, "7:9": { text: "Ships free" } }),
    ]);
    assert.equal(propValue({}, alias("7:3"), partial), "Buy now");
    assert.equal(propValue({}, alias("7:4"), partial), "Ships free");
  });

  it("says why a value could not be read instead of returning nothing", () => {
    assert.match(propValueOf({}, { value: { alias: { assetRef: { key: "lib-var" } } } }, doc).reason!, /variable that is not in this file/);
    assert.match(propValueOf({}, alias("9:3")).reason!, /variable that is not in this file/);
    assert.match(propValueOf({}, alias("9:5"), doc).reason!, /cycle of aliases/);
    assert.match(propValueOf({}, { value: { paintValue: {} } }).reason!, /value shape this decoder does not know \(paintValue\)/);
    assert.deepEqual(propValueOf({ textValue: { characters: "Login" } }), { value: "Login" });
    assert.deepEqual(propValueOf({}, { value: {} }), {});
  });
});

describe("Normalizer.component", () => {
  it("lists a variant's property definitions with the name, type and default its set holds", () => {
    const doc = figDoc([
      { id: "0:1", type: "CANVAS", parent: "0:0", name: "Components" },
      {
        id: "2:0", type: "FRAME", parent: "0:1", name: "Button", isStateGroup: true,
        componentPropDefs: [{ id: guid("3:1"), name: "Label", type: "TEXT", initialValue: { textValue: { characters: "OK" } } }],
      },
      // Real variants carry only these pointers: before, they printed as [{}].
      { id: "2:1", type: "SYMBOL", parent: "2:0", name: "Size=Large", componentPropDefs: [{ id: guid("3:2"), parentPropDefId: guid("3:1") }] },
      // Stubs with only an id occur in real files and say nothing.
      { id: "2:2", type: "SYMBOL", parent: "0:1", name: "Stubbed", componentPropDefs: [{ id: guid("3:3") }] },
    ]);
    const norm = new Normalizer(doc);
    assert.deepEqual(norm.component(doc.require("2:1"))?.propertyDefinitions, [{ name: "Label", type: "TEXT", default: "OK" }]);
    assert.deepEqual(norm.component(doc.require("2:0"))?.propertyDefinitions, [{ name: "Label", type: "TEXT", default: "OK" }]);
    assert.deepEqual(norm.component(doc.require("2:2")), { kind: "COMPONENT" });
  });

  it("lists an instance's variant properties and names its assignments by the set's definitions", () => {
    const doc = figDoc([
      { id: "0:1", type: "CANVAS", parent: "0:0", name: "Page" },
      {
        id: "2:0", type: "FRAME", parent: "0:1", name: "Button", isStateGroup: true,
        componentPropDefs: [{ id: guid("3:1"), name: "Label", type: "TEXT", initialValue: { textValue: { characters: "OK" } } }],
      },
      { id: "2:1", type: "SYMBOL", parent: "2:0", name: "Size=Large, State=Hover", componentPropDefs: [{ id: guid("3:2"), parentPropDefId: guid("3:1") }] },
      // The assignment points at the variant's local def, which only refers to the set's.
      {
        id: "1:1", type: "INSTANCE", parent: "0:1", name: "b", symbolData: { symbolID: guid("2:1") },
        componentPropAssignments: [{ defID: guid("3:2"), value: { textValue: { characters: "Send" } } }],
      },
    ]);
    assert.deepEqual(new Normalizer(doc).component(doc.require("1:1"))?.properties, { Size: "Large", State: "Hover", Label: "Send" });
  });
});

describe("Normalizer.node", () => {
  const one = (node: Record<string, unknown>) => {
    const doc = figDoc([{ id: "0:1", type: "CANVAS", parent: "0:0", name: "Page" }, { id: "1:1", parent: "0:1", name: "N", type: "FRAME", ...node }]);
    return new Normalizer(doc).node(doc.require("1:1"), 0);
  };

  it("lists auto-layout padding as top, right, bottom, left", () => {
    const n = one({ stackMode: "HORIZONTAL", stackVerticalPadding: 1, stackPaddingRight: 2, stackPaddingBottom: 3, stackHorizontalPadding: 4 });
    assert.deepEqual(n.layout.padding, [1, 2, 3, 4]);
  });

  it("reads a missing right or bottom padding as 0, not as a copy of left or top", () => {
    // Hug frames in real files measure content + left + top exactly when these fields are absent.
    assert.deepEqual(one({ stackMode: "VERTICAL", stackVerticalPadding: 12, stackHorizontalPadding: 8 }).layout.padding, [12, 0, 0, 8]);
  });

  it("lists independent corner radii as top-left, top-right, bottom-right, bottom-left", () => {
    const n = one({
      rectangleCornerRadiiIndependent: true,
      rectangleTopLeftCornerRadius: 1, rectangleTopRightCornerRadius: 2, rectangleBottomRightCornerRadius: 3, rectangleBottomLeftCornerRadius: 4,
    });
    assert.deepEqual(n.cornerRadius, [1, 2, 3, 4]);
    assert.equal(one({ cornerRadius: 6 }).cornerRadius, 6);
  });

  it("reports a resize-to-fit frame as a GROUP", () => {
    assert.equal(one({ resizeToFit: true }).type, "GROUP");
    assert.equal(one({}).type, "FRAME");
  });

  it("leaves out the fields a layer only looks like it carries, at the values real files sit on", () => {
    // The golden objects above set every field to a value well away from where its rule turns over, so each of these
    // is a wrong answer a reader would act on: a rotation nobody applied, a group said to clip, a hug frame's only
    // constraint lost, a paint said to be translucent.
    const rotated = (deg: number) => {
      const a = (deg * Math.PI) / 180;
      return { m00: Math.cos(a), m01: -Math.sin(a), m02: 0, m10: Math.sin(a), m11: Math.cos(a), m12: 0 };
    };
    const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
      // Transforms come back with float noise, so a layer nobody rotated reads as a fraction of a degree.
      ["a layer nobody rotated", { transform: rotated(0.005) }, { rotation: undefined }],
      ["a layer rotated by a hair", { transform: rotated(0.5) }, { rotation: 0.5 }],
      // A group is a frame with resizeToFit, and Figma writes frameMaskDisabled on it too; a group never clips.
      ["a group", { resizeToFit: true, frameMaskDisabled: false }, { type: "GROUP", clipsContent: undefined }],
      ["a frame that clips", { frameMaskDisabled: false }, { type: "FRAME", clipsContent: true }],
      // "Hug, up to 320" is a maximum with no minimum, which is how most responsive components are built.
      ["a frame with only a maximum width", { maxSize: { value: { x: 320 } } }, { constraints: { maxWidth: 320 } }],
      // Figma writes opacity 1 on paints nobody made translucent.
      ["a fully opaque paint", { fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }] }, { fills: [{ type: "SOLID", color: "#000000" }] }],
    ];
    for (const [what, node, expected] of cases) {
      const out = one(node);
      for (const [field, value] of Object.entries(expected)) assert.deepEqual(out[field], value, `${what}: ${field}`);
    }
  });

  it("reports every field it reads off a frame", () => {
    const doc = figDoc([
      { id: "0:1", type: "CANVAS", parent: "0:0", name: "Page" },
      {
        id: "1:1", type: "FRAME", parent: "0:1", name: "Card",
        // A 30 degree rotation: the offset is m02/m12 and the angle comes from the first column.
        transform: { m00: 0.866, m01: -0.5, m02: 24, m10: 0.5, m11: 0.866, m12: 8 },
        size: { x: 200, y: 100 }, opacity: 0.6, blendMode: "MULTIPLY",
        fillPaints: [
          // Alpha within half a step of opaque is not written out: it would read as a transparency nobody set.
          { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 0.9995 } },
          { type: "SOLID", color: { r: 0, g: 1, b: 0, a: 0.5 }, colorVar: { value: { alias: { assetRef: { key: "lib-var" } } } } },
          { type: "SOLID", color: { r: 0, g: 0, b: 0 }, visible: false },
          { type: "IMAGE", image: { hash: new Uint8Array([0xab, 0x12]) }, imageScaleMode: "FILL", originalImageWidth: 100, originalImageHeight: 50 },
        ],
        styleIdForFill: { assetRef: { key: "fill-style" } },
        strokePaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
        borderStrokeWeightsIndependent: true,
        borderTopWeight: 1, borderRightWeight: 2, borderBottomWeight: 3, borderLeftWeight: 4,
        strokeAlign: "INSIDE", styleIdForStrokeFill: { assetRef: { key: "stroke-style" } },
        frameMaskDisabled: false,
        minSize: { value: { x: 10, y: 20 } }, maxSize: { value: { x: 300, y: 400 } },
        exportSettings: [{ imageType: "PNG", suffix: "@2x", constraint: { type: "SCALE", value: 2 } }],
      },
      { id: "1:2", type: "FRAME", parent: "1:1", name: "Inner" },
    ]);
    assert.deepEqual(new Normalizer(doc).node(doc.require("1:1"), 0), {
      id: "1:1", name: "Card", type: "FRAME",
      x: 24, y: 8, rotation: 30,
      width: 200, height: 100,
      opacity: 0.6, blendMode: "MULTIPLY",
      fills: [
        { type: "SOLID", color: "#FF0000" },
        { type: "SOLID", color: "#00FF0080", variable: "library:lib-var" },
        { type: "IMAGE", imageHash: "ab12", scaleMode: "FILL", originalSize: [100, 50] },
      ],
      fillStyle: "library:fill-style",
      strokes: [{ type: "SOLID", color: "#000000" }],
      strokeWeight: [1, 2, 3, 4], strokeAlign: "INSIDE", strokeStyle: "library:stroke-style",
      clipsContent: true,
      constraints: { minWidth: 10, minHeight: 20, maxWidth: 300, maxHeight: 400 },
      exports: [{ format: "PNG", suffix: "@2x", constraint: { type: "SCALE", value: 2 } }],
      childCount: 1,
    });
  });

  it("reports every field it reads off a text layer", () => {
    const doc = figDoc([
      { id: "0:1", type: "CANVAS", parent: "0:0", name: "Page" },
      {
        id: "1:1", type: "TEXT", parent: "0:1", name: "Label",
        textData: { characters: "Read the docs", characterStyleIDs: [0, 0, 0, 0, 0, 7, 7, 7, 7], styleOverrideTable: [{ styleID: 7, fontSize: 12 }] },
        fontName: { family: "Inter", style: "Bold" }, fontSize: 16, lineHeight: { value: 24, units: "PIXELS" },
        textAlignHorizontal: "CENTER", textAlignVertical: "CENTER", textAutoResize: "WIDTH_AND_HEIGHT",
        maxLines: 2, textTruncation: "ENDING", styleIdForText: { assetRef: { key: "text-style" } },
      },
    ]);
    assert.deepEqual(new Normalizer(doc).node(doc.require("1:1"), 0), {
      id: "1:1", name: "Label", type: "TEXT",
      characters: "Read the docs",
      text: {
        fontFamily: "Inter", fontStyle: "Bold", fontSize: 16, lineHeight: 24,
        align: "CENTER", verticalAlign: "CENTER", autoResize: "WIDTH_AND_HEIGHT", maxLines: 2, truncation: "ENDING",
      },
      textStyle: "library:text-style",
      runs: [{ text: "Read " }, { text: "the ", fontSize: 12 }, { text: "docs" }],
    });
  });

  it("returns children down to the depth asked for and counts them at the bottom", () => {
    const doc = figDoc([
      { id: "0:1", type: "CANVAS", parent: "0:0", name: "Page" },
      { id: "1:1", type: "FRAME", parent: "0:1", name: "Outer" },
      { id: "1:2", type: "FRAME", parent: "1:1", name: "Middle" },
      { id: "1:3", type: "FRAME", parent: "1:2", name: "Inner" },
    ]);
    const norm = new Normalizer(doc);
    assert.deepEqual(norm.node(doc.require("1:1"), 0), { id: "1:1", name: "Outer", type: "FRAME", childCount: 1 });
    assert.deepEqual(norm.node(doc.require("1:1"), 1), {
      id: "1:1", name: "Outer", type: "FRAME",
      children: [{ id: "1:2", name: "Middle", type: "FRAME", childCount: 1 }],
    });
  });
});

describe("Normalizer.textRuns", () => {
  const runs = (textData: Record<string, unknown>) => {
    const doc = figDoc([{ id: "0:1", type: "CANVAS", parent: "0:0", name: "Page" }, { id: "1:1", type: "TEXT", parent: "0:1", name: "T", textData }]);
    return new Normalizer(doc).textRuns(doc.require("1:1"));
  };
  // A hyperlink lives on a style override and nowhere else, so a run is the only place a URL is reported at all.
  const link = { styleID: 7, fontSize: 12, hyperlink: { url: "https://example.com/pricing" }, fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }] };
  const styled = { fontSize: 12, fills: [{ type: "SOLID", color: "#0000FF" }], link: "https://example.com/pricing" };

  it("splits the string where the character style changes, reading past the ids as unstyled", () => {
    // characterStyleIDs stops short of the string in real files; the characters past it carry no override.
    assert.deepEqual(runs({ characters: "See pricing here", characterStyleIDs: [0, 0, 0, 0, 7, 7, 7, 7, 7, 7, 7], styleOverrideTable: [link] }), [
      { text: "See " },
      { text: "pricing", ...styled },
      { text: " here" },
    ]);
  });

  it("keeps a single run that carries a style of its own, and drops one that carries nothing", () => {
    // Select all, then style: one run, holding the layer's only hyperlink. Before, it was dropped with the link.
    assert.deepEqual(runs({ characters: "Terms", characterStyleIDs: [7, 7, 7, 7, 7], styleOverrideTable: [link] }), [{ text: "Terms", ...styled }]);
    assert.equal(runs({ characters: "Plain", characterStyleIDs: [0, 0, 0, 0, 0], styleOverrideTable: [link] }), undefined);
    assert.equal(runs({ characters: "No ids at all", styleOverrideTable: [link] }), undefined);
    // Real files hold table entries whose every field is one this decoder does not report. Before, the entry existing
    // was enough, so such a layer came back with a run repeating its own characters and saying nothing else.
    assert.equal(runs({ characters: "Terms", characterStyleIDs: [7, 7, 7, 7, 7], styleOverrideTable: [{ styleID: 7 }] }), undefined);
  });
});

describe("Normalizer.textStyle", () => {
  const style = (fields: Record<string, unknown>) => new Normalizer(figDoc([])).textStyle(fields);

  it("returns pixel line heights as numbers and relative ones as percentages, omitting Auto", () => {
    assert.equal(style({ lineHeight: { value: 24, units: "PIXELS" } }).lineHeight, 24);
    assert.equal(style({ lineHeight: { value: 150, units: "PERCENT" } }).lineHeight, "150%");
    assert.equal(style({ lineHeight: { value: 1.5, units: "RAW" } }).lineHeight, "150%");
    // Figma stores "Auto" as 100%.
    assert.equal(style({ lineHeight: { value: 100, units: "PERCENT" } }).lineHeight, undefined);
  });

  it("returns letter spacing in its unit, omitting zero", () => {
    assert.equal(style({ letterSpacing: { value: -2, units: "PERCENT" } }).letterSpacing, "-2%");
    assert.equal(style({ letterSpacing: { value: 0.1, units: "RAW" } }).letterSpacing, "0.1em");
    assert.equal(style({ letterSpacing: { value: 1.5, units: "PIXELS" } }).letterSpacing, 1.5);
    assert.equal(style({ letterSpacing: { value: 0, units: "PERCENT" } }).letterSpacing, undefined);
  });
});

describe("Normalizer.boundVariables", () => {
  const binding = (field: string, variable: string) => ({ variableField: field, variableData: { value: { alias: { guid: guid(variable) } }, dataType: "ALIAS" } });
  const doc = figDoc([
    { id: "0:9", type: "CANVAS", parent: "0:0", name: "Page" },
    { id: "5:1", type: "VARIABLE", parent: "0:9", name: "space/md" },
    { id: "5:2", type: "VARIABLE", parent: "0:9", name: "opacity/muted" },
    { id: "5:3", type: "VARIABLE", parent: "0:9", name: "radius/sm" },
    { id: "5:4", type: "VARIABLE", parent: "0:9", name: "space/lg" },
    // Figma writes bindings to both maps, but either can carry a field the other lacks: corner radius is only in the
    // first map here and opacity only in the second. The two disagree about the spacing, which the maps of a real file
    // do not do, so that the rule for a field both carry is pinned rather than left to which map happens to be read.
    {
      id: "1:1", type: "FRAME", parent: "0:9", name: "Card",
      variableConsumptionMap: { entries: [binding("STACK_SPACING", "5:1"), binding("CORNER_RADIUS", "5:3")] },
      parameterConsumptionMap: { entries: [binding("STACK_SPACING", "5:4"), binding("OPACITY", "5:2")] },
    },
  ]);

  it("reports bindings from either map, the first read winning a field both carry", () => {
    // Before, only variableConsumptionMap was read, so opacity was missing.
    assert.deepEqual(new Normalizer(doc).node(doc.require("1:1"), 0).boundVariables, {
      stack_spacing: "space/md",
      corner_radius: "radius/sm",
      opacity: "opacity/muted",
    });
  });
});
