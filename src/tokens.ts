// Extract variables (collections/modes/values) and local styles, and render them as JSON, CSS or DTCG tokens.
import { compareGuidIds, currentCopy, guidId, type FigDocument, type FigNode, type Raw } from "./fig-file.ts";
import { colorHex, Normalizer } from "./normalize.ts";

export interface VariableValue {
  value?: string | number | boolean;
  alias?: string;
  aliasId?: string;
  resolved?: string | number | boolean;
}

export interface Variable {
  id: string;
  name: string;
  key?: string;
  type: string;
  description?: string;
  scopes?: string[];
  codeSyntax?: Record<string, string>;
  hiddenFromPublishing?: boolean;
  remote: boolean;
  values: Record<string, VariableValue>; // by mode name (unique within the collection)
}

export interface Collection {
  id: string;
  name: string;
  key?: string;
  remote: boolean;
  modes: { id: string; name: string }[];
  defaultMode: string;
  variables: Variable[];
}

const round = (v: number) => Math.round(v * 10000) / 10000;

function rawValue(v: Raw | undefined): string | number | boolean | undefined {
  if (!v) return undefined;
  if (v.colorValue) return colorHex(v.colorValue);
  if (v.floatValue !== undefined) return round(v.floatValue);
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.textValue !== undefined) return v.textValue;
  return undefined;
}

/** Soft-deleted nodes and stale copies of a library asset (an older version kept for old instances) are not tokens. */
const gone = (doc: FigDocument, n: FigNode) => !!n.isSoftDeleted || doc.isSuperseded(n);

