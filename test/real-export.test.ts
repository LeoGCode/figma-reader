// Every other fixture is built in code from what we believe the .fig format is; this one is a real export, so it
// fails when that belief is wrong. Source: a Figma draft built for this purpose (a rectangle whose opacity is bound
// to a variable, and a Card component holding a Btn instance), exported with "Save local copy" and committed as-is.
// It contains no design work: see test/files/real-export.fig.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FigDocument, guidId, type Raw } from "../src/fig-file.ts";
import { scanText } from "../src/instance-text.ts";
import { Normalizer } from "../src/normalize.ts";
import { extractVariables, variablesToCss, variablesToDtcg } from "../src/tokens.ts";

const doc = FigDocument.fromFile("real-export", new URL("./files/real-export.fig", import.meta.url).pathname, new Date(0));
const node = (id: string) => doc.require(id);

describe("a real .fig export", () => {
  it("decodes to the file Figma saved", () => {
    assert.equal(doc.meta.file_name, "figma-reader test fixture");
    assert.deepEqual(doc.pages().map((p) => p.name), ["Page 1"]);
    assert.deepEqual([...new Set([...doc.nodes.values()].map((n) => n.type))].sort(), [
      "CANVAS", "DOCUMENT", "INSTANCE", "ROUNDED_RECTANGLE", "SYMBOL", "TEXT", "VARIABLE", "VARIABLE_SET",
    ]);
  });

  it("stores an opacity variable as a percentage of the layer opacity it drives", () => {
    // The variable reads 50 while the layer it is bound to sits at 0.5, which is why CSS gets value/100.
    const variable = [...doc.nodes.values()].find((n) => n.type === "VARIABLE" && n.name === "opacity/muted")!;
    assert.deepEqual(variable.variableScopes, ["OPACITY"]);
    assert.equal(variable.variableDataValues.entries[0].variableData.value.floatValue, 50);
    assert.equal(node("1:2").opacity, 0.5);
    // Both collections here are named "opacity/muted", so the names carry their collection.
    for (const line of ["--collection-1-opacity-muted: 0.5;", "--opacity-opacity-muted: 0.5;"]) {
      assert.ok(variablesToCss(extractVariables(doc)).includes(line), line);
    }
    // DTCG shipped the raw 50, which Style Dictionary hands on as "opacity: 50"; it has no unit to mean anything else.
    const dtcg: Raw = variablesToDtcg(extractVariables(doc));
    assert.deepEqual(Object.values(dtcg).map((c: Raw) => Object.values(c)[0].opacity.muted.$value), [0.5, 0.5]);
  });

  it("reports a binding that exists only in parameterConsumptionMap", () => {
    // Figma writes bindings to either consumption map; this one has no variableConsumptionMap at all.
    assert.equal(node("1:2").variableConsumptionMap, undefined);
    assert.equal(new Normalizer(doc).node(node("1:2"), 0).boundVariables.opacity, "opacity/muted");
  });

  it("renders instance text through a property bound the same way", () => {
    // The text layer's TEXT_DATA property reference is a propRefValue in parameterConsumptionMap; componentPropRefs,
    // the field the fixtures used to assume, is empty here.
    assert.deepEqual(node("2:5").componentPropRefs ?? [], []);
    assert.equal(node("2:5").parameterConsumptionMap.entries[0].variableData.value.propRefValue.defId.localID, 0);
    assert.deepEqual(new Normalizer(doc).component(node("2:4"))?.propertyDefinitions, [{ name: "label", type: "TEXT", default: "Label" }]);
  });

  it("lets an enclosing instance set a nested instance's property through an override", () => {
    // Card's instance (2:9) carries componentPropAssignments for the nested Btn (2:7) in a symbolOverride.
    const override = node("2:9").symbolData.symbolOverrides.find((o: { componentPropAssignments?: unknown }) => o.componentPropAssignments);
    assert.deepEqual((override.guidPath.guids as { sessionID: number; localID: number }[]).map(guidId), ["2:7"]);
    assert.deepEqual(scanText(doc, doc.pages(), true).items.map((t) => [t.id, t.text]), [
      ["2:5", "Label"], // the component's own text layer
      ["2:7/2:5", "Inner"], // the property value Card sets on its nested Btn
      ["2:9/2:7/2:5", "Outer"], // what the Card instance on the canvas sets, one level further out
    ]);
  });
});
