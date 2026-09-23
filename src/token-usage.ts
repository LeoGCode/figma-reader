// figma_token_usage: the raw design values a subtree actually uses. Kept apart from tools.ts, which starts a browser
// manager on import, so it can be tested on scene graphs built in code.
import type { FigDocument, FigNode, Raw } from "./fig-file.ts";
import { colorHex, Normalizer } from "./normalize.ts";

// Every field textStyle reports is part of a typography combo: leaving textCase or textDecoration out of the key merged
// e.g. an UPPER label into the plain body style and reported whichever was seen first.
const TYPE_FIELDS = ["fontFamily", "fontStyle", "fontSize", "lineHeight", "letterSpacing", "paragraphSpacing", "textCase", "textDecoration"];
const OVERRIDE_FIELDS = ["fontName", "fontSize", "lineHeight", "letterSpacing", "paragraphSpacing", "textCase", "textDecoration"];
export const typographyKey = (t: Raw) => TYPE_FIELDS.map((f) => JSON.stringify(t[f] ?? null)).join("|");

export function tokenUsage(doc: FigDocument, roots: FigNode[], opts: { includeHidden?: boolean; minCount?: number } = {}) {
  const norm = new Normalizer(doc);
  const bump = (m: Map<string, Raw>, key: string, init: Raw) => {
    const e = m.get(key) ?? { ...init, count: 0 };
    e.count++;
    m.set(key, e);
    return e;
  };
  let textWithoutTypography = 0;
  const colors = new Map<string, Raw>(), type = new Map<string, Raw>(), radii = new Map<string, Raw>();
  const gaps = new Map<string, Raw>(), paddings = new Map<string, Raw>(), strokes = new Map<string, Raw>(), effects = new Map<string, Raw>();
  const skip = new Set<string>();
  for (const root of roots) {
    for (const n of doc.walk(root)) {
      if (!opts.includeHidden && (n.visible === false || (n.parentId && skip.has(n.parentId)))) {
        skip.add(n.id);
        continue;
      }
      const use = (paints: Raw[] | undefined, role: string, styleRef: Raw | undefined) => {
        for (const p of paints ?? []) {
          if (p.visible === false || p.type !== "SOLID") continue;
          const hex = colorHex(p.color, p.opacity ?? 1)!;
          const e = bump(colors, hex, { value: hex, roles: {} as Raw });
          e.roles[role] = (e.roles[role] ?? 0) + 1;
          const v = norm.varName(p.colorVar);
          if (v) (e.variables ??= new Set()).add(v);
          const s = norm.styleName(styleRef);
          if (s) (e.styles ??= new Set()).add(s);
        }
      };
      use(n.fillPaints, n.type === "TEXT" ? "text" : "fill", n.styleIdForFill);
      use(n.strokePaints, "stroke", n.styleIdForStrokeFill);
      if (n.type === "TEXT") {
        const t = norm.textStyle(n);
        // A text node can record none of these fields, and an entry of nothing but a count is not a value anyone can
        // use: it read as a typography combo with no typography. They are counted here instead, so the tool still
        // accounts for every text node it saw. It is the combo that is skipped and not the node: what such a layer
        // strokes or casts a shadow with is a value this subtree uses like any other layer's.
        if (!TYPE_FIELDS.some((f) => t[f] !== undefined)) textWithoutTypography++;
        else {
          const key = typographyKey(t);
          const e = bump(type, key, t);
          const s = norm.styleName(n.styleIdForText);
          if (s) (e.styles ??= new Set()).add(s);
          // styleOverrideTable keeps entries no character points at any more (they pile up as runs are edited), and a
          // combo no glyph renders is not a value this subtree uses. Normalizer.textRuns reads the table through
          // characterStyleIDs, and reads characters past the end of that array as style 0.
          const ids: number[] = n.textData?.characterStyleIDs ?? [];
          const rendered = new Set(ids);
          if (ids.length && [...(n.textData?.characters ?? "")].length > ids.length) rendered.add(0);
          // Runs that change any typography field are a combo of their own; runs that only recolor are counted as colors.
          for (const o of n.textData?.styleOverrideTable ?? []) {
            if (!rendered.has(o.styleID) || !OVERRIDE_FIELDS.some((f) => o[f] !== undefined)) continue;
            const ot: Raw = { ...t, ...norm.textStyle(o) };
            // textStyle leaves out the neutral values, which in a run undo the node's own case, decoration, paragraph
            // spacing, line height (PERCENT 100 is "Auto") or letter spacing (0).
            if (o.textCase === "ORIGINAL") delete ot.textCase;
            if (o.textDecoration === "NONE") delete ot.textDecoration;
            if (o.paragraphSpacing === 0) delete ot.paragraphSpacing;
            if (o.lineHeight?.units === "PERCENT" && o.lineHeight.value === 100) delete ot.lineHeight;
            if (o.letterSpacing && !o.letterSpacing.value) delete ot.letterSpacing;
            // A run that ends up at the node's own style is that one style, not a second copy of it.
            const runKey = typographyKey(ot);
            if (runKey !== key) bump(type, runKey, ot);
          }
        }
      }
      const rad = n.rectangleCornerRadiiIndependent
        ? [n.rectangleTopLeftCornerRadius, n.rectangleTopRightCornerRadius, n.rectangleBottomRightCornerRadius, n.rectangleBottomLeftCornerRadius].map((v) => Math.round((v ?? 0) * 100) / 100).join(" ")
        : n.cornerRadius ? String(Math.round(n.cornerRadius * 100) / 100) : undefined;
      if (rad && rad !== "0 0 0 0") bump(radii, rad, { value: rad });
      const lay = norm.layout(n);
      if (lay) {
        if (typeof lay.gap === "number" && lay.gap > 0) bump(gaps, String(lay.gap), { value: lay.gap });
        const pad = (lay.padding as number[]).join(" ");
        if (pad !== "0 0 0 0") bump(paddings, pad, { value: pad });
      }
      // Per-side weights, as the corner radii just above: a divider with only a bottom border is not a 1px stroke.
      const weight = n.borderStrokeWeightsIndependent
        ? [n.borderTopWeight, n.borderRightWeight, n.borderBottomWeight, n.borderLeftWeight].map((v) => Math.round((v ?? 0) * 100) / 100).join(" ")
        : n.strokeWeight;
      if (n.strokePaints?.some((p: Raw) => p.visible !== false) && weight && weight !== "0 0 0 0") bump(strokes, String(weight), { value: weight });
      for (const ef of n.effects ?? []) {
        const e = norm.effect(ef);
        if (e) bump(effects, JSON.stringify(e), e);
      }
    }
  }
  const min = opts.minCount ?? 1;
  const finish = (m: Map<string, Raw>) =>
    [...m.values()]
      .filter((e) => e.count >= min)
      .sort((a, b) => b.count - a.count)
      .map((e): Raw => ({ ...e, ...(e.variables ? { variables: [...e.variables] } : {}), ...(e.styles ? { styles: [...e.styles] } : {}) }));
  return {
    colors: finish(colors), typography: finish(type), cornerRadii: finish(radii), gaps: finish(gaps),
    paddings: finish(paddings), strokeWidths: finish(strokes), effects: finish(effects),
    ...(textWithoutTypography ? { textWithoutTypography } : {}),
  };
}