export function extractVariables(doc: FigDocument, includeRemote = true): Collection[] {
  const sets = new Map<string, Collection>();
  const modeNames = new Map<string, Map<string, string>>(); // setId -> modeId -> name
  for (const n of doc.nodes.values()) {
    if (n.type !== "VARIABLE_SET" || gone(doc, n)) continue;
    const sorted = [...(n.variableSetModes ?? [])].sort((a: Raw, b: Raw) => (a.sortPosition < b.sortPosition ? -1 : a.sortPosition > b.sortPosition ? 1 : 0));
    // Values are keyed by mode name, so two modes named alike would overwrite each other.
    const names = uniqueNames(sorted.map((m: Raw) => m.name ?? ""), " ");
    const modes = sorted.map((m: Raw, i) => ({ id: guidId(m.id)!, name: names[i] }));
    modeNames.set(n.id, new Map(modes.map((m) => [m.id, m.name])));
    sets.set(n.id, {
      id: n.id,
      name: n.name,
      key: n.key || undefined,
      remote: !!n.sourceLibraryKey,
      modes,
      defaultMode: modes[0]?.name ?? "default",
      variables: [],
    });
  }

  const vars = new Map<string, { v: Variable; setId: string }>();
  for (const n of doc.nodes.values()) {
    if (n.type !== "VARIABLE" || gone(doc, n)) continue;
    // Variables copied from a library name their collection by assetRef key only.
    const setId = doc.resolveRef(n.variableSetID)?.id;
    const set = setId ? sets.get(setId) : undefined;
    const names = setId ? modeNames.get(setId) : undefined;
    const values: Record<string, VariableValue> = {};
    for (const e of n.variableDataValues?.entries ?? []) {
      const modeName = names?.get(guidId(e.modeID)!) ?? guidId(e.modeID)!;
      const val = e.variableData?.value;
      if (val?.alias) {
        // An alias to a stale library copy follows the key to the copy that is exported. Same helper as the
        // normalizer's, so figma_get_text and figma_get_variables cannot answer about different copies.
        const target = currentCopy(doc, val.alias);
        values[modeName] = {
          alias: target?.name ?? (val.alias.assetRef?.key ? `library:${val.alias.assetRef.key}` : guidId(val.alias.guid)),
          aliasId: target?.id,
        };
      } else values[modeName] = { value: rawValue(val) };
    }
    const codeSyntax: Record<string, string> = {};
    for (const c of n.codeSyntax?.entries ?? []) codeSyntax[c.platform] = c.value;
    const v: Variable = {
      id: n.id,
      name: n.name,
      key: n.key || undefined,
      type: n.variableResolvedType ?? "UNKNOWN",
      description: n.description || undefined,
      scopes: n.variableScopes?.length ? n.variableScopes : undefined,
      codeSyntax: Object.keys(codeSyntax).length ? codeSyntax : undefined,
      hiddenFromPublishing: n.isHiddenFromPublishing || undefined,
      remote: !!n.sourceLibraryKey || (set?.remote ?? false),
      values,
    };
    vars.set(n.id, { v, setId: setId ?? "" });
    set?.variables.push(v);
  }

  // A collection can carry no variableSetModes at all (seen on partial library copies), and a variable can hold a
  // value in a mode its collection does not list; either way the mode is known only from the values, which are keyed
  // by the raw id. Every format that walks collection.modes (CSS and DTCG) leaves out what no mode names, while
  // `format: json` reports it: a whole collection in the first case, a single value in the second.
  for (const s of sets.values()) {
    const listed = new Set(s.modes.map((m) => m.name));
    // Node order is the order the file happened to decode in, so the ids are sorted: the lowest is the default mode
    // of a collection that listed none, which decides :root and how every alias from another collection resolves.
    // Normalizer reads a modeless collection by the same rule, or the same variable reads two ways.
    const ids = [...new Set(s.variables.flatMap((v) => Object.keys(v.values)))].filter((id) => !listed.has(id)).sort(compareGuidIds);
    if (!ids.length) continue;
    s.modes = [...s.modes, ...ids.map((id) => ({ id, name: id }))];
    if (!listed.size) s.defaultMode = ids[0];
  }

  // Resolve alias chains. Within a collection an alias keeps the mode; a variable in another collection takes that
  // collection's own mode, which Figma sets per frame independently: without a frame, its default mode.
  const resolve = (fromSet: string, id: string, mode: string, seen = new Set<string>()): string | number | boolean | undefined => {
    const entry = vars.get(id);
    if (!entry || seen.has(id)) return undefined;
    seen.add(id);
    const set = sets.get(entry.setId);
    const m = entry.setId === fromSet ? mode : (set?.defaultMode ?? mode);
    const val = entry.v.values[m] ?? entry.v.values[set?.defaultMode ?? ""] ?? Object.values(entry.v.values)[0];
    if (!val) return undefined;
    if (val.aliasId) return resolve(entry.setId, val.aliasId, m, seen);
    return val.value;
  };
  for (const { v, setId } of vars.values()) {
    for (const [mode, val] of Object.entries(v.values)) {
      if (val.aliasId) val.resolved = resolve(setId, val.aliasId, mode, new Set([v.id]));
    }
  }

  const out = [...sets.values()].filter((s) => includeRemote || !s.remote);
  for (const s of out) s.variables.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export interface StyleInfo {
  id: string;
  name: string;
  type: string;
  key?: string;
  description?: string;
  remote: boolean;
  value: Raw;
}

export function extractStyles(doc: FigDocument): StyleInfo[] {
  const norm = new Normalizer(doc);
  const out: StyleInfo[] = [];
  for (const n of doc.nodes.values()) {
    // Deleted styles carry isSoftDeleted, isSoftDeletedStyle or both.
    if (!n.styleType || n.styleType === "NONE" || n.isSoftDeletedStyle || gone(doc, n)) continue;
    let value: Raw;
    switch (n.styleType) {
      case "FILL":
      case "STROKE":
        value = { paints: norm.paints(n.fillPaints) };
        break;
      case "TEXT":
        value = norm.textStyle(n);
        break;
      case "EFFECT":
        value = { effects: (n.effects ?? []).map((e: Raw) => norm.effect(e)).filter(Boolean) };
        break;
      case "GRID":
        value = {
          grids: (n.layoutGrids ?? []).map((g: Raw) => ({
            pattern: g.pattern, count: g.numSections, sectionSize: g.sectionSize, gutter: g.gutterSize, offset: g.offset, type: g.type,
          })),
        };
        break;
      default:
        value = {};
    }
    out.push({
      id: n.id,
      name: n.name,
      type: n.styleType,
      key: n.key || undefined,
      description: n.styleDescription || undefined,
      remote: !!n.sourceLibraryKey,
      value,
    });
  }
  return out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

// ---------- formatting ----------

/**
 * A lowercase, hyphenated CSS identifier. Letters outside ASCII are valid in identifiers and kept; a name with
 * nothing usable left (emoji, punctuation) takes the fallback, as "--:" or `[data-=""]` would be invalid.
 */
export const cssIdent = (name: string, fallback = "") =>
  name
    .trim()
    .replace(/[\s/.:]+/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || fallback;

const idPart = (id: string) => id.replace(/[^\w]+/g, "-");

/** A class selector: an identifier cannot start with a digit ("2xl"), so the digit is escaped. */
const classSelector = (name: string) => `.${name.replace(/^(-?)(\d)/, (_, dash, d) => `${dash}\\3${d} `)}`;

// Number variables carry no unit. Figma applies these scopes as plain numbers: weights (FONT_STYLE holds 400-700 in
// real files) and variable-font axes. Everything else, line height and letter spacing included, is bound in pixels.
const UNITLESS = new Set(["FONT_STYLE", "FONT_WEIGHT", "FONT_VARIATIONS", "OPACITY"]);

/**
 * What a FLOAT variable's number means. Opacity variables are percentages: a variable of 50 bound to a layer's
 * opacity leaves that layer at 0.5 in the file (checked on a fixture built in Figma, and on the committed real
 * export). CSS opacity takes 0-1, and DTCG carries no unit that could say 50 means anything else.
 */
const numberValue = (v: Variable, value: number) =>
  v.scopes?.length && v.scopes.every((s) => s === "OPACITY") ? round(value / 100) : value;

/**
 * A CSS string. JSON escapes are not CSS escapes: "\n" in CSS is the letter n, and a newline is "\A ". U+0000 is
 * escaped with them: CSS preprocessing replaces a raw one with U+FFFD before the parser sees it, so a value holding
 * one was silently changed by a character nothing in the sheet showed.
 */
const cssString = (s: string) =>
  `"${s.replace(/[\\"]/g, "\\$&").replace(/[\0\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16).toUpperCase()} `)}"`;

/** Text put inside a CSS comment: "*\/" in a collection or variable name would close it and leave live CSS behind. */
const commentText = (s: string) => s.replace(/\*\//g, "* /");

function cssValue(v: Variable, value: string | number | boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (v.type === "FLOAT" && typeof value === "number") {
    const scopes = v.scopes ?? [];
    const n = numberValue(v, value);
    return scopes.length && scopes.every((s) => UNITLESS.has(s)) ? String(n) : `${n}px`;
  }
  if (v.type === "STRING") return cssString(String(value));
  return String(value);
}

/**
 * The first use of a name keeps it; later ones get "-2", "-3"... A file can hold several collections with the same
 * name (partial copies from different libraries), and names can collide after cssIdent ("Primary" / "primary").
 */
export function uniqueNames(names: string[], sep = "-"): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    let out = n;
    for (let i = 2; used.has(out); i++) out = `${n}${sep}${i}`;
    used.add(out);
    return out;
  });
}

