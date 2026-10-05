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
    if (kids.length && level >= depth) extra.push(`${kids.length} children`);
    lines.push(`${"  ".repeat(level)}- ${n.id} ${displayType(n)} "${n.name}"${size}${extra.length ? ` (${extra.join(", ")})` : ""}`);
    if (level < depth) for (const c of kids) visit(c, level + 1);
  };
  if (start.type === "DOCUMENT") for (const p of doc.pages()) visit(p, 0);
  else visit(start, 0);
  if (truncated) lines.push(`... truncated at ${maxNodes} nodes; use a node_id or smaller depth`);
  return lines.join("\n");
}
