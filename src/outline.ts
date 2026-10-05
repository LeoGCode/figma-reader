// The compact layer outline figma_get_tree returns: one line per node, indented by depth.
import type { FigDocument, FigNode } from "./fig-file.ts";
import { devStatus, displayType } from "./normalize.ts";

const HINTS: Record<string, string> = { ready_for_dev: "ready for dev", completed: "completed" };

/**
 * The Dev Mode status in a word or three: what the node is marked now, or what it was before the mark came off, since
 * an unmarked frame that was ready for dev is the one a handoff asks about. A value with no name is shown as stored.
 * A record that is none and was none names no status, whoever left it, so it has no hint: get-node shows it when a
 * person did.
 */
function devStatusHint(n: FigNode): string | undefined {
  const d = devStatus(n);
  if (!d) return undefined;
  const name = (status: string, raw: string) => HINTS[status] ?? `dev status ${raw}`;
  if (d.status !== "none") return name(d.status, d.raw);
  return d.previous !== "none" ? `was ${name(d.previous, d.previousRaw)}` : undefined;
}

/**
 * Shapes that only draw. A layer built of nothing else (an icon, a logo, an illustration) used to print one line per
 * path: one frame at depth 6 gave 31 VECTOR lines for two logos, and agents piped the tree through grep -v VECTOR. A
 * boolean operation renders as a single shape whatever its operands are. RECTANGLE is not here: a rectangle is as
 * often a background, a divider or an image placeholder as part of a drawing.
 */
const SHAPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "ELLIPSE", "REGULAR_POLYGON"]);

/**
 * A shape painted with an image is a picture (an avatar, a photo in a circle, a photo used as a border), which is not
 * something to count away. Strokes as well as fills, as figma_export_image_fills reads both: an image stroke on an
 * ellipse used to hide the layer holding the image inside its frame's "(1 vector)".
 */
const isDrawing = (n: FigNode) =>
  SHAPES.has(n.type) &&
  (n.type === "BOOLEAN_OPERATION" || !n.childIds.length) &&
  ![...(n.fillPaints ?? []), ...(n.strokePaints ?? [])].some((p: { type?: string }) => p.type === "IMAGE");

/** Lines a parent's children take when it shows some of them: one each, and one for the "... N more children". */
const linesFor = (count: number, shown: number) => shown + (shown > 0 && shown < count ? 1 : 0);

/**
 * How many of their children the parents on one level show, given the lines left. When the level does not fit, each
 * parent gets the same number, the most that fits, and the lines over go one more each in tree order: the first
 * parent's thousand children used to take the whole budget and leave every later page out. A parent cut short costs
 * one line more, its "... N more children"; one with none shown costs nothing, as its own line counts its children.
 * A level that cannot show every parent one child shows none of it.
 */
function share(counts: number[], budget: number): number[] {
  const fit = (cap: number) => counts.reduce((sum, c) => sum + linesFor(c, Math.min(c, cap)), 0);
  // reduce, not Math.max(...counts): a level of a large file holds more parents than a call may take arguments.
  let hi = counts.reduce((m, c) => Math.max(m, c), 0);
  if (fit(hi) <= budget) return counts;
  let lo = 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fit(mid) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const take = counts.map((c) => Math.min(c, lo));
  if (!lo) return take;
  let left = budget - fit(lo);
  for (let i = 0; i < counts.length; i++) {
    if (take[i] === counts[i]) continue;
    // A marker for one child takes the line the child would: showing it costs nothing.
    const more = linesFor(counts[i], take[i] + 1) - linesFor(counts[i], take[i]);
    if (more <= left) {
      take[i]++;
      left -= more;
    }
    if (counts[i] - take[i] === 1) take[i]++;
  }
  return take;
}

/**
 * Outline from start (all pages for the DOCUMENT) down depth levels, cut off after maxNodes lines. The lines are spent
 * a level at a time (pages, then top-level layers, then what is under them) and printed in tree order, where a branch
 * cut short says how much it left out.
 */
export function outline(doc: FigDocument, start: FigNode, depth: number, maxNodes: number): string {
  const roots = start.type === "DOCUMENT" ? doc.pages() : [start];
  /**
   * The children of a drawing are counted on its line, not listed, except under the node asked for: get-tree with a
   * drawing's id is how its shapes are seen.
   */
  const drawing = (n: FigNode, kids: FigNode[]) => n !== start && kids.length > 0 && kids.every(isDrawing);
  const listed = (n: FigNode, level: number) => {
    if (level >= depth) return [];
    const kids = doc.children(n);
    return drawing(n, kids) ? [] : kids;
  };

  // Breadth first: how many children each parent shows, the roots under null.
  const shown = new Map<FigNode | null, number>();
  let level: { parent: FigNode | null; kids: FigNode[] }[] = [{ parent: null, kids: roots }];
  let budget = maxNodes;
  let truncated = false;
  for (let l = 0; level.length && !truncated; l++) {
    const take = share(level.map((g) => g.kids.length), budget);
    const next: typeof level = [];
    level.forEach((g, i) => {
      shown.set(g.parent, take[i]);
      budget -= linesFor(g.kids.length, take[i]);
      if (take[i] < g.kids.length) truncated = true;
      for (const c of g.kids.slice(0, take[i])) {
        const kids = listed(c, l);
        if (kids.length) next.push({ parent: c, kids });
      }
    });
    level = next;
  }

  const lines: string[] = [];
  const more = (level: number, left: number, what: string) => lines.push(`${"  ".repeat(level)}- ... ${left} more ${what}`);
  const visit = (n: FigNode, level: number) => {
    const size = n.size ? ` ${Math.round(n.size.x)}x${Math.round(n.size.y)}` : "";
    const extra: string[] = [];
    if (n.visible === false) extra.push("hidden");
    const dev = devStatusHint(n);
    if (dev) extra.push(dev);
    if (n.type === "INSTANCE") {
      const main = doc.resolveRef({ guid: n.symbolData?.symbolID });
      if (main) extra.push(`of "${main.name}"`);
    }
    if (n.type === "TEXT" && n.textData?.characters) {
      const t = n.textData.characters.replace(/\s+/g, " ");
      extra.push(JSON.stringify(t.length > 60 ? `${t.slice(0, 57)}...` : t));
    }
    if (n.stackMode && n.stackMode !== "NONE") extra.push(`auto-layout ${n.stackMode.toLowerCase()}`);
    const kids = doc.children(n);
    const list = listed(n, level);
    const count = list.length ? (shown.get(n) ?? 0) : 0;
    if (drawing(n, kids)) extra.push(`${kids.length} ${kids.length === 1 ? "vector" : "vectors"}`);
    else if (kids.length && !count) extra.push(`${kids.length} children`);
    lines.push(`${"  ".repeat(level)}- ${n.id} ${displayType(n)} "${n.name}"${size}${extra.length ? ` (${extra.join(", ")})` : ""}`);
    for (const c of list.slice(0, count)) visit(c, level + 1);
    if (count && count < list.length) more(level + 1, list.length - count, "children");
  };
  const top = shown.get(null) ?? 0;
  for (const r of roots.slice(0, top)) visit(r, 0);
  if (top < roots.length) more(0, roots.length - top, "pages");
  if (truncated) lines.push(`... truncated at ${maxNodes} nodes; use a node_id or smaller depth`);
  return lines.join("\n");
}