/** Which collection each variable is in, for following aliases across collections. */
function indexVariables(collections: Collection[]) {
  const index = new Map<string, { c: number; v: Variable }>();
  for (const [c, col] of collections.entries()) for (const v of col.variables) index.set(v.id, { c, v });
  return index;
}

/**
 * The mode an alias target is read in: the same mode within one collection, else the target collection's default
 * (modes are chosen per collection), as extractVariables resolves it.
 */
function targetMode(collections: Collection[], from: number, mode: string, to: { c: number; v: Variable }) {
  const target = collections[to.c];
  return to.c === from && to.v.values[mode] ? mode : target.defaultMode;
}

/**
 * CSS custom properties. Names and references are computed over all collections, and `include` picks which are
 * written, so a filtered export names everything as the full one does. An alias whose target is not written (filtered
 * out, absent from the file, or with no property of its own in that mode) gets its resolved value, or a comment when
 * there is none.
 */
export function variablesToCss(collections: Collection[], prefix = "", include: (c: Collection) => boolean = () => true): string {
  const collectionIds = uniqueNames(collections.map((c) => cssIdent(c.name, `collection-${idPart(c.id)}`)));
  const base = (v: Variable) => cssIdent(v.name, `var-${idPart(v.id)}`);
  // Names that exist in more than one collection get the collection's id prepended to stay unique.
  const seen = new Map<string, number>();
  for (const c of collections) for (const n of new Set(c.variables.map(base))) seen.set(n, (seen.get(n) ?? 0) + 1);
  const vars = collections.flatMap((c, i) =>
    c.variables.map((v) => ({ id: v.id, name: `--${prefix}${(seen.get(base(v)) ?? 0) > 1 ? `${collectionIds[i]}-` : ""}${base(v)}` })),
  );
  const unique = uniqueNames(vars.map((v) => v.name));
  const byId = new Map(vars.map((v, i) => [v.id, unique[i]]));
  const index = indexVariables(collections);

  /**
   * Which (variable, mode) pairs are written as a property at all. var() to anything else names an undefined
   * property: a target can have no value in the mode being written (normal in a partial library copy), alias out of
   * the file itself one hop further on, or hold a raw value with no field we read. An alias is written as soon as
   * its target is, so the set is grown from the values that stand on their own until it stops changing.
   */
  const written = new Set<string>();
  const pairKey = (id: string, mode: string) => `${id} ${mode}`;
  /** The property an alias may point at: its target, written in the mode extractVariables reads it in. */
  const refName = (from: number, val: VariableValue, mode: string) => {
    const target = val.aliasId ? index.get(val.aliasId) : undefined;
    if (!target || !include(collections[target.c])) return undefined;
    return written.has(pairKey(target.v.id, targetMode(collections, from, mode, target))) ? byId.get(target.v.id) : undefined;
  };
  const pairs = collections.flatMap((c, i) => c.variables.flatMap((v) => Object.entries(v.values).map(([mode, val]) => ({ i, v, mode, val }))));
  for (let changed = true; changed; ) {
    changed = false;
    for (const { i, v, mode, val } of pairs) {
      if (written.has(pairKey(v.id, mode))) continue;
      const value = val.alias ? (refName(i, val, mode) ?? cssValue(v, val.resolved)) : cssValue(v, val.value);
      if (value === undefined) continue;
      written.add(pairKey(v.id, mode));
      changed = true;
    }
  }

  /** The declaration for one variable in one mode: a property, a comment, or nothing. */
  const decl = (from: number, v: Variable, mode: string) => {
    const val = v.values[mode];
    if (!val) return undefined;
    const name = byId.get(v.id)!;
    if (val.alias) {
      const ref = refName(from, val, mode);
      if (ref) return `  ${name}: var(${ref});`;
      const resolved = cssValue(v, val.resolved);
      if (resolved !== undefined) return `  ${name}: ${resolved}; /* alias of ${commentText(val.alias)} */`;
      // A target with an id was found in the file; one absent from the index was dropped as a token (soft-deleted,
      // or in a soft-deleted collection), which is not the same as never having been here.
      const why = !val.aliasId ? "which is not in this file"
        : index.get(val.aliasId) ? "which has no value here"
        : "which this file does not export";
      return `  /* ${name}: alias of ${commentText(val.alias)}, ${why} */`;
    }
    const value = cssValue(v, val.value);
    return value === undefined ? undefined : `  ${name}: ${value};`;
  };

  const lines: string[] = [];
  const byMode = new Map<string, string[]>();
  const root: string[] = [];
  for (const [i, c] of collections.entries()) {
    if (!include(c)) continue;
    root.push(`  /* ${commentText(c.name)} (${commentText(c.defaultMode)}) */`);
    for (const v of c.variables) {
      const line = decl(i, v, c.defaultMode);
      if (line) root.push(line);
    }
    const modeIds = uniqueNames(c.modes.map((m, j) => cssIdent(m.name, `mode-${j + 1}`)));
    for (const [j, m] of c.modes.entries()) {
      if (m.name === c.defaultMode) continue;
      const block: string[] = [];
      for (const v of c.variables) {
        const line = decl(i, v, m.name);
        if (line && line !== decl(i, v, c.defaultMode)) block.push(line);
      }
      if (block.length) byMode.set(`[data-${collectionIds[i]}="${modeIds[j]}"]`, block);
    }
  }
  lines.push(":root {", ...root, "}");
  for (const [sel, block] of byMode) lines.push("", `${sel} {`, ...block, "}");
  return lines.join("\n");
}

