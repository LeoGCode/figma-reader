// Text inside a collapsed instance exists only as the main component's subtree plus overrides and property values, so
// these pin how scanText renders it, which layer wins, and that whatever it cannot render is counted.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupUnresolved, scanText } from "../src/instance-text.ts";
import { figDoc, guid, internalPage, variable, variableSet, type TestNode } from "./fixtures.ts";

const page: TestNode = { id: "0:1", type: "CANVAS", parent: "0:0", name: "Page" };
const components: TestNode = { id: "0:2", type: "CANVAS", parent: "0:0", name: "Components" };

// A "Button" component set with one variant. Its Label text is bound to a text property whose default lives on the
// set (the variant's local def points at it via parentPropDefId); its Hint text is plain.
const button: TestNode[] = [
  components,
  {
    id: "2:0", type: "FRAME", parent: "0:2", name: "Button", isStateGroup: true,
    componentPropDefs: [{ id: guid("3:1"), name: "Label", type: "TEXT", initialValue: { textValue: { characters: "Default label" } } }],
  },
  { id: "2:1", type: "SYMBOL", parent: "2:0", name: "Size=Large", componentPropDefs: [{ id: guid("3:2"), parentPropDefId: guid("3:1") }] },
  { id: "2:2", type: "TEXT", parent: "2:1", name: "Label", componentPropRefs: [{ componentPropNodeField: "TEXT_DATA", defID: guid("3:2") }] },
  { id: "2:3", type: "TEXT", parent: "2:1", name: "Hint", textData: { characters: "Press enter" } },
];

const instance = (id: string, parent: string, main: string, { symbolData, ...extra }: Record<string, unknown> = {}): TestNode => ({
  id, type: "INSTANCE", parent, name: `inst ${id}`, symbolData: { symbolID: guid(main), ...(symbolData as object) }, ...extra,
});
const override = (path: string[], fields: object) => ({ guidPath: { guids: path.map(guid) }, ...fields });
const texts = (nodes: TestNode[], root = "0:1", includeHidden = false) => {
  const doc = figDoc(nodes);
  return scanText(doc, [doc.require(root)], includeHidden);
};

describe("scanText on real layers", () => {
  it("returns text in reading order with its enclosing frame", () => {
    const { items, unresolved } = texts([
      page,
      { id: "1:1", type: "FRAME", parent: "0:1", name: "Login" },
      { id: "1:2", type: "TEXT", parent: "1:1", name: "Title", textData: { characters: "Welcome" } },
      { id: "1:3", type: "TEXT", parent: "1:1", name: "Empty", textData: { characters: "" } },
      { id: "1:4", type: "TEXT", parent: "1:1", name: "Body", textData: { characters: "Sign in" } },
    ]);
    assert.deepEqual(items, [
      { id: "1:2", name: "Title", text: "Welcome", via: "direct", frame: "Login" },
      { id: "1:4", name: "Body", text: "Sign in", via: "direct", frame: "Login" },
    ]);
    assert.deepEqual(unresolved, []);
  });

  it("skips hidden layers and everything under them unless asked", () => {
    const nodes: TestNode[] = [
      page,
      { id: "1:1", type: "TEXT", parent: "0:1", name: "Shown", textData: { characters: "shown" } },
      { id: "1:2", type: "TEXT", parent: "0:1", name: "Off", visible: false, textData: { characters: "off" } },
      { id: "1:3", type: "FRAME", parent: "0:1", name: "Hidden group", visible: false },
      { id: "1:4", type: "FRAME", parent: "1:3", name: "Inner" },
      { id: "1:5", type: "TEXT", parent: "1:4", name: "Deep", textData: { characters: "deep" } },
    ];
    assert.deepEqual(texts(nodes).items.map((t) => t.text), ["shown"]);
    assert.deepEqual(texts(nodes, "0:1", true).items.map((t) => t.text), ["shown", "off", "deep"]);
  });

  it("tags text under an expanded instance with that instance's component", () => {
    const { items } = texts([
      page, ...button,
      instance("1:1", "0:1", "2:1"),
      { id: "1:2", type: "TEXT", parent: "1:1", name: "Hint", textData: { characters: "Real child" } },
    ]);
    assert.deepEqual(items, [{ id: "1:2", name: "Hint", text: "Real child", via: "instance", component: "Button", variant: "Size=Large" }]);
  });
});

