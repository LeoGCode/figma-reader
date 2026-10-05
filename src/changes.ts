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
 * The pages an answer covers, by name: the one asked for, or every page but the excluded ones. diffDocuments resolves
 * the names to the pages bearing them in either file; changesSince reads one file, where a name is a page.
 */
export interface PageFilter {
  page?: string;
  exclude?: Set<string>;
}
const covers = (f: PageFilter | undefined, page: string | undefined) =>
  page !== undefined && (f?.page !== undefined ? page === f.page : !f?.exclude?.has(page));

/**
 * Up to `limit` of `list`, kept in its order, shared between the pages its entries are on the way get-tree shares
 * its budget between parents: a page with fewer entries than an even share shows them all, and what it leaves goes to
 * the others. In list order the first page with changes took the whole limit: on two real snapshots every one of the
 * 100 layers diff listed as added was on the design-system page, and the 14 added on product pages were all cut.
 */
export function sharedByPage<T>(list: T[], pageOf: (e: T) => string | undefined, limit: number): T[] {
  if (list.length <= limit) return list;
  const sizes = new Map<string | undefined, number>();
  for (const e of list) sizes.set(pageOf(e), (sizes.get(pageOf(e)) ?? 0) + 1);
  // The most entries every page can show at once, the larger pages cut to it; what that leaves goes one more each to
  // the pages still cut, in list order.
  const fit = (cap: number) => [...sizes.values()].reduce((sum, n) => sum + Math.min(n, cap), 0);
  let lo = 0;
  for (let hi = limit; lo < hi; ) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fit(mid) <= limit) lo = mid;
    else hi = mid - 1;
  }
  const give = new Map([...sizes].map(([page, n]) => [page, Math.min(n, lo)]));
  let left = limit - fit(lo);
  for (const [page, n] of sizes) {
    if (left && give.get(page)! < n) {
      give.set(page, give.get(page)! + 1);
      left--;
    }
  }
  return list.filter((e) => {
    const n = give.get(pageOf(e))!;
    give.set(pageOf(e), n - 1);
    return n > 0;
  });
}

/**
 * Counts per page, by name. A Map and not an object: a page is named by whoever made the file, and a page called
 * "__proto__" made `counts[page] ??= {}` find Object.prototype and count into it, so every later answer of the process
 * (a batch, an MCP server) inherited "layers" and "editedNodes" it never counted.
 */
type PageCounts = Map<string, Map<string, number>>;
/** Count `what` under page in counts, leaving out a page or count that has none. */
const tally = (counts: PageCounts, page: string | undefined, what: string, n = 1) => {
  if (page === undefined || !n) return;
  let c = counts.get(page);
  if (!c) counts.set(page, (c = new Map()));
  c.set(what, (c.get(what) ?? 0) + n);
};
/** The counts as the answer carries them. fromEntries defines each page as a property of its own, "__proto__" too. */
const byPageOf = (counts: PageCounts) => Object.fromEntries([...counts].map(([page, c]) => [page, Object.fromEntries(c)]));

/**
 * Two snapshots of one file, compared by node id: Figma keeps a node's id for its whole life, through renames and
 * moves, so the id is what says two layers are the same one. Pages and top-level layers (see topLevelLayers) are
 * added or removed when their id is only in one of the two; renamed when the id is in both under another name;
 * moved when its parent is another one, which a move to another page always is. A layer carried along inside a moved
 * section keeps its parent, so only the section is listed as moved.
 *
 * removedNodes holds the topmost node of each subtree gone from the visible pages, with removedCount, how many nodes
 * went with it, itself included: every node removed is in one of them, and any id is checked by figma_locate on the
 * old and the new file. Listing every node went past any limit at once - in the real snapshots 28 roots took 5,404
 * nodes with them - and the ids under a root say nothing the root does not. The internal-only page is left out, as
 * every other tool leaves it out: it holds the copies of library components and variables that a library update
 * replaces wholesale.
 *
 * `pages` narrows every list to the pages it covers (a layer moved between pages, to either of its two), before the
 * limit; byPage counts every page all the same, the excluded ones too, since it is how a reader learns where to look.
 * A page is named in byPage as the new file names it, or as the old one did if it is gone. The names `pages` gives are
 * resolved to the pages that bear them in either file, and the lists are filtered by those pages, not by name: a page
 * renamed between the two is the same page by both its names. Filtered by the new name alone, "the page it was"
 * selected nothing and excluded nothing, and its removals vanished from an answer that was not truncated. Every list
 * stops at limit, shared between pages (see sharedByPage); counts holds the totals of what the lists cover.
 */