const dtcgType: Record<string, string> = { COLOR: "color", FLOAT: "number", STRING: "string", BOOLEAN: "boolean" };
/** DTCG reserves "." (path separator), "{" "}" (references) and a leading "$" in token and group names. */
const dtcgName = (s: string) => s.trim().replace(/[.{}]/g, "_").replace(/^\$/, "_");
const dtcgPath = (name: string) => name.split("/").map(dtcgName);

/** A DTCG value: the same number CSS writes, without the unit CSS adds. */
const dtcgValue = (v: Variable, value: string | number | boolean | undefined) =>
  v.type === "FLOAT" && typeof value === "number" ? numberValue(v, value) : value;

/**
 * Where one token goes in a mode's tree, and the path it ended up at. DTCG has no way to hold a token inside a token,
 * so a name a token already took, from two variables named alike or from a variable whose name is also a group prefix
 * ("space" and "space/md"), is numbered rather than overwriting the token or grafting children onto it as plain
 * assignment did; variablesToCss numbers the property it would have redefined in the same cases.
 *
 * A group is shared by every variable whose name holds that segment and by no other, so `groups` remembers which
 * name each group in a container was made for: numbering that only dodged tokens let "space/md" join the group
 * "space-2/x" had made, where it reads as a token of a variable named "space-2/md".
 */