describe("scanText in collapsed instances", () => {
  it("renders the main component's text under the instance's id, tagged with component, variant and frame", () => {
    const { items } = texts([page, ...button, { id: "1:1", type: "FRAME", parent: "0:1", name: "Login" }, instance("1:2", "1:1", "2:1")]);
    assert.deepEqual(items, [
      { id: "1:2/2:2", name: "Label", text: "Default label", via: "instance", component: "Button", variant: "Size=Large", frame: "Login" },
      { id: "1:2/2:3", name: "Hint", text: "Press enter", via: "instance", component: "Button", variant: "Size=Large", frame: "Login" },
    ]);
  });

  it("takes a text property from the instance's assignment, in either value shape", () => {
    const inline = texts([page, ...button, instance("1:1", "0:1", "2:1", {
      componentPropAssignments: [{ defID: guid("3:2"), value: { textValue: { characters: "Log in" } } }],
    })]);
    assert.equal(inline.items[0].text, "Log in");
    const variable = texts([page, ...button, instance("1:1", "0:1", "2:1", {
      componentPropAssignments: [{ defID: guid("3:2"), value: {}, varValue: { value: { textDataValue: { characters: "Request quote" } } } }],
    })]);
    assert.equal(variable.items[0].text, "Request quote");
  });

  it("lets a text override beat the property's default", () => {
    const { items } = texts([page, ...button, instance("1:1", "0:1", "2:1", {
      symbolData: { symbolOverrides: [override(["2:2"], { textData: { characters: "Overridden" } })] },
    })]);
    assert.equal(items[0].text, "Overridden");
  });

  it("lets a property value assigned on the same instance beat its text override", () => {
    // Figma shows the assignment (checked on screenshots); before, the override won.
    const { items } = texts([page, ...button, instance("1:1", "0:1", "2:1", {
      componentPropAssignments: [{ defID: guid("3:2"), value: { textValue: { characters: "Assigned" } } }],
      symbolData: { symbolOverrides: [override(["2:2"], { textData: { characters: "Overridden" } })] },
    })]);
    assert.equal(items[0].text, "Assigned");
  });

  it("renders an empty assignment or an empty text override as nothing, not the component's text", () => {
    const withOwnText = button.map((n) => (n.id === "2:2" ? { ...n, textData: { characters: "Main label" } } : n));
    const empty = (extra: Record<string, unknown>) => texts([page, ...withOwnText, instance("1:1", "0:1", "2:1", extra)]).items.map((t) => t.name);
    assert.deepEqual(empty({ componentPropAssignments: [{ defID: guid("3:2"), value: { textValue: { characters: "" } } }] }), ["Hint"]);
    assert.deepEqual(empty({ symbolData: { symbolOverrides: [override(["2:3"], { textData: { characters: "" } })] } }), ["Label"]);
  });

  it("takes text bound to a property only through the layer's parameterConsumptionMap", () => {
    // Some layers carry the binding only there; before, they showed their stale own characters.
    const bound: TestNode = {
      id: "2:4", type: "TEXT", parent: "2:1", name: "Caption", textData: { characters: "stale" },
      parameterConsumptionMap: { entries: [{ variableField: "TEXT_DATA", variableData: { value: { propRefValue: { defId: guid("3:2") } }, dataType: "PROP_REF" } }] },
    };
    const caption = (extra: Record<string, unknown> = {}) =>
      texts([page, ...button, bound, instance("1:1", "0:1", "2:1", extra)]).items.find((t) => t.name === "Caption")?.text;
    assert.equal(caption(), "Default label");
    assert.equal(caption({ componentPropAssignments: [{ defID: guid("3:2"), value: { textValue: { characters: "Log in" } } }] }), "Log in");
  });

  it("hides a layer the instance overrides as hidden, unless hidden text is asked for", () => {
    const nodes = [page, ...button, instance("1:1", "0:1", "2:1", {
      symbolData: { symbolOverrides: [override(["2:3"], { visible: false })] },
    })];
    assert.deepEqual(texts(nodes).items.map((t) => t.name), ["Label"]);
    assert.deepEqual(texts(nodes, "0:1", true).items.map((t) => t.name), ["Label", "Hint"]);
  });

  it("finds a library main component by its key when the guid is not local", () => {
    const { items, unresolved } = texts([
      page,
      components,
      { id: "2:1", type: "SYMBOL", parent: "0:2", name: "Chip", key: "chip-key" },
      { id: "2:2", type: "TEXT", parent: "2:1", name: "T", textData: { characters: "chip" } },
      { id: "1:1", type: "INSTANCE", parent: "0:1", name: "i", symbolData: { symbolID: guid("99:99") }, sharedSymbolReference: { componentKey: "chip-key" } },
    ]);
    assert.deepEqual(items.map((t) => [t.id, t.text, t.component]), [["1:1/2:2", "chip", "Chip"]]);
    assert.deepEqual(unresolved, []);
  });
});

describe("scanText with properties bound to variables", () => {
  // Binding a component property to a variable writes the assignment as an ALIAS naming the variable.
  const boundTo = (ref: object) => ({
    componentPropAssignments: [{ defID: guid("3:2"), value: {}, varValue: { value: { alias: ref }, dataType: "ALIAS", resolvedDataType: "TEXT_DATA" } }],
  });
  const copy: TestNode[] = [
    internalPage,
    variableSet("9:0", "Copy", [["9:1", "Mode 1"]]),
    variable("9:2", "9:0", "cta/label", "STRING", { "9:1": { text: "Buy now" } }),
  ];

  it("renders the variable the text property is bound to, not the component's default", () => {
    // Before, this shape was not decoded, so the instance rendered "Default label" and nothing was reported.
    const { items, unresolved } = texts([page, ...button, ...copy, instance("1:1", "0:1", "2:1", boundTo({ guid: guid("9:2") }))]);
    assert.equal(items[0].text, "Buy now");
    assert.deepEqual(unresolved, []);
  });

  it("counts a layer whose text is bound to a variable the file has no copy of", () => {
    const { items, unresolved } = texts([page, ...button, ...copy, instance("1:1", "0:1", "2:1", boundTo({ assetRef: { key: "lib-var" } }))]);
    assert.deepEqual(items.map((t) => t.name), ["Hint"]);
    assert.deepEqual(unresolved, [{
      id: "1:1/2:2", name: "Label", component: "Button",
      reason: "text property bound to a variable that is not in this file (library variable with no local copy)",
    }]);
  });
});

