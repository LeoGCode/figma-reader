// Resolve the text that actually renders inside component instances.
//
// A .fig stores an instance either expanded (its children are real nodes) or collapsed
// (childIds empty), in which case it renders the main component's subtree with per-node
// overrides. Walking the raw tree therefore misses every string inside a collapsed
// instance - in a typical product file that is the buttons, inputs, links and list rows,
// i.e. most of the text a reader needs. Whatever cannot be resolved is counted, never
// silently dropped: a plausible-looking partial answer is worse than an incomplete one.
import { guidId, type FigDocument, type FigNode, type Raw } from "./fig-file.ts";
import { displayType, propValue, propValueOf, type PropValue } from "./normalize.ts";

/** Instances nested deeper than this are reported as unresolved instead of walked. */
const MAX_INSTANCE_DEPTH = 6;

export interface TextHit {
  /** Real node id, or "<instance id>/<path inside the main component>" for resolved instance text. */
  id: string;
  name: string;
  text: string;
  /** "instance": rendered through a component instance, so not directly editable on the canvas. */
  via: "direct" | "instance";
  /** Main component of the nearest enclosing instance. */
  component?: string;
  /** Variant of that component, e.g. "Size=Large, State=Hover". */
  variant?: string;
  /** Nearest enclosing frame/component in the real tree. */
  frame?: string;
}

export interface Unresolved {
  /** Like TextHit.id: the instance's real id, or its path through the enclosing instances when nested. */
  id: string;
  name: string;
  reason: string;
  component?: string;
  /** The main component it points at (local id, else library key): the same value means the same component. */
  mainRef?: string;
}

export interface TextScan {
  items: TextHit[];
  /** Instances whose content could not be resolved; their text is absent from items. */
  unresolved: Unresolved[];
}

const mainRefOf = (inst: FigNode): string | undefined =>
  guidId(inst.symbolData?.symbolID) ?? inst.sharedSymbolReference?.componentKey;

/** What an instance's main-component reference names, which is not always a component: see mainOf. */
function referencedMain(doc: FigDocument, inst: FigNode): FigNode | undefined {
  return (
    doc.resolveRef(inst.symbolData?.symbolID ? { guid: inst.symbolData.symbolID } : undefined) ??
    (inst.sharedSymbolReference?.componentKey ? doc.byKey.get(inst.sharedSymbolReference.componentKey) : undefined)
  );
}