function place(tree: Raw, parts: string[], token: Raw, groups: WeakMap<Raw, Map<string, string>>): string[] {
  const path: string[] = [];
  let cur = tree;
  for (const p of parts.slice(0, -1)) {
    let claimed = groups.get(cur);
    if (!claimed) groups.set(cur, (claimed = new Map()));
    let name = claimed.get(p);
    if (name === undefined) {
      name = p;
      for (let i = 2; cur[name] !== undefined; i++) name = `${p}-${i}`;
      claimed.set(p, name);
    }
    cur = cur[name] ??= {};
    path.push(name);
  }
  const leaf = parts[parts.length - 1];
  let name = leaf;
  for (let i = 2; cur[name] !== undefined; i++) name = `${leaf}-${i}`;
  cur[name] = token;
  path.push(name);
  return path;
}

/**
 * W3C design tokens nested as <collection>.<mode>.<path>. An alias references its target by that full path, in the
 * mode extractVariables resolves it in, and only when that token carries a $value of its own: DTCG has no undefined
 * reference to fall back on. `include` works as in variablesToCss; an alias whose target is not written keeps its
 * resolved value, and one whose target has no value at all is left as a group holding the alias under $extensions,
 * a token being an object with a $value.
 */
export function variablesToDtcg(collections: Collection[], include: (c: Collection) => boolean = () => true): Raw {
  const root: Raw = {};
  const groupNames = uniqueNames(collections.map((c) => dtcgName(c.name)), " ");
  /** Per container, the group each variable-name segment was given, so no two segments share one. */
  const groups = new WeakMap<Raw, Map<string, string>>();
  const index = indexVariables(collections);
  // Every token written, by variable and mode: the path a reference must name once uniquing has had its say.
  const written = new Map<string, { path: string[]; token: Raw }>();
  const tokens: { c: number; v: Variable; mode: string; val: VariableValue; token: Raw }[] = [];
  for (const [i, c] of collections.entries()) {
    if (!include(c)) continue;
    const group: Raw = (root[groupNames[i]] ??= {});
    // Mode names collide after mangling as collection names do ("v1.0" and "v1_0"), and a collision dropped a mode.
    const modeNames = uniqueNames(c.modes.map((m) => dtcgName(m.name)), " ");
    for (const [j, m] of c.modes.entries()) {
      const tree: Raw = (group[modeNames[j]] = {});
      for (const v of c.variables) {
        const val = v.values[m.name];
        if (!val) continue;
        const token: Raw = { $type: dtcgType[v.type] ?? v.type.toLowerCase() };
        const path = place(tree, dtcgPath(v.name), token, groups);
        written.set(`${v.id} ${m.name}`, { path: [groupNames[i], modeNames[j], ...path], token });
        tokens.push({ c: i, v, mode: m.name, val, token });
      }
    }
  }

  for (const t of tokens) {
    if (t.val.alias) continue;
    const value = dtcgValue(t.v, t.val.value);
    if (value !== undefined) t.token.$value = value;
  }
  // An alias references its target only once that target has a $value, so references are filled in until nothing
  // more resolves; what is left keeps the value extractVariables resolved, or has none.
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of tokens) {
      if (!t.val.alias || t.token.$value !== undefined) continue;
      const target = t.val.aliasId ? index.get(t.val.aliasId) : undefined;
      const to = target && include(collections[target.c]) ? written.get(`${target.v.id} ${targetMode(collections, t.c, t.mode, target)}`) : undefined;
      if (to?.token.$value === undefined) continue;
      t.token.$value = `{${to.path.join(".")}}`;
      changed = true;
    }
  }
  for (const t of tokens) {
    if (!t.val.alias || t.token.$value !== undefined) continue;
    const resolved = dtcgValue(t.v, t.val.resolved);
    if (resolved !== undefined) t.token.$value = resolved;
    t.token.$extensions = { "com.figma": { aliasOf: t.val.alias } };
  }
  // A token is an object with a $value, and a group is one without; $type and no $value is neither, and consumers
  // split between dropping such a node and erroring on it (an alias cycle left three of them, a raw value in no field
  // we read one more). What has no value is left as the group it is, saying what it can: the alias it came from.
  for (const t of tokens) if (t.token.$value === undefined) delete t.token.$type;
  for (const t of tokens) if (t.v.description) t.token.$description = t.v.description;
  return root;
}