describe("scanText on an instance pointing at a component set", () => {
  // A component published on its own and later combined into a variant set keeps its key on the set, so a
  // sharedSymbolReference resolves to the set - which renders nothing of its own.
  const set: TestNode[] = [
    components,
    {
      id: "2:0", type: "FRAME", parent: "0:2", name: "Button", isStateGroup: true, key: "btn-key",
      componentPropDefs: [
        { id: guid("3:1"), name: "State", type: "VARIANT", initialValue: { textValue: { characters: "Default" } } },
        { id: guid("3:2"), name: "Label", type: "TEXT", initialValue: { textValue: { characters: "Default label" } } },
      ],
    },
    { id: "2:1", type: "SYMBOL", parent: "2:0", name: "State=Default" },
    { id: "2:2", type: "TEXT", parent: "2:1", name: "L", textData: { characters: "Default label" } },
    { id: "2:3", type: "SYMBOL", parent: "2:0", name: "State=Hover" },
    { id: "2:4", type: "TEXT", parent: "2:3", name: "L", textData: { characters: "Hover label" } },
  ];
  const byKey = (extra: Record<string, unknown> = {}): TestNode =>
    ({ id: "1:1", type: "INSTANCE", parent: "0:1", name: "i", sharedSymbolReference: { componentKey: "btn-key" }, ...extra });

  it("renders the one variant the instance's assignment names", () => {
    const { items, unresolved } = texts([page, ...set, byKey({ componentPropAssignments: [{ defID: guid("3:1"), value: { textValue: { characters: "Hover" } } }] })]);
    assert.deepEqual(items.map((t) => [t.id, t.text, t.component, t.variant]), [["1:1/2:4", "Hover label", "Button", "State=Hover"]]);
    assert.deepEqual(unresolved, []);
  });

  it("keeps the variant an instance names when the same instance also assigns a non-variant property", () => {
    // "Label" is a text property of the set, so it names nothing in any variant's name: an instance assigning it
    // narrows nothing. Reading the instance's assignments without that filter left no variant matching at all, so
    // every string the instance renders was reported missing because a designer had typed a label into it.
    const { items, unresolved } = texts([page, ...set, byKey({
      componentPropAssignments: [
        { defID: guid("3:1"), value: { textValue: { characters: "Hover" } } },
        { defID: guid("3:2"), value: { textValue: { characters: "Buy now" } } },
      ],
    })]);
    assert.deepEqual(items.map((t) => [t.text, t.variant]), [["Hover label", "State=Hover"]]);
    assert.deepEqual(unresolved, []);
  });

  it("renders the variant the set's own defaults name for the axes the instance leaves alone", () => {
    // A variant property left at the set's default is written nowhere on the instance, so a set with two axes and an
    // instance assigning one of them matched two variants and that instance's whole text was reported as missing -
    // although Figma has no doubt which variant it draws.
    const sized: TestNode[] = [
      components,
      {
        id: "2:0", type: "FRAME", parent: "0:2", name: "Button", isStateGroup: true, key: "btn-key",
        componentPropDefs: [
          { id: guid("3:1"), name: "State", type: "VARIANT", initialValue: { textValue: { characters: "Default" } } },
          { id: guid("3:2"), name: "Size", type: "VARIANT", initialValue: { textValue: { characters: "Small" } } },
          // A text property of the set names nothing in any variant's name, so it must not narrow the search either.
          { id: guid("3:3"), name: "Label", type: "TEXT", initialValue: { textValue: { characters: "Default label" } } },
        ],
      },
      { id: "2:1", type: "SYMBOL", parent: "2:0", name: "Size=Small, State=Default" },
      { id: "2:2", type: "TEXT", parent: "2:1", name: "L", textData: { characters: "Small default" } },
      { id: "2:3", type: "SYMBOL", parent: "2:0", name: "Size=Large, State=Default" },
      { id: "2:4", type: "TEXT", parent: "2:3", name: "L", textData: { characters: "Large default" } },
      { id: "2:5", type: "SYMBOL", parent: "2:0", name: "Size=Large, State=Hover" },
      { id: "2:6", type: "TEXT", parent: "2:5", name: "L", textData: { characters: "Large hover" } },
    ];
    const shown = (extra: Record<string, unknown> = {}) => texts([page, ...sized, byKey(extra)]).items.map((t) => [t.text, t.variant]);
    assert.deepEqual(shown(), [["Small default", "Size=Small, State=Default"]]);
    const large = { componentPropAssignments: [{ defID: guid("3:2"), value: { textValue: { characters: "Large" } } }] };
    assert.deepEqual(shown(large), [["Large default", "Size=Large, State=Default"]]);
  });

  it("counts an instance no single variant matches instead of rendering the whole set", () => {
    // Before, every variant's text came back as one instance's, under the set's name and with no variant. With no
    // default declared on the set and nothing assigned on the instance, the file itself does not say which renders.
    const noDefaults = set.map((n) => (n.id === "2:0" ? { ...n, componentPropDefs: undefined } : n));
    const { items, unresolved } = texts([page, ...noDefaults, byKey()]);
    assert.deepEqual(items, []);
    assert.deepEqual(unresolved, [{
      id: "1:1", name: "i", component: "Button", mainRef: "btn-key",
      reason: "points at a component set, and no single variant of it matches the instance",
    }]);
  });
});