/** "Size=Large, State=Hover" as the pairs a variant is chosen by. */
function variantPairs(name: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of name.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

/** The variant of a set an instance shows, by its variant property values; none unless exactly one matches. */
function variantShown(doc: FigDocument, set: FigNode, inst: FigNode): FigNode | undefined {
  const variants = doc.children(set).filter((c) => c.type === "SYMBOL");
  // Only an axis of the set's variant names picks a variant. A set's other properties (a text or a boolean one) name
  // nothing in any variant's name, so wanting one of those would match no variant at all.
  const axes = new Set(variants.flatMap((c) => [...variantPairs(c.name).keys()]));
  const names = new Map<string, string>();
  const want = new Map<string, string>();
  // An axis the instance does not assign shows the set's declared default, which is what properties() reads below.
  // Without it, a set with two axes and an instance assigning one of them matched two variants, and the whole of
  // that instance's text was reported as unresolved although Figma had no doubt which variant it renders.
  for (const d of set.componentPropDefs ?? []) {
    if (!d.name) continue;
    names.set(guidId(d.id)!, d.name);
    const value = propValue(d.initialValue, d.varValue, doc);
    if (axes.has(d.name) && typeof value === "string") want.set(d.name, value);
  }
  for (const a of inst.componentPropAssignments ?? []) {
    const name = names.get(guidId(a.defID)!);
    const value = propValue(a.value, a.varValue, doc);
    if (name && axes.has(name) && typeof value === "string") want.set(name, value);
  }
  const shown = variants.filter((c) => [...want].every(([k, v]) => variantPairs(c.name).get(k) === v));
  return shown.length === 1 ? shown[0] : undefined;
}

/**
 * The component an instance renders. sharedSymbolReference.componentKey can name a state group rather than a variant:
 * a published component later combined into a variant set keeps its key on the set. A set renders nothing of its own,
 * so the instance's variant assignment picks the single variant it shows; walking the set instead would emit every
 * variant's text as if one instance showed them all, under the set's name.
 */
export function mainOf(doc: FigDocument, inst: FigNode): FigNode | undefined {
  const main = referencedMain(doc, inst);
  return main?.isStateGroup ? variantShown(doc, main, inst) : main;
}

/** A collapsed instance renders its main component; an expanded one renders its own children. */
const isCollapsed = (n: FigNode) => n.type === "INSTANCE" && n.childIds.length === 0;

/**
 * How symbolOverrides address a layer: its overrideKey when it has one, else its id. Components copied from
 * a library get new ids but keep their override keys, and every override on their instances uses the keys.
 *
 * Both id spaces occur in one file - in the committed real export every component is locally authored and carries no
 * override key at all, so its guidPaths are node ids like "2:5" - and nothing keeps one layer's override key from
 * reading like another layer's id. Ids are therefore namespaced apart, so an override reaches the layer whose own
 * space the guid was written in; keyPath decides which space that is. Exported because the corpus oracle pairs our
 * layers with Figma's guidPaths by these keys.
 */
export const layerKey = (n: FigNode) => guidId(n.overrideKey) ?? `#${n.id}`;

const keysInUse = new WeakMap<FigDocument, Set<string>>();

/** The reading for a guid no layer at its own level claims: an override key when any layer in the file uses it as one. */
function anyLayerKey(doc: FigDocument, id: string): string {
  let keys = keysInUse.get(doc);
  if (!keys) {
    keys = new Set<string>();
    for (const n of doc.nodes.values()) {
      const k = guidId(n.overrideKey);
      if (k) keys.add(k);
    }
    keysInUse.set(doc, keys);
  }
  return keys.has(id) ? id : `#${id}`;
}

const layersByMain = new WeakMap<FigDocument, Map<string, FigNode[]>>();

/** The layers one instance's overrides address: its main component's subtree, stopping at the instances inside it. */
function layersOf(doc: FigDocument, main: FigNode): FigNode[] {
  let cached = layersByMain.get(doc);
  if (!cached) layersByMain.set(doc, (cached = new Map()));
  let layers = cached.get(main.id);
  if (!layers) {
    layers = [];
    // A parent cycle would otherwise walk forever, as it would in the expansion this mirrors.
    const seen = new Set<string>([main.id]);
    const stack = [...doc.children(main)];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      layers.push(n);
      // A collapsed instance holds no children to walk: isCollapsed is childIds.length === 0, which is what
      // children() maps, so it needs no guard of its own here.
      stack.push(...doc.children(n));
    }
    cached.set(main.id, layers);
  }
  return layers;
}

/**
 * A guidPath read as the key path the walk builds for the layer it names: one guid per enclosing instance, then the
 * layer's own. Each guid is an override key or a node id, and nothing keeps one layer's key from reading like
 * another's id, so which one it is is decided where the layer sits. Among the layers the path reaches at that level a
 * keyed match wins, and a guid is read as a node id only for a layer that has no key of its own, which is how
 * layerKey writes those two apart.
 *
 * Deciding it once for the whole document instead - "is this string any layer's override key?" - dropped the override
 * on a keyless layer as soon as any other component used that id as its override key, including a library component
 * nobody had instantiated: the override was stored under one reading and looked up under the other, and the instance
 * silently rendered the component's default in place of the designer's edit.
 */
export function keyPath(doc: FigDocument, main: FigNode | undefined, guids: any[]): string {
  const parts: string[] = [];
  let level = main;
  for (const [i, g] of guids.entries()) {
    const id = guidId(g) ?? "";
    const layers = level ? layersOf(doc, level) : [];
    const node = layers.find((n) => guidId(n.overrideKey) === id) ?? layers.find((n) => !n.overrideKey && n.id === id);
    // A path this file cannot follow (into a component it does not have) keeps the document-wide reading: nothing
    // matches it either way, and that is what every path was read as before.
    parts.push(node ? layerKey(node) : anyLayerKey(doc, id));
    level = node && i + 1 < guids.length ? mainOf(doc, node) : undefined;
  }
  return parts.join("/");
}

const join = (prefix: string, part: string) => (prefix ? `${prefix}/${part}` : part);

interface Layer {
  /** Override-key path of the instance that owns these overrides, in the outermost instance's coordinates. */
  prefix: string;
  overrides: Map<string, Raw>;
}

/**
 * Property values set on one instance level. Levels count outwards from the instance being rendered: 0 is the
 * instance itself (its own overrides and assignments), 1 the instance enclosing it, and so on.
 */
interface Assigned {
  level: number;
  values: Raw[];
}

/** What the override layers covering one node say about it. */
interface Override {
  text?: string;
  /** Level of the override that set text. */
  textLevel?: number;
  visible?: boolean;
  /** Main component swapped in on an enclosing instance. */
  swap?: string;
  /** Property assignments for a nested instance, set on enclosing instances; innermost first. */
  assignments?: Assigned[];
}