// ---------- style CSS ----------

/**
 * "#RRGGBB[AA]" with a paint's opacity folded into its alpha. An opacity of 1 returns the string untouched: for
 * anything colorHex itself wrote the round trip gives the same string back (each byte is b/255 and back, and an
 * omitted alpha byte reads as 1 and is omitted again), so that branch is speed rather than behaviour.
 */
function withOpacity(hex: string, opacity: number | undefined): string {
  if (opacity === undefined || opacity >= 1) return hex;
  return colorHex(parseHex(hex), opacity)!;
}

function parseHex(hex: string) {
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return { r: n(1), g: n(3), b: n(5), a: hex.length > 7 ? n(7) : 1 };
}

/** Solid fills stacked with normal blending are one color: composite them bottom (first) to top ("over" operator). */
function compositeSolids(paints: Raw[]): string {
  let acc = { r: 0, g: 0, b: 0, a: 0 };
  for (const p of paints) {
    const c = parseHex(p.color);
    const a = c.a * (p.opacity ?? 1);
    const out = a + acc.a * (1 - a);
    const mix = (x: number, y: number) => (out ? (x * a + y * acc.a * (1 - a)) / out : 0);
    acc = { r: mix(c.r, acc.r), g: mix(c.g, acc.g), b: mix(c.b, acc.b), a: out };
  }
  return colorHex(acc)!;
}