describe("scanText in nested instances", () => {
  // A "Card" component holding a Button instance.
  const card = (innerOverrides: object[] = []): TestNode[] => [
    ...button,
    { id: "4:0", type: "SYMBOL", parent: "0:2", name: "Card" },
    { id: "4:1", type: "TEXT", parent: "4:0", name: "Heading", textData: { characters: "Card title" } },
    instance("4:2", "4:0", "2:1", { symbolData: { symbolOverrides: innerOverrides } }),
  ];

  it("addresses inner text by its path through every instance and tags it with the innermost component", () => {
    const { items } = texts([page, ...card(), instance("1:1", "0:1", "4:0")]);
    assert.deepEqual(items.map((t) => [t.id, t.text, t.component]), [
      ["1:1/4:1", "Card title", "Card"],
      ["1:1/4:2/2:2", "Default label", "Button"],
      ["1:1/4:2/2:3", "Press enter", "Button"],
    ]);
  });

  it("applies the inner instance's own overrides, and lets the outer instance's override win", () => {
    const inner = [override(["2:3"], { textData: { characters: "Inner hint" } })];
    assert.equal(texts([page, ...card(inner), instance("1:1", "0:1", "4:0")]).items[2].text, "Inner hint");
    const outer = texts([page, ...card(inner), instance("1:1", "0:1", "4:0", {
      symbolData: { symbolOverrides: [override(["4:2", "2:3"], { textData: { characters: "Outer hint" } })] },
    })]);
    assert.equal(outer.items[2].text, "Outer hint");
  });

  it("lets a text override on an outer instance beat a property value assigned further in", () => {
    const nodes: TestNode[] = [
      page, ...button,
      { id: "4:0", type: "SYMBOL", parent: "0:2", name: "Card" },
      instance("4:2", "4:0", "2:1", { componentPropAssignments: [{ defID: guid("3:2"), value: { textValue: { characters: "From card" } } }] }),
      instance("1:1", "0:1", "4:0", { symbolData: { symbolOverrides: [override(["4:2", "2:2"], { textData: { characters: "From page" } })] } }),
    ];
    assert.equal(texts(nodes).items[0].text, "From page");
  });

  it("lets a property value assigned on an outer instance beat a text override further in", () => {
    // The card's button overrides its label text; the page sets the label property on that button.
    const nodes: TestNode[] = [
      page, ...button,
      { id: "4:0", type: "SYMBOL", parent: "0:2", name: "Card" },
      instance("4:2", "4:0", "2:1", { symbolData: { symbolOverrides: [override(["2:2"], { textData: { characters: "From card" } })] } }),
      instance("1:1", "0:1", "4:0", {
        symbolData: { symbolOverrides: [override(["4:2"], { componentPropAssignments: [{ defID: guid("3:2"), value: { textValue: { characters: "From page" } } }] })] },
      }),
    ];
    assert.equal(texts(nodes).items[0].text, "From page");
  });

  it("lets a property value an outer instance sets on a nested one beat that outer instance's text override", () => {
    const nodes: TestNode[] = [
      page, ...button,
      { id: "4:0", type: "SYMBOL", parent: "0:2", name: "Card" },
      instance("4:2", "4:0", "2:1"),
      instance("1:1", "0:1", "4:0", {
        symbolData: {
          symbolOverrides: [
            override(["4:2", "2:2"], { textData: { characters: "Overridden" } }),
            override(["4:2"], { componentPropAssignments: [{ defID: guid("3:2"), value: { textValue: { characters: "Assigned" } } }] }),
          ],
        },
      }),
    ];
    assert.equal(texts(nodes).items[0].text, "Assigned");
  });
});

describe("scanText override addressing", () => {
  // How real files address overrides (guidPath): each layer's overrideKey, not its id, and one entry per enclosing
  // instance plus the target, skipping the frames in between. Library copies get new ids but keep their keys.
  const card: TestNode[] = [
    components,
    { id: "2:0", type: "SYMBOL", parent: "0:2", name: "Chip", overrideKey: guid("80:0") },
    { id: "2:1", type: "TEXT", parent: "2:0", name: "Chip text", overrideKey: guid("80:1"), textData: { characters: "Chip" } },
    { id: "4:0", type: "SYMBOL", parent: "0:2", name: "Card", overrideKey: guid("90:0") },
    { id: "4:1", type: "FRAME", parent: "4:0", name: "Header", overrideKey: guid("90:1") },
    { id: "4:2", type: "TEXT", parent: "4:1", name: "Title", overrideKey: guid("90:2"), textData: { characters: "Title" } },
    { id: "4:3", type: "FRAME", parent: "4:1", name: "Chips", overrideKey: guid("90:3") },
    instance("4:4", "4:3", "2:0", { overrideKey: guid("90:4") }),
  ];
  const rendered = (overrides: object[]) => texts([page, ...card, instance("1:1", "0:1", "4:0", { symbolData: { symbolOverrides: overrides } })]).items.map((t) => [t.id, t.text]);

  it("matches a layer by its override key, with no entries for the frames around it", () => {
    // Before, overrides were matched by node-id paths through every frame, so none of these applied.
    assert.deepEqual(rendered([override(["90:2"], { textData: { characters: "Certificado" } })]), [["1:1/4:1/4:2", "Certificado"], ["1:1/4:1/4:3/4:4/2:1", "Chip"]]);
  });

  it("reaches into a nested instance with one key per instance level", () => {
    assert.deepEqual(rendered([override(["90:4", "80:1"], { textData: { characters: "60,00 €" } })]), [["1:1/4:1/4:2", "Title"], ["1:1/4:1/4:3/4:4/2:1", "60,00 €"]]);
    assert.deepEqual(rendered([override(["90:4", "80:1"], { visible: false })]).map(([, t]) => t), ["Title"]);
  });

  it("keeps one layer's override key from matching another layer's node id", () => {
    // Locally authored components carry no override key, so their guidPaths are node ids, while library copies use
    // keys: both id spaces live in one file and a guid can read as either. Before, the override landed on both layers.
    const collide: TestNode[] = [
      components,
      { id: "4:0", type: "SYMBOL", parent: "0:2", name: "Card" },
      { id: "4:1", type: "TEXT", parent: "4:0", name: "Keyed", overrideKey: guid("90:2"), textData: { characters: "keyed" } },
      { id: "90:2", type: "TEXT", parent: "4:0", name: "Id-only", textData: { characters: "id-only" } },
    ];
    const rendered = texts([page, ...collide, instance("1:1", "0:1", "4:0", {
      symbolData: { symbolOverrides: [override(["90:2"], { textData: { characters: "Overridden" } })] },
    })]).items.map((t) => [t.name, t.text]);
    assert.deepEqual(rendered, [["Keyed", "Overridden"], ["Id-only", "id-only"]]);
  });

  it("does not match a layer by the id path it used to be looked up by", () => {
    assert.deepEqual(rendered([override(["4:1", "4:2"], { textData: { characters: "wrong" } })]).map(([, t]) => t), ["Title", "Chip"]);
  });
});