export function diffDocuments(old: FigDocument, cur: FigDocument, limit: number, pages?: PageFilter) {
  const oldPages = new Map(old.pages().map((p) => [p.id, p]));
  const newPages = new Map(cur.pages().map((p) => [p.id, p]));
  const pagesAdded = [...newPages.values()].filter((p) => !oldPages.has(p.id)).map((p) => ({ id: p.id, name: p.name }));
  const pagesRemoved = [...oldPages.values()].filter((p) => !newPages.has(p.id)).map((p) => ({ id: p.id, name: p.name }));
  const pagesRenamed = [...newPages.values()]
    .filter((p) => oldPages.has(p.id) && oldPages.get(p.id)!.name !== p.name)
    .map((p) => ({ id: p.id, oldName: oldPages.get(p.id)!.name, name: p.name }));

  // Changes are filed by page id, which a rename keeps. A page goes by the new file's name in byPage, or the old
  // one's if it is gone; a page asked for or excluded by name is every page that bears it in either file.
  const pageOf = (doc: FigDocument, n: FigNode) => doc.pageOf(n)?.id;
  const nameOf = (id: string | undefined) => id && (newPages.get(id)?.name ?? oldPages.get(id)?.name);
  const bearing = (names: Iterable<string>) => {
    const want = new Set(names);
    return new Set([...oldPages.values(), ...newPages.values()].filter((p) => want.has(p.name)).map((p) => p.id));
  };
  const chosen = pages?.page !== undefined ? bearing([pages.page]) : undefined;
  const left = bearing(pages?.exclude ?? []);
  const covered = (id: string | undefined) => id !== undefined && (chosen ? chosen.has(id) : !left.has(id));
  const topOf = (doc: FigDocument) => new Map(doc.pages().flatMap((p) => topLevelLayers(doc, p)).map((n) => [n.id, n]));
  const oldTop = topOf(old);
  const newTop = topOf(cur);
  type Found = { out: Raw; on: (string | undefined)[] };
  const added: Found[] = [...newTop.values()].filter((n) => !old.get(n.id)).map((n) => ({ out: entry(cur, n), on: [pageOf(cur, n)] }));
  const removed: Found[] = [...oldTop.values()].filter((n) => !cur.get(n.id)).map((n) => ({ out: entry(old, n), on: [pageOf(old, n)] }));
  const renamed: Found[] = [];
  const moved: Found[] = [];
  // A layer that stopped being top-level (dropped into a frame) or became one (pulled out of a frame) has moved too:
  // it is in both files, so leaving it out of moved would leave it nowhere at all.
  for (const id of new Set([...newTop.keys(), ...oldTop.keys()])) {
    const was = old.get(id), is = cur.get(id);
    if (!was || !is) continue;
    if (was.name !== is.name) {
      renamed.push({ out: { id, type: displayType(is), oldName: was.name, name: is.name, page: cur.pageOf(is)?.name, path: cur.path(is) }, on: [pageOf(cur, is)] });
    }
    // Moved to the page it is on now, and from the one it left: the page it left lost a layer as surely.
    if (was.parentId !== is.parentId) {
      moved.push({ out: { id, type: displayType(is), name: is.name, from: place(old, was), to: place(cur, is) }, on: [pageOf(cur, is), pageOf(old, was)] });
    }
  }

  // Preorder, so a node's parent is settled before it is.
  const rootOf = new Map<string, Found>();
  const roots: Found[] = [];
  const byPage: PageCounts = new Map();
  for (const page of oldPages.values()) {
    for (const n of old.walk(page)) {
      if (n === page || cur.get(n.id)) continue;
      const root = n.parentId ? rootOf.get(n.parentId) : undefined;
      if (root) root.out.removedCount++;
      else roots.push({ out: { ...entry(old, n), removedCount: 1 }, on: [pageOf(old, n)] });
      rootOf.set(n.id, root ?? roots.at(-1)!);
      tally(byPage, nameOf(pageOf(old, n)), "removedNodes");
    }
  }
  for (const f of added) tally(byPage, nameOf(f.on[0]), "added");
  for (const f of removed) tally(byPage, nameOf(f.on[0]), "removed");
  for (const f of renamed) tally(byPage, nameOf(f.on[0]), "renamed");
  for (const f of moved) {
    tally(byPage, nameOf(f.on[0]), "moved");
    if (f.on[1] !== f.on[0]) tally(byPage, nameOf(f.on[1]), "movedOut");
  }

  const kept = (l: Found[]) => l.filter((f) => f.on.some(covered));
  const [add, rem, ren, mov, rts] = [added, removed, renamed, moved, roots].map(kept);
  const pageLists = [pagesAdded, pagesRemoved, pagesRenamed].map((l) => l.filter((p) => covered(p.id)));
  const cap = <T>(l: T[]) => l.slice(0, limit);
  const share = (l: Found[]) => sharedByPage(l, (f) => f.on[0], limit).map((f) => f.out);
  return {
    limit,
    truncated: [...pageLists, add, rem, ren, mov, rts].some((l) => l.length > limit),
    counts: {
      pagesAdded: pageLists[0].length,
      pagesRemoved: pageLists[1].length,
      pagesRenamed: pageLists[2].length,
      layersAdded: add.length,
      layersRemoved: rem.length,
      layersRenamed: ren.length,
      layersMoved: mov.length,
      removedRoots: rts.length,
      removedNodes: rts.reduce((sum, f) => sum + (f.out.removedCount as number), 0),
    },
    byPage: byPageOf(byPage),
    pages: { added: cap(pageLists[0]), removed: cap(pageLists[1]), renamed: cap(pageLists[2]) },
    layers: { added: share(add), removed: share(rem), renamed: share(ren), moved: share(mov) },
    removedNodes: share(rts),
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
 * neither time in it. Creation counts, since a node made and never touched since has only that time.
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
 *
 * `pages` narrows the list and its counts to the pages it covers, before the limit, which is shared between pages as
 * diff shares its own (see sharedByPage); byPage counts the layers and edited nodes of every page, the excluded ones
 * too.
 */
export function changesSince(doc: FigDocument, since: Date, limit: number, pages?: PageFilter) {
  const at = since.getTime() / 1000;
  const found: { newest: number; out: Raw }[] = [];
  const byPage: PageCounts = new Map();
  let editedNodes = 0;
  let undatedNodes = 0;
  for (const page of doc.pages()) {
    const kept = covers(pages, page.name);
    for (const n of doc.walk(page)) {
      if (n === page) continue;
      const t = editedAt(n);
      if (t === undefined) undatedNodes += kept ? 1 : 0;
      else if (t >= at) {
        editedNodes += kept ? 1 : 0;
        tally(byPage, page.name, "editedNodes");
      }
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
      tally(byPage, page.name, "layers");
      if (!kept) continue;
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
    byPage: byPageOf(byPage),
    layers: sharedByPage(found, (f) => f.out.page as string, limit).map((f) => f.out),
  };
}
