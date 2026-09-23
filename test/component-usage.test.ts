// Usage counts decide whether a component looks unused, so every way a file can render a component is pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { componentUsage, componentUses } from "../src/component-usage.ts";
import { figDoc, guid, type TestNode } from "./fixtures.ts";

const override = (path: string[], fields: object) => ({ guidPath: { guids: path.map(guid) }, ...fields });
const instance = (id: string, main: string, extra: Record<string, unknown> = {}, symbolOverrides?: object[]): TestNode => ({
  id, type: "INSTANCE", parent: "0:1", name: `inst ${id}`, symbolData: { symbolID: guid(main), ...(symbolOverrides ? { symbolOverrides } : {}) }, ...extra,
});

// A Card holding an icon slot (a nested instance of Icon A, bound to an instance-swap property), and two icons.
const nodes: TestNode[] = [
  { id: "0:1", type: "CANVAS", parent: "0:0", name: "Page" },
  { id: "0:2", type: "CANVAS", parent: "0:0", name: "Components" },
  { id: "2:0", type: "SYMBOL", parent: "0:2", name: "Card", componentPropDefs: [{ id: guid("3:1"), name: "Icon", type: "INSTANCE_SWAP" }] },
  { id: "2:1", type: "INSTANCE", parent: "2:0", name: "slot", symbolData: { symbolID: guid("5:1") } },
  { id: "5:1", type: "SYMBOL", parent: "0:2", name: "Icon A" },
  { id: "5:2", type: "SYMBOL", parent: "0:2", name: "Icon B", sourceLibraryKey: "lib" },
  { id: "5:3", type: "SYMBOL", parent: "0:2", name: "Icon C" },
];

test("direct instances and swapped-in components are counted apart", () => {
  const usage = componentUsage(figDoc([
    ...nodes,
    instance("1:1", "2:0"),
    // A swap override on the nested slot. Real files can hold a second entry for the same path carrying only
    // layout fields; it must not count again, and neither may a repeated swap entry.
    instance("1:2", "2:0", {}, [override(["2:1"], { overriddenSymbolID: guid("5:2") }), override(["2:1"], { overrideLevel: 1, size: { x: 1, y: 1 } }), override(["2:1"], { overriddenSymbolID: guid("5:2") })]),
    // Instance-swap property values, inline and variable-backed.
    instance("1:3", "2:0", { componentPropAssignments: [{ defID: guid("3:1"), value: { guidValue: guid("5:2") } }] }),
    instance("1:4", "2:0", { componentPropAssignments: [{ defID: guid("3:1"), value: {}, varValue: { value: { symbolIdValue: { guid: guid("5:3") } } } }] }),
    // A property set on a nested instance through the outer instance's overrides.
    instance("1:5", "2:0", {}, [override(["2:1"], { componentPropAssignments: [{ defID: guid("3:1"), value: { guidValue: guid("5:3") } }] })]),
    // Non-swap values and references to nothing are not uses.
    instance("1:6", "2:0", { componentPropAssignments: [{ defID: guid("3:9"), value: { boolValue: true } }, { defID: guid("3:1"), value: { guidValue: guid("99:9") } }] }),
  ]));
  assert.deepEqual(usage.get("2:0"), { instances: 6, swapInstances: 0 });
  assert.deepEqual(usage.get("5:1"), { instances: 1, swapInstances: 0 }, "the slot inside Card itself");
  assert.deepEqual(usage.get("5:2"), { instances: 0, swapInstances: 2 });
  assert.deepEqual(usage.get("5:3"), { instances: 0, swapInstances: 2 });
  assert.equal(usage.size, 4);
});

test("a slot counts once however the swap was recorded, and every slot of an instance counts", () => {
  const usage = componentUsage(figDoc([
    ...nodes,
    { id: "2:2", type: "INSTANCE", parent: "2:0", name: "slot 2", symbolData: { symbolID: guid("5:1") } },
    // Two slots of one instance holding the same icon: two uses, so the slot's path is part of its key.
    instance("1:1", "2:0", {}, [override(["2:1"], { overriddenSymbolID: guid("5:2") }), override(["2:2"], { overriddenSymbolID: guid("5:2") })]),
    // One slot recorded twice, as a swap override and as the instance-swap property on the same path: one icon.
    instance("1:2", "2:0", {}, [override(["2:1"], {
      overriddenSymbolID: guid("5:3"),
      componentPropAssignments: [{ defID: guid("3:1"), value: { guidValue: guid("5:3") } }],
    })]),
    // Two different components named on one path: both are kept, the file having the last word on what it renders.
    instance("1:3", "2:0", {}, [override(["2:1"], {
      overriddenSymbolID: guid("5:2"),
      componentPropAssignments: [{ defID: guid("3:1"), value: { guidValue: guid("5:3") } }],
    })]),
  ]));
  assert.deepEqual(usage.get("5:2"), { instances: 0, swapInstances: 3 });
  assert.deepEqual(usage.get("5:3"), { instances: 0, swapInstances: 2 });
});