describe("scanText override addressing with both id spaces in one file", () => {
  // The shape of a real product file: a locally drawn "Card", whose layers carry no override key at all, so its
  // guidPaths are node ids; and library components copied in, which kept the override keys they were given in the
  // library file. Those keys were allocated elsewhere, so nothing stops one from reading exactly like a Card layer's
  // node id - here the Chip's text is keyed "4:1", which is the Card's title, and a Banner nobody instantiates is
  // keyed "4:2", which is the Card's chip row.
  const mixed: TestNode[] = [
    components,
    { id: "4:0", type: "SYMBOL", parent: "0:2", name: "Card" },
    { id: "4:1", type: "TEXT", parent: "4:0", name: "Title", textData: { characters: "Title" } },
    { id: "4:2", type: "FRAME", parent: "4:0", name: "Chips" },
    instance("4:3", "4:2", "2:0"),
    { id: "2:0", type: "SYMBOL", parent: "0:2", name: "Chip", key: "chip-key", overrideKey: guid("80:0") },
    { id: "2:1", type: "TEXT", parent: "2:0", name: "Chip text", overrideKey: guid("4:1"), textData: { characters: "Chip" } },
    { id: "6:0", type: "SYMBOL", parent: "0:2", name: "Banner", key: "banner-key", overrideKey: guid("70:0") },
    { id: "6:1", type: "TEXT", parent: "6:0", name: "Banner text", overrideKey: guid("4:2"), textData: { characters: "Banner" } },
  ];
  const rendered = (overrides: object[]) =>
    texts([page, ...mixed, instance("1:1", "0:1", "4:0", { symbolData: { symbolOverrides: overrides } })]).items.map((t) => [t.id, t.text]);

  it("reads one guid as a node id at one level and as an override key at the next", () => {
    // Both overrides are written "4:1": the first names the Card's title by id, the second names the Chip's text by
    // its key. Before, a single question was asked of the whole document - "is this string any layer's override key?"
    // - so the first override was stored under the key reading, matched nothing, and the designer's edit vanished
    // behind the component's own text. The Banner is enough to do it: nothing here instantiates it.
    assert.deepEqual(rendered([
      override(["4:1"], { textData: { characters: "Certificado" } }),
      override(["4:3", "4:1"], { textData: { characters: "60,00 €" } }),
    ]), [["1:1/4:1", "Certificado"], ["1:1/4:2/4:3/2:1", "60,00 €"]]);
  });

  it("reads a nested guid against the component the instance renders, not the instance itself", () => {
    // The mirror of the case above, one level down: here it is the nested Chip's text that is keyless, and the guid
    // naming it ("4:1") is the key an uninstantiated Banner carries. Only the layers of the component the Chip
    // instance renders say which reading that guid was written in - the instance's own subtree is empty, it being
    // collapsed, and the document-wide reading calls "4:1" an override key, which reaches no layer of the Chip.
    const keyless: TestNode[] = [
      components,
      { id: "5:0", type: "SYMBOL", parent: "0:2", name: "Card" },
      { id: "5:1", type: "FRAME", parent: "5:0", name: "Chips" },
      instance("5:2", "5:1", "3:0"),
      { id: "3:0", type: "SYMBOL", parent: "0:2", name: "Chip" },
      { id: "4:1", type: "TEXT", parent: "3:0", name: "Chip text", textData: { characters: "Chip" } },
      { id: "6:0", type: "SYMBOL", parent: "0:2", name: "Banner", key: "banner-key", overrideKey: guid("70:0") },
      { id: "6:1", type: "TEXT", parent: "6:0", name: "Banner text", overrideKey: guid("4:1"), textData: { characters: "Banner" } },
    ];
    const { items } = texts([page, ...keyless, instance("1:1", "0:1", "5:0", {
      symbolData: { symbolOverrides: [override(["5:2", "4:1"], { textData: { characters: "60,00 €" } })] },
    })]);
    assert.deepEqual(items.map((t) => [t.id, t.text]), [["1:1/5:1/5:2/4:1", "60,00 €"]]);
  });

  it("keeps addressing a keyed layer by its key alone, at any depth", () => {
    // The Chip's text has a key, so its node id ("2:1") is not how an override reaches it - the same rule that keeps
    // a library layer's key from being applied to the local layer whose node id it reads like.
    assert.deepEqual(rendered([override(["4:3", "2:1"], { textData: { characters: "wrong" } })]), [["1:1/4:1", "Title"], ["1:1/4:2/4:3/2:1", "Chip"]]);
    assert.deepEqual(rendered([override(["4:3", "80:1"], { textData: { characters: "wrong" } })]), [["1:1/4:1", "Title"], ["1:1/4:2/4:3/2:1", "Chip"]]);
  });

  it("hides a layer through the same path it would set its text through", () => {
    // Visibility and text come through one addressing, so a wrong reading of the path loses the hidden layer too.
    assert.deepEqual(rendered([override(["4:1"], { visible: false })]), [["1:1/4:2/4:3/2:1", "Chip"]]);
  });
});

