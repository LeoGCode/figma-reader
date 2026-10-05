// What changed in a file, two ways. diffDocuments compares two snapshots node by node id, so it sees what was removed
// and where a layer went, but only between two copies someone kept. changesSince reads the edit times one snapshot
// records on its nodes (editInfo), so it needs no older copy, but a deleted node leaves no time behind and a time
// says that something changed, never what.
import type { FigDocument, FigNode, Raw } from "./fig-file.ts";
import { displayType } from "./normalize.ts";

/**
 * The layers both answer about: a page's children and, through sections, the children of its sections (and of the
 * sections in those). A section only groups frames on the canvas, and designers file screens into sections and move
 * them to another one to archive them, so a frame inside one is as much a top-level layer as a frame beside it; the
 * section is one too. In the real 67 MB export the pages' 173 children hold 33 sections with 3,597 layers in them.
 * Page order, each section followed by what is in it.
 */
export function topLevelLayers(doc: FigDocument, page: FigNode): FigNode[] {
  const out: FigNode[] = [];
  const seen = new Set<string>(); // a corrupt file can hold a parent cycle
  const stack = doc.children(page).reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    // One push per child, as FigDocument.walk does: spreading them all into one call passes each as an argument, and
    // a section of 150,000 frames overflowed the stack in both tools.
    if (n.type === "SECTION") for (const c of doc.children(n).reverse()) stack.push(c);
  }
  return out;
}

const entry = (doc: FigDocument, n: FigNode): Raw => ({ id: n.id, type: displayType(n), name: n.name, page: doc.pageOf(n)?.name, path: doc.path(n) });
const place = (doc: FigDocument, n: FigNode): Raw => ({ page: doc.pageOf(n)?.name, parentId: n.parentId, path: doc.path(n) });

/**
 * Two snapshots of one file, compared by node id: Figma keeps a node's id for its whole life, through renames and
 * moves, so the id is what says two layers are the same one. Pages and top-level layers (see topLevelLayers) are
 * added or removed when their id is only in one of the two; renamed when the id is in both under another name;
 * moved when its parent is another one, which a move to another page always is. A layer carried along inside a moved
 * section keeps its parent, so only the section is listed as moved.
 *
 * removedNodes is every node gone from the visible pages, at any depth: what a cited id needs checked. The internal-
 * only page is left out, as every other tool leaves it out: it holds the copies of library components and variables
 * that a library update replaces wholesale. The topmost node of each removed subtree comes first, then the nodes
 * that went with one, which name it in removedWith: in the real snapshots 28 roots took 5,404 nodes with them, and a
 * list in plain document order spent its whole limit inside the first one.
 *
 * Every list stops at limit; counts holds the totals.
 */