/**
 * Where a gradient's handles sit in the layer's unit square. Figma stores the transform from layer space to gradient
 * space, where a linear gradient runs from (0, 0.5) to (1, 0.5) and a radial one is centered at (0.5, 0.5) with
 * radius 0.5; the inverse maps those points back onto the layer.
 */
function gradientPoints(transform: number[][] | undefined) {
  const [[a, b, c], [d, e, f]] = transform ?? [[1, 0, 0], [0, 1, 0]];
  const det = a * e - b * d || 1;
  const at = (x: number, y: number) => {
    const u = x - c, w = y - f;
    return [(e * u - b * w) / det, (a * w - d * u) / det];
  };
  return { start: at(0, 0.5), end: at(1, 0.5), center: at(0.5, 0.5), edge: at(0.5, 1) };
}

/** CSS angles run clockwise from "to top"; y grows downwards. */
const cssAngle = (from: number[], to: number[]) => {
  const deg = Math.round((Math.atan2(to[0] - from[0], from[1] - to[1]) * 180) / Math.PI);
  return (deg + 360) % 360;
};
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/**
 * One fill as a CSS image, or undefined when CSS has no equivalent. Positions are in the unit square, so on a
 * non-square layer a rotated gradient's angle is approximate.
 */
function paintImage(p: Raw): string | undefined {
  const stops = () => (p.stops ?? []).map((st: Raw) => `${withOpacity(st.color, p.opacity)} ${Math.round(st.position * 100)}%`).join(", ");
  const g = gradientPoints(p.transform);
  const dist = (q: number[]) => Math.hypot(q[0] - g.center[0], q[1] - g.center[1]);
  switch (p.type) {
    case "SOLID": {
      const c = withOpacity(p.color, p.opacity);
      return `linear-gradient(${c}, ${c})`;
    }
    case "GRADIENT_LINEAR":
      // Figma's untransformed gradient runs left to right (90deg); CSS defaults to top to bottom.
      return `linear-gradient(${cssAngle(g.start, g.end)}deg, ${stops()})`;
    case "GRADIENT_RADIAL":
      return `radial-gradient(${pct(dist(g.end))} ${pct(dist(g.edge))} at ${pct(g.center[0])} ${pct(g.center[1])}, ${stops()})`;
    case "GRADIENT_ANGULAR":
      // Figma sweeps clockwise from the handle at (1, 0.5), CSS from "to top".
      return `conic-gradient(from ${cssAngle(g.center, g.end)}deg at ${pct(g.center[0])} ${pct(g.center[1])}, ${stops()})`;
    default:
      return undefined; // GRADIENT_DIAMOND, IMAGE, ...
  }
}

/** A fill style as a custom property value: a color when it is one, else background layers (top first). */
function fillValue(paints: Raw[]): { value?: string; note?: string } {
  if (!paints.length) return { note: "no visible fill" };
  if (paints.every((p) => p.type === "SOLID" && !p.blendMode)) {
    if (paints.length === 1) return { value: withOpacity(paints[0].color, paints[0].opacity) };
    return { value: compositeSolids(paints), note: `${paints.length} solid fills composited` };
  }
  if (paints.length === 1 && paints[0].type !== "SOLID") {
    const image = paintImage(paints[0]);
    return image ? { value: image } : { note: `${paints[0].type} fill has no CSS equivalent` };
  }
  const layers = [...paints].reverse().map(paintImage);
  const missing = paints.find((p, i) => !layers[paints.length - 1 - i]);
  if (missing) return { note: `${missing.type} fill has no CSS equivalent` };
  const blends = paints.filter((p) => p.blendMode).map((p) => p.blendMode);
  return { value: layers.join(", "), note: blends.length ? `blend modes not applied: ${blends.join(", ")}` : undefined };
}