describe("scanText with boolean properties and visibility overrides", () => {
  // "Field": a label, and a hint group whose visibility is bound to the "Show hint" boolean property.
  const field = (showHintDefault: boolean): TestNode[] => [
    components,
    { id: "2:0", type: "SYMBOL", parent: "0:2", name: "Field", componentPropDefs: [{ id: guid("3:1"), name: "Show hint", type: "BOOL", initialValue: { boolValue: showHintDefault } }] },
    { id: "2:1", type: "TEXT", parent: "2:0", name: "Label", textData: { characters: "Email" } },
    {
      id: "2:2", type: "FRAME", parent: "2:0", name: "Hint group", visible: showHintDefault,
      componentPropRefs: [{ componentPropNodeField: "VISIBLE", defID: guid("3:1") }],
    },
    { id: "2:3", type: "TEXT", parent: "2:2", name: "Hint", textData: { characters: "We never share it" } },
    { id: "2:4", type: "TEXT", parent: "2:0", name: "Error", visible: false, textData: { characters: "Required" } },
  ];
  const show = (value: boolean) => ({ componentPropAssignments: [{ defID: guid("3:1"), value: { boolValue: value } }] });
  const names = (nodes: TestNode[], includeHidden = false) => texts(nodes, "0:1", includeHidden).items.map((t) => t.name);

  it("hides a layer, and everything in it, whose boolean property is set to false", () => {
    // Before, this text was returned although the designer had switched it off.
    assert.deepEqual(names([page, ...field(true), instance("1:1", "0:1", "2:0", show(false))]), ["Label"]);
    assert.deepEqual(names([page, ...field(true), instance("1:1", "0:1", "2:0", show(false))], true), ["Label", "Hint", "Error"]);
  });

  it("follows the property's default when the instance does not set it, and shows the layer when set to true", () => {
    assert.deepEqual(names([page, ...field(false), instance("1:1", "0:1", "2:0")]), ["Label"]);
    assert.deepEqual(names([page, ...field(false), instance("1:1", "0:1", "2:0", show(true))]), ["Label", "Hint"]);
  });

  it("lets a visibility override show a layer hidden in the main component, not only hide one", () => {
    const nodes = [page, ...field(true), instance("1:1", "0:1", "2:0", { symbolData: { symbolOverrides: [override(["2:4"], { visible: true })] } })];
    assert.deepEqual(names(nodes), ["Label", "Hint", "Error"]);
  });

  it("lets a layer's boolean property beat a visibility override on it", () => {
    const hide = override(["2:2"], { visible: false });
    assert.deepEqual(names([page, ...field(true), instance("1:1", "0:1", "2:0", { symbolData: { symbolOverrides: [hide] } })]), ["Label", "Hint"]);
    const showIt = override(["2:2"], { visible: true });
    assert.deepEqual(names([page, ...field(true), instance("1:1", "0:1", "2:0", { ...show(false), symbolData: { symbolOverrides: [showIt] } })]), ["Label"]);
  });

  it("reads a visibility binding held only in the parameterConsumptionMap", () => {
    const nodes = field(true).map((n) => n.id === "2:2"
      ? { ...n, componentPropRefs: undefined, parameterConsumptionMap: { entries: [{ variableField: "VISIBLE", variableData: { value: { propRefValue: { defId: guid("3:1") } } } }] } }
      : n);
    assert.deepEqual(names([page, ...nodes, instance("1:1", "0:1", "2:0", show(false))]), ["Label"]);
  });
});

describe("scanText with instance swaps", () => {
  // A "Row" holding an icon slot: a nested instance of "Badge", bound to the "Icon" swap property. "Tag" is the
  // alternative, with a text property of its own.
  const row: TestNode[] = [
    components,
    { id: "2:0", type: "SYMBOL", parent: "0:2", name: "Badge" },
    { id: "2:1", type: "TEXT", parent: "2:0", name: "Badge text", textData: { characters: "New" } },
    {
      id: "5:0", type: "SYMBOL", parent: "0:2", name: "Tag",
      componentPropDefs: [{ id: guid("6:1"), name: "Label", type: "TEXT", initialValue: { textValue: { characters: "Tag" } } }],
    },
    { id: "5:1", type: "TEXT", parent: "5:0", name: "Tag text", componentPropRefs: [{ componentPropNodeField: "TEXT_DATA", defID: guid("6:1") }] },
    {
      id: "4:0", type: "SYMBOL", parent: "0:2", name: "Row",
      componentPropDefs: [{ id: guid("3:1"), name: "Icon", type: "INSTANCE_SWAP", initialValue: { guidValue: guid("2:0") } }],
    },
    instance("4:1", "4:0", "2:0", { componentPropRefs: [{ componentPropNodeField: "OVERRIDDEN_SYMBOL_ID", defID: guid("3:1") }] }),
  ];
  const rendered = (nodes: TestNode[]) => texts(nodes).items.map((t) => [t.id, t.text, t.component]);

  it("renders the component chosen through the swap property", () => {
    assert.deepEqual(rendered([page, ...row, instance("1:1", "0:1", "4:0")]), [["1:1/4:1/2:1", "New", "Badge"]]);
    const swapped = instance("1:1", "0:1", "4:0", { componentPropAssignments: [{ defID: guid("3:1"), value: { guidValue: guid("5:0") } }] });
    assert.deepEqual(rendered([page, ...row, swapped]), [["1:1/4:1/5:1", "Tag", "Tag"]]);
  });

  it("renders the component swapped in by an override, with property values the override sets on it", () => {
    const swapped = instance("1:1", "0:1", "4:0", {
      symbolData: {
        symbolOverrides: [override(["4:1"], {
          overriddenSymbolID: guid("5:0"),
          componentPropAssignments: [{ defID: guid("6:1"), value: { textValue: { characters: "Beta" } } }],
        })],
      },
    });
    assert.deepEqual(rendered([page, ...row, swapped]), [["1:1/4:1/5:1", "Beta", "Tag"]]);
  });

  it("keeps the swap when Figma writes the layer's layout in a second entry for the same path", () => {
    // Figma splits a layer's overrides: swap, property values, visibility and text in one entry, layout fields in
    // another with overrideLevel 1. Before, the later entry replaced the first and the swap was lost.
    const swapped = instance("1:1", "0:1", "4:0", {
      symbolData: {
        symbolOverrides: [
          override(["4:1"], { overriddenSymbolID: guid("5:0"), componentPropAssignments: [{ defID: guid("6:1"), value: { textValue: { characters: "Beta" } } }] }),
          override(["4:1"], { overrideLevel: 1, size: { x: 40, y: 20 } }),
        ],
      },
    });
    assert.deepEqual(rendered([page, ...row, swapped]), [["1:1/4:1/5:1", "Beta", "Tag"]]);
  });

  it("lets a swap override beat a conflicting swap property", () => {
    const nodes = [page, ...row, instance("1:1", "0:1", "4:0", {
      componentPropAssignments: [{ defID: guid("3:1"), value: { guidValue: guid("5:0") } }],
      symbolData: { symbolOverrides: [override(["4:1"], { overriddenSymbolID: guid("2:0") })] },
    })];
    assert.deepEqual(rendered(nodes), [["1:1/4:1/2:1", "New", "Badge"]]);
  });

  it("reports a nested instance whose swap property cannot be read, rather than its unswapped component", () => {
    const { items, unresolved } = texts([page, ...row, instance("1:1", "0:1", "4:0", {
      componentPropAssignments: [{ defID: guid("3:1"), value: {}, varValue: { value: { alias: { assetRef: { key: "lib-var" } } } } }],
    })]);
    assert.deepEqual(items, []);
    assert.deepEqual(unresolved, [{
      id: "1:1/4:1", name: "inst 4:1", component: "Row", mainRef: "2:0",
      reason: "instance-swap property bound to a variable that is not in this file (library variable with no local copy)",
    }]);
  });

  it("renders a swap slot left at the component it already shows, by whatever reference finds it", () => {
    // A library Row: its icon slot is an instance of the library's Badge, and the swap property's default names that
    // same Badge by the guid it has in the library file, which this file does not have - it has the Badge by key.
    // A swap property naming the instance's own component swaps nothing, so it must not turn a reference that
    // resolves by key into a swap to a guid nobody can follow, which lost every badge's text.
    const library: TestNode[] = [
      components,
      { id: "2:5", type: "SYMBOL", parent: "0:2", name: "Badge", key: "badge-key" },
      { id: "2:6", type: "TEXT", parent: "2:5", name: "Badge text", textData: { characters: "New" } },
      {
        id: "7:0", type: "SYMBOL", parent: "0:2", name: "Row", key: "row-key",
        componentPropDefs: [{ id: guid("7:1"), name: "Icon", type: "INSTANCE_SWAP", initialValue: { guidValue: guid("99:9") } }],
      },
      {
        id: "7:2", type: "INSTANCE", parent: "7:0", name: "icon", symbolData: { symbolID: guid("99:9") },
        sharedSymbolReference: { componentKey: "badge-key" },
        componentPropRefs: [{ componentPropNodeField: "OVERRIDDEN_SYMBOL_ID", defID: guid("7:1") }],
      },
    ];
    const { items, unresolved } = texts([page, ...library, instance("1:1", "0:1", "7:0")]);
    assert.deepEqual(items.map((t) => [t.id, t.text, t.component]), [["1:1/7:2/2:6", "New", "Badge"]]);
    assert.deepEqual(unresolved, []);
  });

  it("reports a swap to a component that is not in the file", () => {
    const { items, unresolved } = texts([page, ...row, instance("1:1", "0:1", "4:0", {
      symbolData: { symbolOverrides: [override(["4:1"], { overriddenSymbolID: guid("99:9") })] },
    })]);
    assert.deepEqual(items, []);
    assert.deepEqual(unresolved, [{ id: "1:1/4:1", name: "inst 4:1", reason: "swapped-in component is not present in this file", mainRef: "99:9" }]);
  });
});

