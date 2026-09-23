// Run every decoding path over real .fig files that cannot be committed, check invariants, and compare against a
// saved baseline. Prints counts only, never design content, so the output can be shared.
// Usage: node scripts/corpus.ts [--save baseline.json] [--compare baseline.json] <file.fig | dir>...
//   A dir is searched like FIGMA_FILES_DIRS (two levels); FIGMA_CORPUS_DIR is used when no path is given.
//   Snapshots exported by the server are under ~/.cache/figma-reader/accounts/<account>/.
// Exit code 1 when an invariant fails or a path throws.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { componentUsage, componentUses } from "../src/component-usage.ts";
import { currentCopy, FigDocument, guidId, type FigNode, type Raw } from "../src/fig-file.ts";
import { keyPath, layerKey, mainOf, scanText } from "../src/instance-text.ts";
import { localFigFiles } from "../src/local-files.ts";
import { Normalizer } from "../src/normalize.ts";
import { outline } from "../src/outline.ts";
import { tokenUsage, typographyKey } from "../src/token-usage.ts";
import { extractStyles, extractVariables, stylesToCss, variablesToCss, variablesToDtcg } from "../src/tokens.ts";

type Counts = Record<string, number>;
interface Report {
  file: string;
  counts: Counts;
  ms: Counts;
  failures: string[];
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const save = flag("--save");
const compare = flag("--compare");
const inputs = args.length ? args : process.env.FIGMA_CORPUS_DIR ? [process.env.FIGMA_CORPUS_DIR] : [];
if (!inputs.length) {
  console.error("usage: node scripts/corpus.ts [--save f.json] [--compare f.json] <file.fig | dir>...  (or set FIGMA_CORPUS_DIR)");
  process.exit(2);
}
const files = inputs.flatMap((p) => (statSync(p).isDirectory() ? localFigFiles([p]).map((f) => f.path as string) : [p]));

/**
 * Compare instance text against what Figma itself last rendered. Each collapsed instance on the canvas stores
 * derivedSymbolData: per layer, addressed by override-key path like symbolOverrides, the laid-out text, whose last
 * baseline ends at the layer's character count (in code points). It agreed with every screenshot-checked layer, so
 * a length that differs is a wrong string. Hidden layers are included: Figma lays them out too.
 */
function figmaTextLengths(doc: FigDocument): Counts {
  const scan = scanText(doc, doc.pages(), true);
  // Our ids are node-id paths; guidPaths hold one override key per instance level plus the layer's own. Both sides
  // are keyed the way scanText keys them, so the two id spaces a guidPath mixes stay apart here too.
  const chainOf = <T>(path: string[], of: (n: FigNode) => T) =>
    path.map((id) => doc.get(id)).filter((n, i) => n && (n.type === "INSTANCE" || i === path.length - 1)).map((n) => of(n!));
  const keysOf = (path: string[]) => chainOf(path, layerKey).join("/");
  const ours = new Map<string, Map<string, string>>();
  // The same chains as node ids: what the layer is, rather than what it is addressed by. Used to read Figma's
  // guidPaths back without going through the keys, below.
  const rendered = new Map<string, string[][]>();
  for (const t of scan.items) {
    const [rootId, ...path] = t.id.split("/");
    if (!path.length) continue;
    const byKey = ours.get(rootId) ?? new Map<string, string>();
    byKey.set(keysOf(path), t.text);
    ours.set(rootId, byKey);
    rendered.set(rootId, [...(rendered.get(rootId) ?? []), chainOf(path, (n) => n.id)]);
  }
  // The layers one guid can name, in layerKey's two readings: any layer using it as an override key - several copies
  // of one library component share their layers' keys - or, for a layer with no key of its own, the node with that id.
  const byOverrideKey = new Map<string, FigNode[]>();
  for (const n of doc.nodes.values()) {
    const k = guidId(n.overrideKey);
    if (k) byOverrideKey.set(k, [...(byOverrideKey.get(k) ?? []), n]);
  }
  const layersNamed = (id: string) => {
    const keyed = byOverrideKey.get(id) ?? [];
    const node = doc.get(id);
    return node && !node.overrideKey ? [...keyed, node] : keyed;
  };
  /** The component a layer belongs to, which is what an instance renders one of. */
  const componentOf = (n: FigNode) => {
    for (const a of doc.ancestry(n)) if (a.type === "SYMBOL") return a.id;
    return undefined;
  };
  /**
   * Whether this instance still renders the layer a guidPath names. derivedSymbolData is Figma's last layout and is
   * not pruned: it keeps entries for layers the instance used to show - another variant of the set, a component
   * swapped away, a layer since deleted - and nothing in the entry marks them apart. Read the path as the layers it
   * names rather than as the keys it is written in, and ask which component each one belongs to: a collapsed instance
   * renders its own main component, so a first guid naming a layer of any other component names a layer this instance
   * no longer shows. Deeper levels render whatever an override or a swap property put there, which is the walk's
   * business and not something to repeat here, so they are read off the text we did answer for under the same chain
   * of instances. Where we answered nothing under that chain, this cannot tell, and says so.
   */
  const rendersLayer = (rootId: string, main: FigNode | undefined, guids: any[]) => {
    if (!guids.length || !main) return false;
    if (!layersNamed(guidId(guids[0]) ?? "").some((n) => componentOf(n) === main.id)) return false;
    if (guids.length === 1) return true;
    const under = (rendered.get(rootId) ?? []).filter((c) =>
      c.length === guids.length && guids.slice(0, -1).every((g, i) => layersNamed(guidId(g) ?? "").some((n) => n.id === c[i])));
    const shown = new Set(under.map((c) => componentOf(doc.get(c[c.length - 1])!)).filter((id) => id));
    return layersNamed(guidId(guids[guids.length - 1]) ?? "").some((n) => shown.has(componentOf(n)));
  };
  // Where we already say we cannot render an instance, Figma's layout of the layers inside it is a gap we reported,
  // not one we lost. Their guidPaths all start with that instance's key path ("" when the whole instance is the gap).
  const reported = new Map<string, string[]>();
  for (const u of scan.unresolved) {
    const [rootId, ...path] = u.id.split("/");
    reported.set(rootId, [...(reported.get(rootId) ?? []), keysOf(path)]);
  }
  const c = { textVsFigma: 0, textLengthMismatch: 0, textOnlyFigma: 0, textUnreported: 0 };
  for (const page of doc.pages()) {
    for (const inst of doc.walk(page)) {
      if (inst.type !== "INSTANCE" || inst.childIds.length) continue;
      const main = mainOf(doc, inst);
      for (const d of inst.derivedSymbolData ?? []) {
        if (!d.derivedTextData) continue;
        const len = Math.max(0, ...(d.derivedTextData.baselines ?? []).map((b: { endCharacter: number }) => b.endCharacter));
        const guids: any[] = d.guidPath?.guids ?? [];
        const key = keyPath(doc, main, guids);
        const text = ours.get(inst.id)?.get(key);
        // A layer Figma laid out text for that we answer nothing for. It is the shape a mis-keyed override path takes:
        // the two sides miss each other instead of disagreeing, so the length check below never sees it at all.
        if (text === undefined) {
          if (!len) continue;
          c.textOnlyFigma++;
          const gap = !(reported.get(inst.id) ?? []).some((g) => !g || key === g || key.startsWith(`${g}/`));
          if (gap && rendersLayer(inst.id, main, guids)) c.textUnreported++;
          continue;
        }
        c.textVsFigma++;
        if ([...text].length !== len) c.textLengthMismatch++;
      }
    }
  }
  return c;
}

/** Guids used as an override key by one layer and as a node id by another: what keyPath has to tell apart per level. */
function keyIdCollisions(doc: FigDocument): number {
  const keys = new Set<string>();
  for (const n of doc.nodes.values()) {
    const k = guidId(n.overrideKey);
    if (k) keys.add(k);
  }
  return [...keys].filter((k) => doc.nodes.has(k)).length;
}

/**
 * The text nodes a token-usage run has to account for, counted the way its walk sees them: a layer with visible false
 * and everything under it is out unless includeHidden. Hidden layers are a large share of a working file (1214 of
 * 7210 text nodes in one of these), so what the flag lets through is worth pinning from outside the module.
 * A node records no typography when the style read off it keys the same as no style at all, which is the split
 * textWithoutTypography has to make.
 */
function textNodeCounts(doc: FigDocument, norm: Normalizer) {
  const nothing = typographyKey({});
  const skip = new Set<string>();
  const c = { visible: 0, hidden: 0, noTypeVisible: 0, noTypeAll: 0 };
  for (const page of doc.pages()) {
    for (const n of doc.walk(page)) {
      const gone = n.visible === false || (!!n.parentId && skip.has(n.parentId));
      if (gone) skip.add(n.id);
      if (n.type !== "TEXT") continue;
      if (gone) c.hidden++;
      else c.visible++;
      if (typographyKey(norm.textStyle(n)) !== nothing) continue;
      c.noTypeAll++;
      if (!gone) c.noTypeVisible++;
    }
  }
  return c;
}

/**
 * What each live instance records, read off the raw fields rather than off the slots componentUses builds: whether it
 * is an instance of a component at all, the distinct (path, property) pairs whose value names a component, and how
 * many swap records it holds in all (instance-swap properties plus symbolOverrides). Two properties on one path set
 * to the same component are two slots and one record each, so the swaps counted for an instance are at least the
 * pairs and at most the records.
 */
function instanceSwaps(doc: FigDocument): Map<string, { direct: number; pairs: number; records: number }> {
  const out = new Map<string, { direct: number; pairs: number; records: number }>();
  const target = (ref: Raw | undefined) => {
    const n = ref ? currentCopy(doc, ref) : undefined;
    return n?.type === "SYMBOL" ? n : undefined;
  };
  for (const inst of doc.nodes.values()) {
    if (inst.type !== "INSTANCE" || inst.isSoftDeleted || doc.isSuperseded(inst)) continue;
    const pairs = new Set<string>();
    let records = 0;
    const props = (path: string, list: Raw[] | undefined) => {
      for (const a of list ?? []) {
        if (!target(a.value?.guidValue ? { guid: a.value.guidValue } : a.varValue?.value?.symbolIdValue)) continue;
        pairs.add(`${path}|${guidId(a.defID)}`);
        records++;
      }
    };
    props("", inst.componentPropAssignments);
    for (const o of inst.symbolData?.symbolOverrides ?? []) {
      if (target({ guid: o.overriddenSymbolID })) records++;
      props((o.guidPath?.guids ?? []).map(guidId).join("/"), o.componentPropAssignments);
    }
    out.set(inst.id, { direct: inst.symbolData?.symbolID && target({ guid: inst.symbolData.symbolID }) ? 1 : 0, pairs: pairs.size, records });
  }
  return out;
}

function check(path: string): Report {
  const r: Report = { file: basename(path), counts: {}, ms: {}, failures: [] };
  const step = <T>(name: string, f: () => T): T | undefined => {
    const t = performance.now();
    try {
      return f();
    } catch (e) {
      r.failures.push(`${name} threw: ${(e as Error).message}`);
      return undefined;
    } finally {
      r.ms[name] = Math.round(performance.now() - t);
    }
  };
  const fail = (ok: boolean, what: string) => {
    if (!ok) r.failures.push(what);
  };

  const doc = step("decode", () => FigDocument.fromFile(basename(path, ".fig"), path, new Date()));
  if (!doc) return r;
  r.counts.nodes = doc.nodes.size;
  r.counts.skippedNodeChanges = doc.skippedNodeChanges;
  r.counts.pages = doc.pages().length;

  step("outline", () => outline(doc, doc.get(doc.rootId)!, 2, 400));

  const scan = step("text", () => scanText(doc, doc.pages()));
  if (scan) {
    r.counts.textItems = scan.items.length;
    r.counts.textViaInstance = scan.items.filter((t) => t.via === "instance").length;
    r.counts.unresolved = scan.unresolved.length;
    fail(new Set(scan.items.map((t) => t.id)).size === scan.items.length, "text: duplicate item ids");
    // A layer can be unresolved for two different reasons; the same reason twice at one id would be a duplicate.
    const reported = scan.unresolved.map((u) => `${u.id}\0${u.reason}`);
    fail(new Set(reported).size === reported.length, "text: duplicate unresolved ids");
  }
  step("textVsFigma", () => {
    const c = figmaTextLengths(doc);
    Object.assign(r.counts, c);
    r.counts.keyIdCollisions = keyIdCollisions(doc);
    fail(c.textLengthMismatch === 0, `text: ${c.textLengthMismatch} instance layers differ in length from what Figma rendered`);
    // A layer of the component an instance renders that we neither answer for nor report as unresolved is as wrong as
    // a wrong string, and it is the only shape a mis-keyed override path takes: the two sides miss each other, so the
    // mismatch count above stays 0 through it. Layers of anything else Figma once laid out here are counted by
    // textOnlyFigma alone: see rendersLayer for why that list outlives what the instance shows.
    fail(c.textUnreported === 0, `text: ${c.textUnreported} layers of a component an instance renders are neither answered nor reported`);
  });

  const norm = new Normalizer(doc);
  step("normalize", () => {
    let nameless = 0;
    for (const n of doc.nodes.values()) {
      const out = norm.node(n, 0, n.parentId ? doc.get(n.parentId) : undefined);
      nameless += (out.component?.propertyDefinitions ?? []).filter((d: { name?: string }) => !d.name).length;
    }
    fail(nameless === 0, `normalize: ${nameless} property definitions without a name`);
  });

  step("componentUses", () => {
    const uses = [...componentUses(doc)];
    const recorded = instanceSwaps(doc);
    r.counts.componentUses = uses.length;
    r.counts.componentSwapUses = uses.filter((u) => u.swap).length;
    r.counts.componentsUsed = new Set(uses.map((u) => u.component.id)).size;
    // How much of this file the two skips have to decide about. They are 0 in every file seen so far, so the checks
    // below that rest on them say nothing about such a file until one turns up.
    r.counts.instancesGone = [...doc.nodes.values()].filter((n) => n.type === "INSTANCE" && (n.isSoftDeleted || doc.isSuperseded(n))).length;
    r.counts.supersededComponents = [...doc.nodes.values()].filter((n) => n.type === "SYMBOL" && doc.isSuperseded(n)).length;

    // A count is read as "this component is used n times", so every use has to name a component this file holds. The
    // target is followed to the current copy through byKey, which is a lookup by key and can land on anything.
    const notComponent = uses.filter((u) => doc.get(u.component.id) !== u.component || u.component.type !== "SYMBOL").length;
    fail(notComponent === 0, `component uses: ${notComponent} uses naming a node that is not a component of this file`);
    // An instance in the trash or left behind as an older copy of a library component renders nothing, and a count
    // on it is a component that looks used. The module skips both; a soft-deleted target is kept on purpose.
    const onGone = uses.filter((u) => u.instance.isSoftDeleted || doc.isSuperseded(u.instance)).length;
    fail(onGone === 0, `component uses: ${onGone} uses recorded on a soft-deleted or superseded instance`);
    // The uses of an older copy belong to the copy the file exports, or figma_get_components reports a component
    // nobody can open alongside the one they can.
    const stale = uses.filter((u) => doc.isSuperseded(u.component)).length;
    fail(stale === 0, `component uses: ${stale} uses naming a superseded copy of a component`);

    const swapsPer = new Map<string, number>();
    for (const u of uses) if (u.swap) swapsPer.set(u.instance.id, (swapsPer.get(u.instance.id) ?? 0) + 1);
    // A button with a leading and a trailing icon property set to the same icon renders it twice: the slot is the
    // property, not the component in it, and counting per component reported that icon once - which is how icons
    // look unused. Nothing may be invented either: a slot recorded twice is one use, so the count stays under the
    // records. Files seen so far record 8 to 4474 property pairs each.
    const under = [...recorded].filter(([id, rec]) => (swapsPer.get(id) ?? 0) < rec.pairs).length;
    const over = [...recorded].filter(([id, rec]) => (swapsPer.get(id) ?? 0) > rec.records).length;
    fail(under === 0, `component uses: ${under} instances counting fewer swaps than the properties they set`);
    fail(over === 0, `component uses: ${over} instances counting more swaps than they record`);
    // One instance of a component is one use of it, whatever else the instance swaps in.
    const direct = uses.filter((u) => !u.swap);
    const expected = [...recorded.values()].reduce((a, rec) => a + rec.direct, 0);
    fail(direct.length === expected, `component uses: ${expected - direct.length} instances of a component not counted once each`);
    fail(new Set(direct.map((u) => u.instance.id)).size === direct.length, "component uses: an instance counted as more than one instance");
    // What figma_get_components adds up per component has to be the same uses, not a subset keyed by something else.
    const total = [...componentUsage(doc).values()].reduce((a, u) => a + u.instances + u.swapInstances, 0);
    fail(total === uses.length, `component usage: ${uses.length - total} of ${uses.length} uses lost in the per-component totals`);
  });

  step("tokenUsage", () => {
    const shown = tokenUsage(doc, doc.pages());
    const all = tokenUsage(doc, doc.pages(), { includeHidden: true });
    const lists = (u: typeof shown) => [u.colors, u.typography, u.cornerRadii, u.gaps, u.paddings, u.strokeWidths, u.effects];
    const text = textNodeCounts(doc, norm);
    r.counts.tokenColors = shown.colors.length;
    r.counts.tokenTypography = shown.typography.length;
    r.counts.tokenValues = lists(shown).reduce((a, l) => a + l.length, 0);
    r.counts.tokenHiddenValues = lists(all).reduce((a, l) => a + l.length, 0);
    r.counts.textWithoutTypography = shown.textWithoutTypography ?? 0;

    // colorHex answers undefined for a paint that records no color, and the module asserts that away: a SOLID paint
    // without one would be reported as the string "undefined" and read as a colour in use.
    const hex = /^#[0-9A-F]{6}([0-9A-F]{2})?$/;
    const badHex = [shown, all].flatMap((u) => u.colors).filter((e) => !hex.test(String(e.value))).length;
    fail(badHex === 0, `token usage: ${badHex} colors that are not a hex value`);
    // An entry is a value someone is meant to act on, and an entry of nothing but a count describes nothing. Text
    // recording no typography at all is counted apart, in textWithoutTypography, so that this cannot happen.
    const empty = [shown, all].flatMap((u) => u.typography)
      .filter((e) => !Object.keys(e).some((k) => k !== "count" && k !== "styles" && k !== "variables")).length;
    fail(empty === 0, `token usage: ${empty} typography entries with no typography`);
    const badCount = [shown, all].flatMap(lists).flat().filter((e) => !Number.isInteger(e.count) || (e.count as number) < 1).length;
    fail(badCount === 0, `token usage: ${badCount} entries whose count is not a positive whole number`);
    // finish() lists what a Map held: two entries a reader cannot tell apart are two keys for one value.
    const dupColors = shown.colors.length - new Set(shown.colors.map((e) => String(e.value))).size;
    const dupType = shown.typography.length - new Set(shown.typography.map(typographyKey)).size;
    fail(dupColors === 0, `token usage: ${dupColors} colors reported twice`);
    fail(dupType === 0, `token usage: ${dupType} typography combos reported twice`);

    // Every text node the walk saw is one typography count or one textWithoutTypography. A run that changes a
    // typography field adds a combo of its own, so the total runs ahead of the nodes - 2385 counts for 2368 nodes in
    // one of these files - and never behind them: a node behind is a node whose typography went missing.
    const accounted = (u: typeof shown) => u.typography.reduce((a, e) => a + (e.count as number), 0) + (u.textWithoutTypography ?? 0);
    fail(accounted(shown) >= text.visible, `token usage: ${text.visible - accounted(shown)} of ${text.visible} text nodes unaccounted for`);
    fail(accounted(all) >= text.visible + text.hidden, `token usage: ${text.visible + text.hidden - accounted(all)} text nodes unaccounted for with hidden included`);
    // The two sides of that sum have to hold the right nodes, not just add up: text misfiled into the counter leaves
    // the typography list without moving either total, and the reader is told a combo is not in use.
    fail((shown.textWithoutTypography ?? 0) === text.noTypeVisible, `token usage: textWithoutTypography is ${shown.textWithoutTypography ?? 0} for ${text.noTypeVisible} text nodes that record no typography`);
    fail((all.textWithoutTypography ?? 0) === text.noTypeAll, `token usage: textWithoutTypography is ${all.textWithoutTypography ?? 0} for ${text.noTypeAll} text nodes that record no typography, hidden included`);
    // What a hidden layer uses is not what the file shows, so the default run counts a value no more often than the
    // run that includes them, and the text under hidden layers shows up only in the second. The difference is exactly
    // the hidden text in most of these files, so a single hidden layer leaking into the default run fails this.
    const colorsAll = new Map(all.colors.map((e) => [String(e.value), e.count as number]));
    const typeAll = new Map(all.typography.map((e) => [typographyKey(e), e.count as number]));
    const leaked = shown.colors.filter((e) => (colorsAll.get(String(e.value)) ?? 0) < (e.count as number)).length
      + shown.typography.filter((e) => (typeAll.get(typographyKey(e)) ?? 0) < (e.count as number)).length;
    fail(leaked === 0, `token usage: ${leaked} values counted more often with hidden layers skipped than with them included`);
    const onlyHidden = accounted(all) - accounted(shown);
    fail(onlyHidden >= text.hidden, `token usage: ${text.hidden - onlyHidden} of ${text.hidden} hidden text nodes counted in the default run`);
  });

  const cols = step("variables", () => extractVariables(doc));
  if (cols) {
    const vars = cols.flatMap((c) => c.variables);
    const values = vars.flatMap((v) => Object.values(v.values));
    r.counts.collections = cols.length;
    r.counts.variables = vars.length;
    r.counts.aliasesUnresolved = values.filter((v) => v.alias && !v.alias.startsWith("library:") && v.resolved === undefined).length;
    const css = step("variablesCss", () => variablesToCss(cols));
    if (css !== undefined) {
      const root = css.slice(0, css.indexOf("\n}"));
      // Names may hold non-ASCII letters and CSS escapes, so match up to the colon rather than a word class.
      const names = [...root.matchAll(/^ {2}(--[^\s:()]+):/gm)].map((m) => m[1]);
      fail(new Set(names).size === names.length, `variables css: ${names.length - new Set(names).size} duplicate custom properties in :root`);
      const defined = new Set([...css.matchAll(/^ {2}(--[^\s:()]+):/gm)].map((m) => m[1]));
      // Aliases to library variables the file has no copy of are written as comments, never as var().
      const dangling = [...css.matchAll(/var\((--[^\s:()]+)\)/g)].filter((m) => !defined.has(m[1])).length;
      fail(dangling === 0, `variables css: ${dangling} var() references to undefined names`);
      // A var() in :root resolves against :root: a name declared only in a [data-...] block is undefined there.
      const rootNames = new Set(names);
      const rootDangling = [...root.matchAll(/var\((--[^\s:()]+)\)/g)].filter((m) => !rootNames.has(m[1])).length;
      fail(rootDangling === 0, `variables css: ${rootDangling} var() references in :root to names declared only in a mode block`);
    }
    // A collection with no variableSetModes had no mode to write and vanished from both formats.
    fail(cols.every((c) => c.modes.length || !c.variables.length), "variables: a collection with variables has no mode");
    step("variablesDtcg", () => {
      const tree = variablesToDtcg(cols);
      const groups = Object.keys(tree).length;
      fail(groups === cols.length, `variables dtcg: ${cols.length - groups} collections merged into another`);
      // Every {a.b.c} reference must name a token, looked up from the root as DTCG tools do.
      let refs = 0, broken = 0;
      const visit = (node: Record<string, any>) => {
        for (const v of Object.values(node)) {
          if (!v || typeof v !== "object") continue;
          const ref = typeof v.$value === "string" ? v.$value.match(/^\{(.+)\}$/) : null;
          if (ref) {
            refs++;
            const path: string[] = ref[1].split(".");
            const target = path.reduce((cur: any, part) => cur?.[part], tree);
            if (!target || !("$value" in target)) broken++;
          }
          if (!("$value" in v)) visit(v);
        }
      };
      visit(tree);
      r.counts.dtcgAliases = refs;
      fail(broken === 0, `variables dtcg: ${broken} of ${refs} alias references name no token`);
      // Every (variable, mode) pair with a value must be one token: assignment used to overwrite a token of the
      // same name and drop it, and the reference to the dropped one then resolved to its replacement.
      let leaves = 0;
      const count = (node: Record<string, any>) => {
        for (const v of Object.values(node)) {
          if (!v || typeof v !== "object") continue;
          if ("$type" in v) leaves++;
          else count(v);
        }
      };
      count(tree);
      const pairs = cols.reduce((n, c) => n + c.modes.reduce((m, mode) => m + c.variables.filter((v) => v.values[mode.name]).length, 0), 0);
      fail(leaves === pairs, `variables dtcg: ${pairs - leaves} of ${pairs} tokens dropped by a name collision`);
      // DTCG cannot hold a token inside a token ("space" and "space/md" both being variables).
      let nested = 0;
      const nest = (node: Record<string, any>, inToken: boolean) => {
        for (const v of Object.values(node)) {
          if (!v || typeof v !== "object") continue;
          const isToken = "$type" in v;
          if (isToken && inToken) nested++;
          nest(v, inToken || isToken);
        }
      };
      nest(tree, false);
      fail(nested === 0, `variables dtcg: ${nested} tokens nested inside another token`);
    });
  }
  const styles = step("styles", () => extractStyles(doc));
  if (styles) {
    r.counts.styles = styles.length;
    step("stylesCss", () => stylesToCss(styles));
  }
  return r;
}

const reports = files.map((f) => {
  const r = check(f);
  const status = r.failures.length ? `FAIL (${r.failures.length})` : "ok";
  const total = Object.values(r.ms).reduce((a, b) => a + b, 0);
  console.log(`${status.padEnd(9)} ${r.file}  ${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(" ")}  ${total}ms`);
  for (const f of r.failures) console.log(`          - ${f}`);
  return r;
});

if (compare) {
  const before: Report[] = JSON.parse(readFileSync(compare, "utf8"));
  console.log(`\nChanges against ${compare}:`);
  let changed = 0;
  for (const r of reports) {
    const b = before.find((x) => x.file === r.file);
    if (!b) {
      console.log(`  ${r.file}: not in baseline`);
      continue;
    }
    for (const k of new Set([...Object.keys(b.counts), ...Object.keys(r.counts)])) {
      if (b.counts[k] === r.counts[k]) continue;
      changed++;
      const d = (r.counts[k] ?? 0) - (b.counts[k] ?? 0);
      console.log(`  ${r.file}: ${k} ${b.counts[k] ?? "-"} -> ${r.counts[k] ?? "-"} (${d > 0 ? "+" : ""}${d})`);
    }
  }
  if (!changed) console.log("  no count changed");
}
if (save) {
  writeFileSync(save, `${JSON.stringify(reports, null, 1)}\n`);
  console.log(`\nbaseline saved to ${save}`);
}
process.exit(reports.some((r) => r.failures.length) ? 1 : 0);
