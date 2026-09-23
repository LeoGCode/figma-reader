// The compact layer outline figma_get_tree returns: one line per node, indented by depth.
import type { FigDocument, FigNode } from "./fig-file.ts";
import { displayType } from "./normalize.ts";

/** Outline from start (all pages for the DOCUMENT) down depth levels, cut off after maxNodes lines. */
export function outline(doc: FigDocument, start: FigNode, depth: number, maxNodes: number): string {
  const lines: string[] = [];
  let count = 0;
  let truncated = false;
  const visit = (n: FigNode, level: number) => {
    if (count >= maxNodes) {
      truncated = true;
      return;
    }
    count++;
    const size = n.size ? ` ${Math.round(n.size.x)}x${Math.round(n.size.y)}` : "";
    const extra: string[] = [];
    if (n.visible === false) extra.push("hidden");
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
    if (kids.length && level >= depth) extra.push(`${kids.length} children`);
    lines.push(`${"  ".repeat(level)}- ${n.id} ${displayType(n)} "${n.name}"${size}${extra.length ? ` (${extra.join(", ")})` : ""}`);
    if (level < depth) for (const c of kids) visit(c, level + 1);
  };
  if (start.type === "DOCUMENT") for (const p of doc.pages()) visit(p, 0);
  else visit(start, 0);
  if (truncated) lines.push(`... truncated at ${maxNodes} nodes; use a node_id or smaller depth`);
  return lines.join("\n");
}