/** What enclosing instances decided for a nested one. */
interface Enclosing {
  swap?: string;
  /** Levels as seen from the enclosing instance. */
  assignments?: Assigned[];
}

/** A component property's value for one rendering, and the level it was assigned at (none for a default). */
interface Props {
  value(ref: Raw): unknown;
  level(ref: Raw): number | undefined;
  /** Why the value that applies here could not be read, when it could not: reporting beats rendering the default. */
  reason(ref: Raw): string | undefined;
}

/**
 * The live binding of one of a node's fields to a component property, if any. Usually a componentPropRef; some
 * layers carry the binding only as a PROP_REF entry in their parameterConsumptionMap.
 */
function boundRef(n: FigNode, field: string): Raw | undefined {
  const ref = (n.componentPropRefs ?? []).find((r: Raw) => r.componentPropNodeField === field && !r.isDeleted);
  if (ref) return ref;
  const e = (n.parameterConsumptionMap?.entries ?? []).find((e: Raw) => e.variableField === field && e.variableData?.value?.propRefValue?.defId);
  return e && { defID: e.variableData.value.propRefValue.defId };
}

interface Origin {
  component?: string;
  variant?: string;
  frame?: string;
}

class TextScanner {
  readonly items: TextHit[] = [];
  readonly unresolved: Unresolved[] = [];
  private seen = new Set<string>();
  private defParents?: Map<string, string>;

  private doc: FigDocument;
  private includeHidden: boolean;

  constructor(doc: FigDocument, includeHidden: boolean) {
    this.doc = doc;
    this.includeHidden = includeHidden;
  }

  /** Walk the real tree, expanding every collapsed instance on the way. */
  scan(root: FigNode) {
    const hidden = new Set<string>();
    for (const n of this.doc.walk(root)) {
      if (!this.includeHidden && (n.visible === false || (n.parentId && hidden.has(n.parentId)))) {
        hidden.add(n.id);
        continue;
      }
      if (n.type === "TEXT") {
        if (!n.textData?.characters) continue;
        const origin = this.originOf(n);
        this.push({ id: n.id, name: n.name, text: n.textData.characters, via: origin.component ? "instance" : "direct", ...origin });
      } else if (isCollapsed(n)) {
        this.expand(n, n.id, "", "", [], 0, { frame: this.originOf(n).frame });
      }
    }
  }

  /** Component/variant of the nearest instance ancestor and the nearest enclosing frame. */
  private originOf(n: FigNode): Origin {
    const out: Origin = {};
    for (let cur = n.parentId ? this.doc.get(n.parentId) : undefined; cur; cur = cur.parentId ? this.doc.get(cur.parentId) : undefined) {
      if (!out.component && cur.type === "INSTANCE") {
        const main = mainOf(this.doc, cur);
        out.component = this.componentName(main) ?? cur.name;
        out.variant = this.variantOf(main);
      }
      if (!out.frame && ["FRAME", "COMPONENT", "COMPONENT_SET"].includes(displayType(cur))) out.frame = cur.name;
      if (cur.type === "CANVAS") break;
    }
    return out;
  }

  private componentName(main: FigNode | undefined): string | undefined {
    if (!main) return undefined;
    const set = main.parentId ? this.doc.get(main.parentId) : undefined;
    return set?.isStateGroup ? set.name : main.name;
  }

  private variantOf(main: FigNode | undefined): string | undefined {
    const set = main?.parentId ? this.doc.get(main.parentId) : undefined;
    return set?.isStateGroup ? main!.name : undefined;
  }