export function stylesToCss(styles: StyleInfo[], prefix = ""): string {
  const ident = (s: StyleInfo) => cssIdent(s.name, `style-${idPart(s.id)}`);
  // A STROKE style holds paints in the same field a FILL style does, and a border color is as much a custom property
  // as a fill; extractStyles read them and this dropped them without a word.
  const varStyles = styles.filter((s) => s.type === "FILL" || s.type === "STROKE" || s.type === "EFFECT");
  const textStyles = styles.filter((s) => s.type === "TEXT");
  // Library copies and local styles often share names ("White" twice): number them rather than redefine one.
  const varNames = uniqueNames(varStyles.map((s) => `--${prefix}${ident(s)}`));
  const classNames = uniqueNames(textStyles.map((s) => `${prefix}${ident(s)}`));

  const vars: string[] = [];
  for (const [i, s] of varStyles.entries()) {
    const name = varNames[i];
    // Numbering runs across fill, stroke and effect styles at once, so a numbered name no longer says which style it
    // came from: "--brand-2" is the style "Brand" as soon as an effect style of that name was written first. Nothing
    // else groups these properties by source, as variablesToCss's per-collection comments do.
    const from = name === `--${prefix}${ident(s)}` ? undefined : `${commentText(s.name)} (${s.type})`;
    if (s.type !== "EFFECT") {
      const { value, note } = fillValue(s.value.paints ?? []);
      const why = [from, note && commentText(note)].filter(Boolean).join("; ");
      if (value) vars.push(`  ${name}: ${value};${why ? ` /* ${why} */` : ""}`);
      else vars.push(`  /* ${name}: ${why} */`);
    } else {
      const shadows = (s.value.effects ?? [])
        .filter((e: Raw) => e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW")
        .map((e: Raw) => `${e.type === "INNER_SHADOW" ? "inset " : ""}${e.offset?.[0] ?? 0}px ${e.offset?.[1] ?? 0}px ${e.radius ?? 0}px ${e.spread ?? 0}px ${e.color}`);
      if (shadows.length) vars.push(`  ${name}: ${shadows.join(", ")};${from ? ` /* ${from} */` : ""}`);
    }
  }
  const classes: string[] = [];
  for (const [i, s] of textStyles.entries()) {
    const t = s.value;
    const props = [
      // A family is a CSS string like a STRING variable's value, not a JSON one: JSON.stringify left a newline in a
      // family as the letter n, and a font style name carrying "*/" closed the comment and left live CSS behind.
      t.fontFamily && `  font-family: ${cssString(t.fontFamily)};`,
      t.fontStyle && `  /* font-style: ${commentText(t.fontStyle)} */`,
      t.fontSize && `  font-size: ${t.fontSize}px;`,
      `  line-height: ${t.lineHeight === undefined ? "normal" : typeof t.lineHeight === "number" ? `${t.lineHeight}px` : t.lineHeight};`,
      t.letterSpacing !== undefined && `  letter-spacing: ${typeof t.letterSpacing === "number" ? `${t.letterSpacing}px` : t.letterSpacing};`,
      t.textCase === "UPPER" && "  text-transform: uppercase;",
      t.textCase === "LOWER" && "  text-transform: lowercase;",
      t.textDecoration === "UNDERLINE" && "  text-decoration: underline;",
    ].filter(Boolean);
    // As with the custom properties, a numbered class no longer names its style.
    if (classNames[i] !== `${prefix}${ident(s)}`) classes.push(`/* ${commentText(s.name)} (${s.type}) */`);
    classes.push(`${classSelector(classNames[i])} {`, ...(props as string[]), "}");
  }
  return [":root {", ...vars, "}", "", ...classes].join("\n");
}