test("two instance-swap properties of one instance holding the same component are two uses", () => {
  // A button with a leading and a trailing icon, both set to the same icon: it is drawn twice. Every property an
  // instance sets on itself is recorded at the instance's own (empty) path, so the path cannot tell them apart and
  // the icon was reported used once, the very "icons look unused" report this counting exists to prevent.
  const usage = componentUsage(figDoc([
    ...nodes,
    { id: "2:3", type: "SYMBOL", parent: "0:2", name: "Button", componentPropDefs: [{ id: guid("3:2"), name: "leadingIcon", type: "INSTANCE_SWAP" }, { id: guid("3:3"), name: "trailingIcon", type: "INSTANCE_SWAP" }] },
    instance("1:1", "2:3", { componentPropAssignments: [
      { defID: guid("3:2"), value: { guidValue: guid("5:2") } },
      { defID: guid("3:3"), value: { guidValue: guid("5:2") } },
    ] }),
    // The same property named twice (Figma keeps a variable-backed value beside the inline one) is still one slot.
    instance("1:2", "2:3", { componentPropAssignments: [
      { defID: guid("3:2"), value: { guidValue: guid("5:3") } },
      { defID: guid("3:2"), value: {}, varValue: { value: { symbolIdValue: { guid: guid("5:3") } } } },
    ] }),
  ]));
  assert.deepEqual(usage.get("5:2"), { instances: 0, swapInstances: 2 });
  assert.deepEqual(usage.get("5:3"), { instances: 0, swapInstances: 1 });
});

test("a swap that names something other than a component is not a use", () => {
  const uses = [...componentUses(figDoc([
    ...nodes,
    { id: "7:1", type: "FRAME", parent: "0:1", name: "not a component" },
    instance("1:1", "2:0", {}, [override(["2:1"], { overriddenSymbolID: guid("7:1") })]),
    instance("1:2", "2:0", { componentPropAssignments: [{ defID: guid("3:1"), value: { guidValue: guid("7:1") } }] }),
  ]))];
  assert.deepEqual(uses.filter((u) => u.swap), []);
});

test("uses of a superseded library copy count on the copy that is exported, and a trashed instance is no use", () => {
  const usage = componentUsage(figDoc([
    ...nodes,
    // The same component at two versions: only the newer is exported, as extractVariables keeps only the newer
    // copy of a variable and points aliases at it.
    { id: "6:1", type: "SYMBOL", parent: "0:2", name: "Chip", key: "chip", version: "2002:352" },
    { id: "6:2", type: "SYMBOL", parent: "0:2", name: "Chip", key: "chip", version: "2710:0" },
    instance("1:1", "6:1"),
    instance("1:2", "6:1"),
    instance("1:3", "6:1", { isSoftDeleted: true }),
    instance("1:4", "2:0", {}, [override(["2:1"], { overriddenSymbolID: guid("6:1") })]),
    // A component in the trash whose instances are still on the canvas is still drawn, so it keeps its count: only
    // the instance side of a use is checked for deletion.
    { id: "6:3", type: "SYMBOL", parent: "0:2", name: "Trashed", isSoftDeleted: true },
    instance("1:5", "6:3"),
  ]));
  assert.deepEqual(usage.get("6:2"), { instances: 2, swapInstances: 1 });
  assert.equal(usage.get("6:1"), undefined);
  assert.deepEqual(usage.get("6:3"), { instances: 1, swapInstances: 0 });
});

test("each use names the instance it is recorded on, so library uses can be filtered by page", () => {
  const uses = [...componentUses(figDoc([...nodes, instance("1:2", "2:0", {}, [override(["2:1"], { overriddenSymbolID: guid("5:2") })])]))];
  const swapped = uses.filter((u) => u.swap);
  assert.deepEqual(swapped.map((u) => [u.instance.id, u.component.id, u.component.sourceLibraryKey]), [["1:2", "5:2", "lib"]]);
});