describe("scanText with properties set on nested instances", () => {
  it("applies a property an enclosing instance's override sets on a nested instance, outermost last", () => {
    // Card holds a Button; the page sets the button's label through an override on the card instance.
    const label = (text: string) => ({ componentPropAssignments: [{ defID: guid("3:2"), value: { textValue: { characters: text } } }] });
    const nodes = (outer: object[]): TestNode[] => [
      page, ...button,
      { id: "4:0", type: "SYMBOL", parent: "0:2", name: "Card" },
      instance("4:2", "4:0", "2:1", label("From card")),
      instance("1:1", "0:1", "4:0", { symbolData: { symbolOverrides: outer } }),
    ];
    assert.equal(texts(nodes([])).items[0].text, "From card");
    assert.equal(texts(nodes([override(["4:2"], label("From page"))])).items[0].text, "From page");
  });

  it("lets the outermost of three instance levels set the property", () => {
    // Page > Panel > Card > Button, each level assigning the button's label.
    const label = (text: string) => ({ componentPropAssignments: [{ defID: guid("3:2"), value: { textValue: { characters: text } } }] });
    const nodes = (outer: object[]): TestNode[] => [
      page, ...button,
      { id: "4:0", type: "SYMBOL", parent: "0:2", name: "Card" },
      instance("4:2", "4:0", "2:1", label("From card")),
      { id: "5:0", type: "SYMBOL", parent: "0:2", name: "Panel" },
      instance("5:1", "5:0", "4:0", { symbolData: { symbolOverrides: [override(["4:2"], label("From panel"))] } }),
      instance("1:1", "0:1", "5:0", { symbolData: { symbolOverrides: outer } }),
    ];
    assert.equal(texts(nodes([])).items[0].text, "From panel");
    assert.equal(texts(nodes([override(["5:1", "4:2"], label("From page"))])).items[0].text, "From page");
  });
});

describe("scanText frame attribution", () => {
  it("names the nearest frame, skipping groups", () => {
    // A group is a FRAME with resizeToFit in the file; it must not be reported as the frame.
    const { items } = texts([
      page, ...button,
      { id: "1:1", type: "FRAME", parent: "0:1", name: "Screen" },
      { id: "1:2", type: "FRAME", parent: "1:1", name: "Group 1", resizeToFit: true },
      { id: "1:3", type: "TEXT", parent: "1:2", name: "T", textData: { characters: "Hi" } },
      instance("1:4", "1:2", "2:1"),
    ]);
    assert.deepEqual([...new Set(items.map((t) => t.frame))], ["Screen"]);
  });
});