export function diffDocuments(old: FigDocument, cur: FigDocument, limit: number) {
  const oldPages = new Map(old.pages().map((p) => [p.id, p]));
  const newPages = new Map(cur.pages().map((p) => [p.id, p]));
  const pagesAdded = [...newPages.values()].filter((p) => !oldPages.has(p.id)).map((p) => ({ id: p.id, name: p.name }));
  const pagesRemoved = [...oldPages.values()].filter((p) => !newPages.has(p.id)).map((p) => ({ id: p.id, name: p.name }));
  const pagesRenamed = [...newPages.values()]
    .filter((p) => oldPages.has(p.id) && oldPages.get(p.id)!.name !== p.name)
    .map((p) => ({ id: p.id, oldName: oldPages.get(p.id)!.name, name: p.name }));

  const topOf = (doc: FigDocument) => new Map(doc.pages().flatMap((p) => topLevelLayers(doc, p)).map((n) => [n.id, n]));
  const oldTop = topOf(old);
  const newTop = topOf(cur);
  const added = [...newTop.values()].filter((n) => !old.get(n.id)).map((n) => entry(cur, n));
  const removed = [...oldTop.values()].filter((n) => !cur.get(n.id)).map((n) => entry(old, n));
  const renamed: Raw[] = [];
  const moved: Raw[] = [];
  // A layer that stopped being top-level (dropped into a frame) or became one (pulled out of a frame) has moved too:
  // it is in both files, so leaving it out of moved would leave it nowhere at all.
  for (const id of new Set([...newTop.keys(), ...oldTop.keys()])) {
    const was = old.get(id), is = cur.get(id);
    if (!was || !is) continue;
    if (was.name !== is.name) renamed.push({ id, type: displayType(is), oldName: was.name, name: is.name, page: cur.pageOf(is)?.name, path: cur.path(is) });
    if (was.parentId !== is.parentId) moved.push({ id, type: displayType(is), name: is.name, from: place(old, was), to: place(cur, is) });
  }

  // Preorder, so a node's parent is settled before it is.
  const rootOf = new Map<string, string>();
  const roots: Raw[] = [];
  const carried: Raw[] = [];
  for (const page of oldPages.values()) {
    for (const n of old.walk(page)) {
      if (n === page || cur.get(n.id)) continue;
      const root = n.parentId ? rootOf.get(n.parentId) : undefined;
      rootOf.set(n.id, root ?? n.id);
      if (root) carried.push({ ...entry(old, n), removedWith: root });
      else roots.push(entry(old, n));
    }
  }
  const removedNodes = [...roots, ...carried];

  const lists = [pagesAdded, pagesRemoved, pagesRenamed, added, removed, renamed, moved, removedNodes];
  const cap = <T>(l: T[]) => l.slice(0, limit);
  return {
    limit,
    truncated: lists.some((l) => l.length > limit),
    counts: {
      pagesAdded: pagesAdded.length,
      pagesRemoved: pagesRemoved.length,
      pagesRenamed: pagesRenamed.length,
      layersAdded: added.length,
      layersRemoved: removed.length,
      layersRenamed: renamed.length,
      layersMoved: moved.length,
      removedNodes: removedNodes.length,
    },
    pages: { added: cap(pagesAdded), removed: cap(pagesRemoved), renamed: cap(pagesRenamed) },
    layers: { added: cap(added), removed: cap(removed), renamed: cap(renamed), moved: cap(moved) },
    removedNodes: cap(removedNodes),
  };
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const DURATION = /^(\d+)([mhdw])$/;
// A date, or a date and time with an optional offset, its parts captured to be checked. Date.parse alone also takes
// "Oct 1", "1/10/2026" and "2026", and it reads 2026-02-29 as 1 March: each some way nobody can check from the answer.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))?)?$/i;

/** The parts ISO_DATE captured name a day the calendar has, and a time and offset a clock can show. */
function realDate(m: RegExpExecArray): boolean {
  const [y, mo, d, h = 0, mi = 0, s = 0, oh = 0, om = 0] = m.slice(1).map((p) => (p === undefined ? undefined : Number(p)));
  const leap = y! % 4 === 0 && (y! % 100 !== 0 || y! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo! - 1];
  return days !== undefined && d! >= 1 && d! <= days && h <= 23 && mi <= 59 && s <= 59 && oh <= 23 && om <= 59;
}

/**
 * The instant `raw` names: an ISO-8601 date ("2026-10-01", which is midnight UTC) or date and time
 * ("2026-10-01T09:30:00-05:00"; without an offset, local time), or a duration back from `now`: 30m, 12h, 7d, 2w.
 * Anything else is an error, and it is raised here, before the file it would be applied to is read.
 */
export function parseSince(raw: string, now = Date.now()): Date {
  const s = raw.trim();
  const d = DURATION.exec(s);
  if (d) {
    const at = new Date(now - Number(d[1]) * UNIT_MS[d[2]]);
    // A Date spans 100,000,000 days either side of 1970; a duration reaching past that is no instant, and it threw
    // only when the answer was written, after the file had been read.
    if (Number.isNaN(at.getTime())) throw new Error(`since ${JSON.stringify(raw)} reaches back further than any date`);
    return at;
  }
  const m = ISO_DATE.exec(s);
  if (!m) {
    throw new Error(`since ${JSON.stringify(raw)} is neither an ISO-8601 date like 2026-10-01 or 2026-10-01T09:30:00Z nor a duration like 30m, 12h, 7d or 2w`);
  }
  if (!realDate(m)) throw new Error(`since ${JSON.stringify(raw)} names a date or time that does not exist`);
  return new Date(Date.parse(s));
}

/**
 * A recorded time from editInfo, in unix seconds. Missing is not recorded, and neither is 0: in the real export 7
 * nodes carry a createdAt of 0 beside a real lastEditedAt, and none of them was made in 1970.
 */
const recorded = (t: unknown): number | undefined => (typeof t === "number" && t > 0 ? t : undefined);

/**
 * A node's newest recorded time in unix seconds, undefined for one that records none: no editInfo, or one with
 * neither time in it. Creation counts, since a node made and never touched since has only that time. In the real
 * export no node was created after its last edit.
 */
function editedAt(n: FigNode): number | undefined {
  const created = recorded(n.editInfo?.createdAt), edited = recorded(n.editInfo?.lastEditedAt);
  return created === undefined ? edited : edited === undefined ? created : Math.max(created, edited);
}

/**
 * The top-level layers (see topLevelLayers) holding anything created or edited at or after `since`, newest first.
 * Each is rolled up from everything under it, since a frame's own time does not always move when a layer in it
 * does: in the real export 397 of 75,149 dated nodes are newer than their dated parent. A section's roll-up holds
 * its layers', which are listed again on their own.
 *
 * What it cannot see is said with the answer. A deleted node records nothing. Text layers record no edit time at all
 * in the exports seen (none of 30,143 in the real one), so an edit to one shows only if Figma moved an ancestor's
 * time too; undatedNodes counts the layers like it.
 */
export function changesSince(doc: FigDocument, since: Date, limit: number) {
  const at = since.getTime() / 1000;
  const found: { newest: number; out: Raw }[] = [];
  let editedNodes = 0;
  let undatedNodes = 0;
  for (const page of doc.pages()) {
    for (const n of doc.walk(page)) {
      if (n === page) continue;
      const t = editedAt(n);
      if (t === undefined) undatedNodes++;
      else if (t >= at) editedNodes++;
    }
    for (const top of topLevelLayers(doc, page)) {
      let newest = -Infinity;
      let count = 0;
      for (const n of doc.walk(top)) {
        const t = editedAt(n);
        if (t === undefined || t < at) continue;
        count++;
        newest = Math.max(newest, t);
      }
      if (!count) continue;
      found.push({
        newest,
        out: {
          id: top.id, name: top.name, type: displayType(top), page: page.name, path: doc.path(top),
          lastEditedAt: new Date(newest * 1000).toISOString(),
          created: (recorded(top.editInfo?.createdAt) ?? -Infinity) >= at,
          editedNodes: count,
        },
      });
    }
  }
  // Stable, so layers edited in the same second keep their page order.
  found.sort((a, b) => b.newest - a.newest);
  return {
    since: since.toISOString(),
    returned: Math.min(found.length, limit),
    total: found.length,
    truncated: found.length > limit,
    limit,
    editedNodes,
    undatedNodes,
    layers: found.slice(0, limit).map((f) => f.out),
  };
}