  /**
   * Render one collapsed instance: walk the main component's subtree, applying this
   * instance's overrides and component property values.
   *
   * `path` is the node's position inside the outermost instance as node ids, which is how
   * results are addressed. symbolOverrides address it differently (guidPath): one override
   * key per enclosing instance, then the node's own key, with no entries for the frames and
   * groups in between. `keyPrefix` is that chain for this instance. Nested instances add a
   * layer keyed on their own chain, so an override set on the outer instance still reaches
   * nodes inside the inner one.
   * `from` carries what the enclosing instances decided for this one: a swapped-in main
   * component and property values set through their overrides.
   */
  private expand(inst: FigNode, rootId: string, prefix: string, keyPrefix: string, layers: Layer[], depth: number, origin: Origin, from: Enclosing = {}) {
    // A nested instance renders once per enclosing instance, so it is counted, and addressed, by that path.
    const at = prefix ? `${rootId}/${prefix}` : rootId;
    const main = from.swap ? this.doc.get(from.swap) : mainOf(this.doc, inst);
    if (!main) {
      if (from.swap) return this.markUnresolved(at, inst, "swapped-in component is not present in this file", undefined, from.swap);
      const set = referencedMain(this.doc, inst);
      if (set?.isStateGroup) return this.markUnresolved(at, inst, "points at a component set, and no single variant of it matches the instance", set.name);
      return this.markUnresolved(at, inst, "main component is not present in this file (library component with no local copy)");
    }
    if (depth > MAX_INSTANCE_DEPTH) return this.markUnresolved(at, inst, `nested more than ${MAX_INSTANCE_DEPTH} instances deep`, this.componentName(main));

    // One layer can have several entries: Figma writes the swap, property values, visibility and text in one and
    // layout fields in a second (overrideLevel 1), so keeping only the last dropped the first's.
    const own = new Map<string, Raw>();
    for (const o of inst.symbolData?.symbolOverrides ?? []) {
      const key = keyPath(this.doc, main, o.guidPath?.guids ?? []);
      if (key) own.set(key, { ...own.get(key), ...o });
    }
    // Innermost first; the outer instance is applied last and wins.
    const stack: Layer[] = [{ prefix: keyPrefix, overrides: own }, ...layers];
    const props = this.properties(main, [
      { level: 0, values: inst.componentPropAssignments ?? [] },
      ...(from.assignments ?? []).map((a) => ({ level: a.level + 1, values: a.values })),
    ]);
    const here: Origin = { component: this.componentName(main) ?? inst.name, variant: this.variantOf(main), frame: origin.frame };

    // A parent cycle puts the main component back inside its own subtree; without this the walk recurses until the
    // stack runs out, taking the whole file's text with it. Mirrors the guard walk and ancestry already carry.
    const seen = new Set<string>([main.id]);
    const visit = (node: FigNode, path: string) => {
      if (seen.has(node.id)) return this.markUnresolved(`${rootId}/${path}`, node, "layer tree loops back on itself (corrupt file)", here.component);
      seen.add(node.id);
      const keys = join(keyPrefix, layerKey(node));
      const ov = this.override(stack, keys);
      if (!this.includeHidden && !this.visible(node, ov, props)) return;
      if (node.type === "TEXT") {
        let text: string | undefined = node.textData?.characters;
        const ref = boundRef(node, "TEXT_DATA");
        // A text override beats the property's default and values assigned further in, but not a value assigned
        // at its own level or further out: Figma shows that assignment. Evidence: Figma's own rendered text lengths
        // in the two real cases found across twelve files; no case yet tells this apart from "assigned always wins".
        const assignedAt = ref ? props.level(ref) : undefined;
        if (ov.text !== undefined && !(assignedAt !== undefined && assignedAt >= ov.textLevel!)) text = ov.text;
        else if (ref) {
          const why = props.reason(ref);
          if (why) return this.markUnresolved(`${rootId}/${path}`, node, `text property ${why}`, here.component);
          const v = props.value(ref);
          if (typeof v === "string") text = v;
        }
        if (text) this.push({ id: `${rootId}/${path}`, name: node.name, text, via: "instance", ...here });
        return;
      }
      if (isCollapsed(node)) {
        // Which component a nested instance shows: a swap made on an enclosing instance, else this
        // instance's swap property, else its own main component.
        const ref = boundRef(node, "OVERRIDDEN_SYMBOL_ID");
        // Which component it shows is unknown, so its whole subtree is: rendering the main component's text here
        // would be a plausible answer to a question nobody asked.
        const why = ov.swap === undefined && ref ? props.reason(ref) : undefined;
        if (why) return this.markUnresolved(`${rootId}/${path}`, node, `instance-swap property ${why}`, here.component);
        const bySwapProp = ref ? props.value(ref) : undefined;
        const swap = ov.swap ?? (typeof bySwapProp === "string" && bySwapProp !== guidId(node.symbolData?.symbolID) ? bySwapProp : undefined);
        this.expand(node, rootId, path, keys, stack, depth + 1, here, { swap, assignments: ov.assignments });
        return;
      }
      for (const c of this.doc.children(node)) visit(c, join(path, c.id));
    };
    for (const c of this.doc.children(main)) visit(c, join(prefix, c.id));
  }

  /**
   * A layer bound to a boolean property shows what the property says; otherwise an override's
   * visibility, in either direction, beats the main component's.
   */
  private visible(node: FigNode, ov: Override, props: Props): boolean {
    const ref = boundRef(node, "VISIBLE");
    const bound = ref ? props.value(ref) : undefined;
    if (typeof bound === "boolean") return bound;
    return ov.visible ?? node.visible !== false;
  }