describe("scanText reports what it cannot render", () => {
  it("counts an instance whose main component is not in the file", () => {
    const { items, unresolved } = texts([page, { id: "1:1", type: "INSTANCE", parent: "0:1", name: "Lib button", symbolData: { symbolID: guid("99:1") } }]);
    assert.deepEqual(items, []);
    assert.deepEqual(unresolved, [{
      id: "1:1", name: "Lib button", reason: "main component is not present in this file (library component with no local copy)", mainRef: "99:1",
    }]);
  });

  it("counts a missing nested component once per place it renders, addressed by path", () => {
    // Every Card on the page shows the missing button, so each one is text the reader does not get.
    const { unresolved } = texts([
      page, components,
      { id: "4:0", type: "SYMBOL", parent: "0:2", name: "Card" },
      { id: "4:1", type: "INSTANCE", parent: "4:0", name: "Lib button", symbolData: { symbolID: guid("99:1") } },
      instance("1:1", "0:1", "4:0"),
      instance("1:2", "0:1", "4:0"),
      instance("1:3", "0:1", "4:0"),
    ]);
    assert.deepEqual(unresolved.map((u) => u.id), ["1:1/4:1", "1:2/4:1", "1:3/4:1"]);
  });

  it("counts an instance the given roots reach twice only once", () => {
    // Roots can nest (a page and a frame on it), and the same gap must not be reported twice for one layer.
    const doc = figDoc([
      page,
      { id: "1:0", type: "FRAME", parent: "0:1", name: "Screen" },
      { id: "1:1", type: "INSTANCE", parent: "1:0", name: "Lib button", symbolData: { symbolID: guid("99:1") } },
    ]);
    const { unresolved } = scanText(doc, [doc.require("0:1"), doc.require("1:0")]);
    assert.deepEqual(unresolved.map((u) => u.id), ["1:1"]);
  });

  it("counts a layer tree that loops back on itself instead of dying on it", () => {
    // A parent cycle (here the component is its own child's child) is producible from parentIndex alone; before, it
    // crashed the whole scan with a RangeError, so the file's text was lost, not just this instance's.
    const { items, unresolved } = texts([
      page, components,
      { id: "4:0", type: "SYMBOL", parent: "4:1", name: "Loop" },
      { id: "4:1", type: "FRAME", parent: "4:0", name: "Inner" },
      { id: "4:2", type: "TEXT", parent: "4:1", name: "T", textData: { characters: "x" } },
      instance("1:1", "0:1", "4:0"),
    ]);
    assert.deepEqual(items.map((t) => [t.id, t.text]), [["1:1/4:1/4:2", "x"]]);
    assert.deepEqual(unresolved, [{ id: "1:1/4:1/4:0", name: "Loop", reason: "layer tree loops back on itself (corrupt file)", component: "Loop" }]);
  });

  it("stops at the nesting limit instead of recursing forever", () => {
    // A component that contains an instance of itself.
    const { items, unresolved } = texts([
      page, components,
      { id: "4:0", type: "SYMBOL", parent: "0:2", name: "Loop" },
      { id: "4:1", type: "TEXT", parent: "4:0", name: "T", textData: { characters: "x" } },
      instance("4:2", "4:0", "4:0"),
      instance("1:1", "0:1", "4:0"),
    ]);
    assert.equal(items.length, 7);
    assert.equal(unresolved.length, 1);
    assert.match(unresolved[0].reason, /nested more than 6 instances deep/);
    assert.equal(unresolved[0].component, "Loop");
  });
});

describe("groupUnresolved", () => {
  const missing = (id: string, main: string, name = "Lib button"): TestNode =>
    ({ id, type: "INSTANCE", parent: "0:1", name, symbolData: { symbolID: guid(main) } });

  it("lists a component repeated through a card once, with the number of places and some of them", () => {
    const { unresolved } = texts([
      page, components,
      { id: "4:0", type: "SYMBOL", parent: "0:2", name: "Card" },
      { id: "4:1", type: "INSTANCE", parent: "4:0", name: "Lib button", symbolData: { symbolID: guid("99:1") } },
      ...["1:1", "1:2", "1:3"].map((id) => instance(id, "0:1", "4:0")),
    ]);
    assert.deepEqual(groupUnresolved(unresolved, 2), [{
      name: "Lib button", reason: "main component is not present in this file (library component with no local copy)",
      count: 3, ids: ["1:1/4:1", "1:2/4:1"],
    }]);
  });

  it("keeps one component missing for two reasons apart, since each needs a different thing to fix it", () => {
    // Both rows show the same absent library icon, but one of them cannot even be asked which icon it shows: its
    // swap property is bound to a library variable this file has no copy of. Reported as one group, the reader is
    // told to import a component when half those gaps would still be blank afterwards.
    const rows: TestNode[] = [
      components,
      {
        id: "4:0", type: "SYMBOL", parent: "0:2", name: "Row",
        componentPropDefs: [{ id: guid("3:1"), name: "Icon", type: "INSTANCE_SWAP" }],
      },
      {
        id: "4:1", type: "INSTANCE", parent: "4:0", name: "Icon", symbolData: { symbolID: guid("99:1") },
        componentPropRefs: [{ componentPropNodeField: "OVERRIDDEN_SYMBOL_ID", defID: guid("3:1") }],
      },
    ];
    const bound = { componentPropAssignments: [{ defID: guid("3:1"), value: {}, varValue: { value: { alias: { assetRef: { key: "lib-var" } } } } }] };
    const { unresolved } = texts([page, ...rows, instance("1:1", "0:1", "4:0"), instance("1:2", "0:1", "4:0", bound)]);
    assert.deepEqual(groupUnresolved(unresolved).map((g) => [g.reason, g.count]), [
      ["main component is not present in this file (library component with no local copy)", 1],
      ["instance-swap property bound to a variable that is not in this file (library variable with no local copy)", 1],
    ]);
  });

  it("groups instances of the same missing component whatever their layer names, most places first", () => {
    const { unresolved } = texts([
      page,
      missing("1:1", "99:1", "Avatar"),
      missing("1:2", "99:2", "Primary"),
      missing("1:3", "99:2", "Secondary"),
      { id: "1:4", type: "INSTANCE", parent: "0:1", name: "Chip", sharedSymbolReference: { componentKey: "chip-key" } },
    ]);
    assert.equal(unresolved.length, 4);
    assert.deepEqual(groupUnresolved(unresolved).map((g) => [g.name, g.count, g.ids]), [
      ["Primary", 2, ["1:2", "1:3"]],
      ["Avatar", 1, ["1:1"]],
      ["Chip", 1, ["1:4"]],
    ]);
  });
});
