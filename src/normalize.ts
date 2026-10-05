// Turn raw kiwi NodeChange data into compact, codegen-friendly JSON.
import { compareGuidIds, currentCopy, guidId, type FigDocument, type FigNode, type Raw } from "./fig-file.ts";

const r2 = (v: number | undefined) => (v === undefined || v === null ? undefined : Math.round(v * 100) / 100);
const hex2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");

export function colorHex(c: { r: number; g: number; b: number; a?: number } | undefined, opacity = 1): string | undefined {
  if (!c) return undefined;
  const a = (c.a ?? 1) * opacity;
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${a < 0.999 ? hex2(a) : ""}`.toUpperCase();
}

export const bytesHex = (b: Uint8Array | number[] | undefined) =>
  b ? Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("") : undefined;

function prune<T extends Raw>(o: T): T {
  for (const k of Object.keys(o)) {
    const v = o[k];
    const emptyObject = v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0) || emptyObject) delete o[k];
  }
  return o;
}

export class Normalizer {
  private doc: FigDocument;

  constructor(doc: FigDocument) {
    this.doc = doc;
  }

  varName(data: Raw | undefined): string | undefined {
    const alias = data?.value?.alias;
    if (!alias) return undefined;
    const v = this.doc.resolveRef(alias);
    return v?.name ?? (alias.assetRef?.key ? `library:${alias.assetRef.key}` : guidId(alias.guid));
  }

  styleName(ref: Raw | undefined): string | undefined {
    if (!ref) return undefined;
    const s = this.doc.resolveRef(ref);
    return s?.name ?? (ref.assetRef?.key ? `library:${ref.assetRef.key}` : undefined);
  }

  paint(p: Raw): Raw | undefined {
    if (p.visible === false) return undefined;
    const base: Raw = { type: p.type };
    if (p.opacity !== undefined && p.opacity < 1) base.opacity = r2(p.opacity);
    if (p.blendMode && p.blendMode !== "NORMAL") base.blendMode = p.blendMode;
    if (p.type === "SOLID") {
      base.color = colorHex(p.color);
      base.variable = this.varName(p.colorVar);
    } else if (p.type?.startsWith("GRADIENT")) {
      base.stops = (p.stops ?? []).map((s: Raw) => ({ position: r2(s.position), color: colorHex(s.color) }));
      if (p.transform) base.transform = matrix(p.transform);
    } else if (p.type === "IMAGE") {
      base.imageHash = bytesHex(p.image?.hash);
      base.scaleMode = p.imageScaleMode;
      if (p.originalImageWidth) base.originalSize = [p.originalImageWidth, p.originalImageHeight];
    }
    return prune(base);
  }

  paints(list: Raw[] | undefined) {
    return (list ?? []).map((p) => this.paint(p)).filter(Boolean) as Raw[];
  }

  effect(e: Raw): Raw | undefined {
    if (e.visible === false) return undefined;
    return prune({
      type: e.type,
      color: colorHex(e.color),
      offset: e.offset ? [r2(e.offset.x), r2(e.offset.y)] : undefined,
      radius: r2(e.radius),
      spread: e.spread ? r2(e.spread) : undefined,
    });
  }

  textStyle(n: Raw): Raw {
    return prune({
      fontFamily: n.fontName?.family,
      fontStyle: n.fontName?.style,
      fontSize: r2(n.fontSize),
      lineHeight: lineHeight(n.lineHeight),
      letterSpacing: letterSpacing(n.letterSpacing),
      paragraphSpacing: n.paragraphSpacing ? r2(n.paragraphSpacing) : undefined,
      textCase: n.textCase && n.textCase !== "ORIGINAL" ? n.textCase : undefined,
      textDecoration: n.textDecoration && n.textDecoration !== "NONE" ? n.textDecoration : undefined,
    });
  }

  /** Split text into runs using characterStyleIDs + styleOverrideTable. */
  textRuns(n: FigNode): Raw[] | undefined {
    const td = n.textData;
    const ids: number[] | undefined = td?.characterStyleIDs;
    if (!td?.characters || !ids?.length || !td.styleOverrideTable?.length) return undefined;
    const table = new Map<number, Raw>();
    for (const o of td.styleOverrideTable) table.set(o.styleID, o);
    const chars = Array.from(td.characters as string);
    const runs: Raw[] = [];
    let start = 0;
    const idAt = (i: number) => (i < ids.length ? ids[i] : 0);
    for (let i = 1; i <= chars.length; i++) {
      if (i === chars.length || idAt(i) !== idAt(start)) {
        const o = table.get(idAt(start));
        const run: Raw = { text: chars.slice(start, i).join("") };
        if (o) {
          Object.assign(run, this.textStyle(o));
          const fills = this.paints(o.fillPaints);
          if (fills.length) run.fills = fills;
          if (o.hyperlink?.url) run.link = o.hyperlink.url;
        }
        runs.push(run);
        start = i;
      }
    }
    // Selecting all of a layer's text and styling it produces one run, which still carries a fill, a text style or the
    // only hyperlink this decoder ever reports; only a single run with nothing of its own says no more than the node.
    // An entry of the table can hold nothing this decoder reads, so what the run carries decides, not that it has one.
    return runs.length > 1 || Object.keys(runs[0] ?? {}).length > 1 ? runs : undefined;
  }

  /**
   * Bindings live in two maps that usually mirror each other, but either can hold a field the other lacks (in one
   * real file 9,324 fields are only in parameterConsumptionMap; in another, 45 are only in the other map). They name
   * the same variable wherever both have a field, so the first one read wins.
   */
  boundVariables(n: FigNode): Raw | undefined {
    const out: Raw = {};
    for (const e of [...(n.variableConsumptionMap?.entries ?? []), ...(n.parameterConsumptionMap?.entries ?? [])] as Raw[]) {
      const name = this.varName(e.variableData);
      const field = (e.variableField ?? `field${e.nodeField}`).toLowerCase();
      if (name && !(field in out)) out[field] = name;
    }
    return Object.keys(out).length ? out : undefined;
  }

  layout(n: FigNode): Raw | undefined {
    if (!n.stackMode || n.stackMode === "NONE") return undefined;
    // Padding is [top, right, bottom, left]; a missing side is 0. Right and bottom used to copy left and top, but hug
    // frames in real files measure exactly content + left + top whenever those fields are absent.
    return prune({
      mode: n.stackMode,
      gap: n.stackPrimaryAlignItems === "SPACE_BETWEEN" ? "auto" : r2(n.stackSpacing ?? 0),
      counterGap: n.stackWrap === "WRAP" ? r2(n.stackCounterSpacing) : undefined,
      wrap: n.stackWrap === "WRAP" ? true : undefined,
      padding: [n.stackVerticalPadding, n.stackPaddingRight, n.stackPaddingBottom, n.stackHorizontalPadding].map((v) => r2(v ?? 0)),
      primaryAlign: n.stackPrimaryAlignItems ?? "MIN",
      counterAlign: n.stackCounterAlignItems ?? "MIN",
      primarySizing: sizing(n.stackPrimarySizing),
      counterSizing: sizing(n.stackCounterSizing),
      reverseZIndex: n.stackReverseZIndex || undefined,
    });
  }

  childLayout(n: FigNode, parent?: FigNode): Raw | undefined {
    if (!parent?.stackMode || parent.stackMode === "NONE") return undefined;
    if (n.stackPositioning === "ABSOLUTE") return { positioning: "ABSOLUTE" };
    return prune({
      grow: n.stackChildPrimaryGrow ? r2(n.stackChildPrimaryGrow) : undefined,
      alignSelf: n.stackChildAlignSelf && n.stackChildAlignSelf !== "AUTO" ? n.stackChildAlignSelf : undefined,
    });
  }

  component(n: FigNode): Raw | undefined {
    if (n.type === "INSTANCE") {
      const main = this.doc.resolveRef(n.symbolData?.symbolID ? { guid: n.symbolData.symbolID } : undefined) ??
        (n.sharedSymbolReference?.componentKey ? this.doc.byKey.get(n.sharedSymbolReference.componentKey) : undefined);
      const set = main?.parentId ? this.doc.get(main.parentId) : undefined;
      return prune({
        mainComponent: main?.name ?? guidId(n.symbolData?.symbolID),
        mainComponentId: main?.id,
        componentSet: set?.isStateGroup ? set.name : undefined,
        fromLibrary: !!main?.sourceLibraryKey || !!n.sharedSymbolReference?.fileKey || undefined,
        properties: prune({ ...variantProps(main, set), ...this.propAssignments(n.componentPropAssignments, main) }),
        overrides: n.symbolData?.symbolOverrides?.length || undefined,
      });
    }
    if (n.type === "SYMBOL" || n.isStateGroup) {
      return prune({
        kind: n.isStateGroup ? "COMPONENT_SET" : "COMPONENT",
        key: n.componentKey || undefined,
        description: n.symbolDescription || undefined,
        propertyDefinitions: this.propDefs(n),
      });
    }
    return undefined;
  }

  propDefs(n: FigNode): Raw[] | undefined {
    const defs: Raw[] = (n.componentPropDefs ?? []).filter((d: Raw) => !d.isDeleted);
    if (!defs.length) return undefined;
    // A variant's defs only point at its set's (parentPropDefId), which hold the name, type and default.
    const set = n.parentId ? this.doc.get(n.parentId) : undefined;
    const setDefs = new Map<string, Raw>((set?.isStateGroup ? set.componentPropDefs ?? [] : []).map((d: Raw) => [guidId(d.id)!, d]));
    // Files also carry stub defs holding only an id; with no name there is nothing to report.
    const out = defs
      .map((local) => (local.parentPropDefId && setDefs.get(guidId(local.parentPropDefId)!)) || local)
      .filter((d) => d.name)
      .map((d) => prune({ name: d.name, type: d.type, default: propValue(d.initialValue, d.varValue, this.doc) }));
    return out.length ? out : undefined;
  }

  propAssignments(list: Raw[] | undefined, main?: FigNode): Raw | undefined {
    if (!list?.length) return undefined;
    const set = main?.parentId ? this.doc.get(main.parentId) : undefined;
    const defs = new Map<string, Raw>();
    for (const d of set?.isStateGroup ? set.componentPropDefs ?? [] : []) defs.set(guidId(d.id)!, d);
    // Variant components carry local def ids that point at the set's definitions via parentPropDefId.
    for (const d of main?.componentPropDefs ?? []) {
      const parent = d.parentPropDefId ? defs.get(guidId(d.parentPropDefId)!) : undefined;
      defs.set(guidId(d.id)!, parent ?? d);
    }
    const out: Raw = {};
    for (const a of list) {
      const def = defs.get(guidId(a.defID)!);
      out[def?.name ?? guidId(a.defID)!] = propValue(a.value, a.varValue, this.doc);
    }
    return out;
  }

  private categories?: Map<string, string>;

  /**
   * Dev Mode annotations: the note a designer pins on a layer, and the properties it asks Dev Mode to show beside it.
   * An annotation with an empty label is a properties-only one, which is the common kind.
   */
  annotations(n: FigNode): Raw[] | undefined {
    const list: Raw[] = n.annotations ?? [];
    if (!list.length) return undefined;
    // Category names live once on the document, keyed by the id each annotation names.
    if (!this.categories) {
      this.categories = new Map();
      for (const c of this.doc.get(this.doc.rootId)?.annotationCategories?.items ?? []) {
        const name = c.preset && c.preset !== "NONE" ? `${c.preset[0]}${c.preset.slice(1).toLowerCase()}` : c.custom?.label;
        if (guidId(c.id) && name) this.categories.set(guidId(c.id)!, name);
      }
    }
    return list.map((a) => {
      const category = guidId(a.categoryId);
      return prune({
        label: annotationLabel(a.labelV2) ?? annotationLabel(a.label),
        // A category the document does not name is kept as its id rather than dropped, so the grouping still shows.
        category: category ? this.categories!.get(category) : undefined,
        categoryId: category && !this.categories!.has(category) ? category : undefined,
        properties: (a.properties ?? []).map((p: Raw) => p.type).filter(Boolean),
      });
    });
  }

  /**
   * Dev Mode measurements: a distance the designer pinned from one side of this layer to a side of another, or of
   * itself. What Figma stores is the two nodes and the sides, not the distance, so that is what is reported.
   */
  measurements(n: FigNode): Raw[] | undefined {
    const list: Raw[] = n.measurements ?? [];
    if (!list.length) return undefined;
    // 0xFFFFFFFF in both halves is Figma's "no node", and toNode holds it in every measurement seen so far: the
    // target is in toNodeStablePath instead, and fromNode is left out because the measurement is on its from node.
    const real = (g: { sessionID: number; localID: number } | undefined) => (g && g.sessionID !== 0xffffffff ? guidId(g) : undefined);
    return list.map((m) => {
      // A stable path is the target node, then, when the target is a layer inside that instance, the layer's override
      // key at each instance level: the same addressing symbolOverrides use, so only its first id is a node here.
      const path: string[] = (m.toNodeStablePath?.guids ?? []).map(real).filter(Boolean);
      const to = path[0] ?? real(m.toNode);
      const side: string | undefined = m.fromNodeSide;
      return prune({
        from: real(m.fromNode) ?? n.id,
        fromSide: side,
        to,
        // What toSameSide means was read off real files: every measurement from a layer to itself has it false, so it
        // crosses to the opposite side (a width or a height), and every one to an enclosing frame has it true (a
        // padding). The side it names says that outright, where the bare flag left the caller to work it out.
        toSide: side && (m.toSameSide ? side : OPPOSITE_SIDE[side]),
        toPath: path.length > 1 ? path : undefined,
        toMissing: to && !this.doc.get(to) ? true : undefined,
        freeText: m.freeText || undefined,
      });
    });
  }

  node(n: FigNode, depth: number, parent?: FigNode): Raw {
    const out: Raw = { id: n.id, name: n.name, type: displayType(n) };
    if (n.visible === false) out.visible = false;
    if (n.transform && n.type !== "CANVAS") {
      out.x = r2(n.transform.m02);
      out.y = r2(n.transform.m12);
      const rot = (Math.atan2(n.transform.m10, n.transform.m00) * 180) / Math.PI;
      if (Math.abs(rot) > 0.01) out.rotation = r2(rot);
    }
    if (n.size) {
      out.width = r2(n.size.x);
      out.height = r2(n.size.y);
    }
    if (n.opacity !== undefined && n.opacity < 1) out.opacity = r2(n.opacity);
    if (n.blendMode && !["PASS_THROUGH", "NORMAL"].includes(n.blendMode)) out.blendMode = n.blendMode;

    const fills = this.paints(n.fillPaints);
    if (fills.length) out.fills = fills;
    out.fillStyle = this.styleName(n.styleIdForFill);
    const strokes = this.paints(n.strokePaints);
    if (strokes.length) {
      out.strokes = strokes;
      out.strokeWeight = n.borderStrokeWeightsIndependent
        ? [n.borderTopWeight, n.borderRightWeight, n.borderBottomWeight, n.borderLeftWeight].map(r2)
        : r2(n.strokeWeight);
      out.strokeAlign = n.strokeAlign;
      out.strokeStyle = this.styleName(n.styleIdForStrokeFill);
    }
    if (n.rectangleCornerRadiiIndependent) {
      out.cornerRadius = [
        n.rectangleTopLeftCornerRadius, n.rectangleTopRightCornerRadius,
        n.rectangleBottomRightCornerRadius, n.rectangleBottomLeftCornerRadius,
      ].map((v) => r2(v ?? 0));
    } else if (n.cornerRadius) out.cornerRadius = r2(n.cornerRadius);
    const effects = (n.effects ?? []).map((e: Raw) => this.effect(e)).filter(Boolean);
    if (effects.length) out.effects = effects;
    out.effectStyle = this.styleName(n.styleIdForEffect);
    if (n.frameMaskDisabled === false && !n.resizeToFit && ["FRAME", "SYMBOL", "INSTANCE"].includes(n.type)) out.clipsContent = true;
    out.layout = this.layout(n);
    out.layoutChild = this.childLayout(n, parent);
    if (n.minSize?.value || n.maxSize?.value) {
      out.constraints = prune({
        minWidth: r2(n.minSize?.value?.x), minHeight: r2(n.minSize?.value?.y),
        maxWidth: r2(n.maxSize?.value?.x), maxHeight: r2(n.maxSize?.value?.y),
      });
    }

    if (n.type === "TEXT") {
      out.characters = n.textData?.characters;
      out.text = prune({
        ...this.textStyle(n),
        align: n.textAlignHorizontal && n.textAlignHorizontal !== "LEFT" ? n.textAlignHorizontal : undefined,
        verticalAlign: n.textAlignVertical && n.textAlignVertical !== "TOP" ? n.textAlignVertical : undefined,
        autoResize: n.textAutoResize,
        maxLines: n.maxLines || undefined,
        truncation: n.textTruncation && n.textTruncation !== "DISABLED" ? n.textTruncation : undefined,
      });
      out.textStyle = this.styleName(n.styleIdForText);
      out.runs = this.textRuns(n);
    }

    out.component = this.component(n);
    out.boundVariables = this.boundVariables(n);
    if (n.exportSettings?.length) {
      out.exports = n.exportSettings.map((e: Raw) => prune({ format: e.imageType, suffix: e.suffix || undefined, constraint: e.constraint }));
    }
    const dev = devStatus(n);
    if (dev && devMarked(dev)) out.devStatus = dev;
    out.annotations = this.annotations(n);
    out.measurements = this.measurements(n);

    const kids = this.doc.children(n);
    if (kids.length) {
      if (depth > 0) out.children = kids.map((c) => this.node(c, depth - 1, n));
      else out.childCount = kids.length;
    }
    return prune(out);
  }
}

export function displayType(n: FigNode): string {
  if (n.type === "SYMBOL") return "COMPONENT";
  if (n.type === "CANVAS") return "PAGE";
  if (n.type === "FRAME" && n.isStateGroup) return "COMPONENT_SET";
  if (n.type === "FRAME" && n.resizeToFit) return "GROUP";
  if (n.type === "ROUNDED_RECTANGLE") return "RECTANGLE";
  return n.type;
}

/**
 * Dev Mode's names for the SectionStatus values a .fig stores. BUILD is taken to be what the editor calls "Ready for
 * dev" and COMPLETED its "Completed": the names line up, but nobody has yet marked a frame and exported the file again
 * to confirm it, so every answer keeps the stored value beside the name.
 */
const DEV_STATUS: Record<string, string> = { NONE: "none", BUILD: "ready_for_dev", COMPLETED: "completed" };

export interface DevStatus {
  /** ready_for_dev, completed or none; unknown for a value this decoder has no name for, which raw then holds. */
  status: string;
  raw: string;
  previous: string;
  previousRaw: string;
  /** ISO-8601: when the status last changed, which for status none with a previous status is when the mark came off. */
  changedAt?: string;
  /** The Figma user id that changed it. The export holds no names to go with it. */
  by?: string;
  note?: string;
}

/**
 * The Dev Mode status a node carries in its own sectionStatusInfo. Each page also keeps a handoffStatusMap of the
 * statuses on it, but that index goes stale: its entries outlive the nodes they name and can disagree with the node
 * about the previous status, so the node's own record is what is read. An absent status is NONE, the enum's first
 * value, and the timestamp is in seconds.
 */
export function devStatus(n: FigNode): DevStatus | undefined {
  const s: Raw | undefined = n.sectionStatusInfo;
  if (!s) return undefined;
  const raw: string = s.status ?? "NONE";
  const previousRaw: string = s.prevStatus ?? "NONE";
  return prune({
    status: DEV_STATUS[raw] ?? "unknown",
    raw,
    previous: DEV_STATUS[previousRaw] ?? "unknown",
    previousRaw,
    changedAt: s.lastUpdateUnixTimestamp ? new Date(s.lastUpdateUnixTimestamp * 1000).toISOString() : undefined,
    by: s.userId || undefined,
    note: s.description || undefined,
  });
}

/**
 * Whether a status record says anything: marked now, or marked before and since unmarked ("was ready for dev"). Figma
 * also writes records that are none and were none on components nobody marked, by the thousand in a component
 * library; reporting those would put a dated "none" on every variant of it.
 */
export const devMarked = (d: DevStatus) => d.status !== "none" || d.previous !== "none";

/**
 * An annotation's text as markdown. label holds HTML in every export seen (a <p> per line, <br>, <strong>, <code>,
 * <a href>), and markdown keeps the links and code spans that tag stripping would lose; the Plugin API hands the same
 * text out as markdown too. labelV2 has not been seen set in any export: it is the later field, so it wins when it is,
 * and is read the same way - text with no markup passes through unchanged.
 */
function annotationLabel(html: unknown): string | undefined {
  if (typeof html !== "string" || !html.trim()) return undefined;
  const md = html
    .replace(/<p\b[^>]*>\s*<br\s*\/?>\s*<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, e: string) => {
      const k = e.toLowerCase();
      if (k[0] !== "#") return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[k]!;
      const cp = k[1] === "x" ? parseInt(k.slice(2), 16) : Number(k.slice(1));
      // fromCodePoint throws past U+10FFFF; such an entity is left as it was written.
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : entity;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return md || undefined;
}

const OPPOSITE_SIDE: Record<string, string> = { TOP: "BOTTOM", BOTTOM: "TOP", LEFT: "RIGHT", RIGHT: "LEFT" };

function sizing(s: string | undefined) {
  if (!s) return undefined;
  return s === "FIXED" ? "FIXED" : "HUG";
}

/** Figma stores "Auto" line height as 100%; RAW is a unitless multiplier. Pixels are returned as numbers. */
function lineHeight(v: Raw | undefined): number | string | undefined {
  if (!v || v.value === undefined) return undefined;
  if (v.units === "PERCENT") return v.value === 100 ? undefined : `${r2(v.value)}%`;
  if (v.units === "RAW") return `${r2(v.value * 100)}%`;
  return r2(v.value);
}

/** Letter spacing: PERCENT of font size, RAW in em, PIXELS as numbers. Zero is omitted. */
function letterSpacing(v: Raw | undefined): number | string | undefined {
  if (!v || !v.value) return undefined;
  if (v.units === "PERCENT") return `${r2(v.value)}%`;
  if (v.units === "RAW") return `${r2(v.value)}em`;
  return r2(v.value);
}

function matrix(m: Raw) {
  return [[r2(m.m00), r2(m.m01), r2(m.m02)], [r2(m.m10), r2(m.m11), r2(m.m12)]];
}

/** "Size=Large, State=Hover" on a variant inside a component set. */
function variantProps(main: FigNode | undefined, set: FigNode | undefined): Raw {
  if (!main || !set?.isStateGroup) return {};
  const out: Raw = {};
  for (const part of main.name.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** A property value that was read, or the reason it could not be, for callers that must report instead of guessing. */
export interface PropValue {
  value?: unknown;
  /** Set when the value is there but this decoder cannot turn it into a plain value; `value` is then absent. */
  reason?: string;
}

/**
 * A component property value (an assignment or a definition's default) is stored either
 * inline as a ComponentPropValue, or - since properties became variable-backed - under
 * `varValue` as a VariableData, in which case `value` is left an empty object. Both shapes
 * occur in the same file, so reading only one silently returns the component's default
 * (or nothing) instead of what the instance actually shows.
 */
export function propValueOf(v: Raw | undefined, varValue?: Raw, doc?: FigDocument): PropValue {
  if (v) {
    if (v.boolValue !== undefined) return { value: v.boolValue };
    if (v.textValue) return { value: v.textValue.characters };
    if (v.floatValue !== undefined) return { value: v.floatValue };
    if (v.guidValue) return { value: guidId(v.guidValue) };
  }
  const any = varValue?.value;
  if (!any || !Object.keys(any).length) return {};
  return variableValue(any, doc, new Set());
}

/** The value alone; callers that cannot report what they failed to read use this. */
export function propValue(v: Raw | undefined, varValue?: Raw, doc?: FigDocument): unknown {
  return propValueOf(v, varValue, doc).value;
}

/** One VariableData value: a plain value, or an alias to the variable holding it. */
function variableValue(value: Raw, doc: FigDocument | undefined, seen: Set<string>): PropValue {
  if (value.textDataValue) return { value: value.textDataValue.characters };
  if (value.textValue !== undefined) return { value: value.textValue };
  if (value.boolValue !== undefined) return { value: value.boolValue };
  if (value.floatValue !== undefined) return { value: value.floatValue };
  if (value.symbolIdValue?.guid) return { value: guidId(value.symbolIdValue.guid) };
  if (value.alias) return aliasValue(value.alias, doc, seen);
  return { reason: `set to a value shape this decoder does not know (${Object.keys(value).join(", ")})` };
}

const modelessDefaults = new WeakMap<FigDocument, Map<string, string | undefined>>();

/**
 * The mode a variable is read in when nothing names one: the collection's first mode by sortPosition.
 *
 * A collection can carry no variableSetModes at all (seen on partial library copies), and its mode ids then exist
 * only on its variables' values. The variables of one collection do not store those in a common order, so taking the
 * one variable's first entry answered about a different mode for each variable of the same collection. The lowest
 * mode id of the whole collection stands in for the first mode: guids are allocated in creation order, and where a
 * collection does carry its modes, the first by sortPosition is the one created with the collection.
 */
function defaultMode(doc: FigDocument, variable: FigNode): string | undefined {
  const set = doc.resolveRef(variable.variableSetID);
  if (!set) return undefined;
  const modes = [...(set.variableSetModes ?? [])]
    .sort((a: Raw, b: Raw) => (a.sortPosition < b.sortPosition ? -1 : a.sortPosition > b.sortPosition ? 1 : 0));
  if (modes.length) return guidId(modes[0].id);
  let cached = modelessDefaults.get(doc);
  if (!cached) modelessDefaults.set(doc, (cached = new Map()));
  if (!cached.has(set.id)) {
    const ids = new Set<string>();
    for (const n of doc.nodes.values()) {
      if (n.type !== "VARIABLE" || doc.resolveRef(n.variableSetID)?.id !== set.id) continue;
      for (const e of n.variableDataValues?.entries ?? []) if (guidId(e.modeID)) ids.add(guidId(e.modeID)!);
    }
    cached.set(set.id, [...ids].sort(compareGuidIds)[0]);
  }
  return cached.get(set.id);
}

/**
 * The value a property bound to a variable shows. A variable holds one value per mode; a property assignment names no
 * mode, and outside a frame carrying a mode override Figma shows the collection's default mode - the same rule
 * extractVariables applies. A reference made before a library update names the copy of that version, which the token
 * export leaves out, so it is read as the copy that is exported: otherwise nothing there explains the string.
 */
function aliasValue(alias: Raw, doc: FigDocument | undefined, seen: Set<string>): PropValue {
  const variable = doc && currentCopy(doc, alias);
  if (!variable) return { reason: "bound to a variable that is not in this file (library variable with no local copy)" };
  if (seen.has(variable.id)) return { reason: "bound to a variable whose value is a cycle of aliases" };
  seen.add(variable.id);
  const mode = defaultMode(doc!, variable);
  const entries: Raw[] = variable.variableDataValues?.entries ?? [];
  const value = (entries.find((e) => guidId(e.modeID) === mode) ?? entries[0])?.variableData?.value;
  if (!value) return { reason: "bound to a variable that has no value in this file" };
  return variableValue(value, doc, seen);
}