  /** Merge every override layer that covers this key path; the outermost definition wins. */
  private override(layers: Layer[], path: string): Override {
    const out: Override = {};
    for (const [level, l] of layers.entries()) {
      let key: string;
      if (!l.prefix) key = path;
      else if (path === l.prefix) key = "";
      else if (path.startsWith(`${l.prefix}/`)) key = path.slice(l.prefix.length + 1);
      else continue;
      const o = l.overrides.get(key);
      if (!o) continue;
      if (o.textData?.characters !== undefined) {
        out.text = o.textData.characters;
        out.textLevel = level;
      }
      if (o.visible !== undefined) out.visible = o.visible;
      if (o.overriddenSymbolID) out.swap = guidId(o.overriddenSymbolID);
      if (o.componentPropAssignments?.length) (out.assignments ??= []).push({ level, values: o.componentPropAssignments });
    }
    return out;
  }

  /**
   * Property values for one rendering of main: assignments (later lists, further out, win), else the component's
   * defaults. Defs are matched by their set-level id, so values carry across the variants of a set.
   */
  private properties(main: FigNode, lists: Assigned[]): Props {
    // A value that cannot be read is kept with its reason: dropping it would fall back to the component's default,
    // which renders a plausible string the instance does not show.
    const assigned = new Map<string, PropValue & { level: number }>();
    for (const { level, values } of lists) {
      for (const a of values) {
        const v = propValueOf(a.value, a.varValue, this.doc);
        if (v.value !== undefined || v.reason) assigned.set(this.canonical(guidId(a.defID)), { ...v, level });
      }
    }
    const set = main.parentId ? this.doc.get(main.parentId) : undefined;
    const defaults = new Map<string, PropValue>();
    for (const d of [...(set?.isStateGroup ? set.componentPropDefs ?? [] : []), ...(main.componentPropDefs ?? [])]) {
      const v = propValueOf(d.initialValue, d.varValue, this.doc);
      if (v.value !== undefined || v.reason) defaults.set(guidId(d.id)!, v);
    }
    const applying = (ref: Raw): PropValue | undefined => {
      const id = guidId(ref.defID);
      const key = this.canonical(id);
      return assigned.get(key) ?? defaults.get(key) ?? (id ? defaults.get(id) : undefined);
    };
    return {
      value: (ref) => applying(ref)?.value,
      level: (ref) => assigned.get(this.canonical(guidId(ref.defID)))?.level,
      reason: (ref) => applying(ref)?.reason,
    };
  }

  /** A variant's local property def id -> the set-level def it stands for (itself when it has none). */
  private canonical(id: string | undefined): string {
    if (!this.defParents) {
      this.defParents = new Map();
      for (const n of this.doc.nodes.values()) {
        for (const d of n.componentPropDefs ?? []) if (d.parentPropDefId) this.defParents.set(guidId(d.id)!, guidId(d.parentPropDefId)!);
      }
    }
    return (id && this.defParents.get(id)) ?? id ?? "";
  }

  private push(hit: TextHit) {
    this.items.push(prune(hit));
  }

  private markUnresolved(id: string, inst: FigNode, reason: string, component?: string, mainRef = mainRefOf(inst)) {
    // One layer can be missing for more than one reason; deduping on the id alone kept the first and lost the rest.
    const at = `${id}\0${reason}`;
    if (this.seen.has(at)) return;
    this.seen.add(at);
    this.unresolved.push(prune<Unresolved>({ id, name: inst.name, reason, component, mainRef }));
  }
}

function prune<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/** All text rendered under these roots, in reading order, with instances expanded. */
export function scanText(doc: FigDocument, roots: FigNode[], includeHidden = false): TextScan {
  const s = new TextScanner(doc, includeHidden);
  for (const r of roots) s.scan(r);
  return { items: s.items, unresolved: s.unresolved };
}

export interface UnresolvedGroup {
  name: string;
  component?: string;
  reason: string;
  /** Places it renders with its text missing. */
  count: number;
  /** Some of those places, as Unresolved ids. */
  ids: string[];
}

/**
 * One entry per missing component and reason, most places first. A component repeated through a list or a card
 * would otherwise fill any capped listing with copies of itself and hide the other gaps.
 */
export function groupUnresolved(list: Unresolved[], sampleIds = 5): UnresolvedGroup[] {
  const groups = new Map<string, UnresolvedGroup>();
  for (const u of list) {
    const key = `${u.reason}\0${u.mainRef ?? u.id}`;
    const g = groups.get(key) ?? prune<UnresolvedGroup>({ name: u.name, component: u.component, reason: u.reason, count: 0, ids: [] });
    g.count++;
    if (g.ids.length < sampleIds) g.ids.push(u.id);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
