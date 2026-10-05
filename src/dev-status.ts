// The nodes Dev Mode marks Ready for dev or Completed, for figma_dev_status. Kept apart from tools.ts, which starts a
// browser manager on import.
import { compareGuidIds, type FigDocument } from "./fig-file.ts";
import { devStatus, devStatusShown, displayType, type DevStatus } from "./normalize.ts";

export const DEV_STATUS_FILTERS = ["ready_for_dev", "completed", "none", "any"] as const;
export type DevStatusFilter = (typeof DEV_STATUS_FILTERS)[number];

export interface DevStatusEntry extends DevStatus {
  id: string;
  type: string;
  name: string;
  page: string;
  path: string;
}

/**
 * Every node whose own status record matches, newest change first. With no status asked for, that is every record
 * get-node shows (devStatusShown): marked now or before - a frame unmarked since it was ready for dev is what a handoff
 * most needs to hear about - or left by a person. The records that were never anything but none, which Figma writes on
 * components nobody marked, would bury the few that say something. none asks for those as well as the unmarked ones,
 * and any for every record.
 *
 * Read off the nodes rather than the page's handoffStatusMap, which goes stale (see devStatus). Left out, as the
 * component listing leaves them out: internal-only pages, nodes in the trash, and copies of a library asset superseded
 * by a newer copy in the same file.
 */
export function devStatusList(doc: FigDocument, opts: { page?: string; status?: DevStatusFilter } = {}): DevStatusEntry[] {
  const pages = new Set(doc.pages());
  const found: { entry: DevStatusEntry; at: number }[] = [];
  for (const n of doc.nodes.values()) {
    const d = devStatus(n);
    if (!d || n.isSoftDeleted || doc.isSuperseded(n)) continue;
    const page = doc.pageOf(n);
    if (!page || !pages.has(page) || (opts.page !== undefined && page.name !== opts.page)) continue;
    const wanted = opts.status === "any" || (opts.status ? d.status === opts.status : devStatusShown(d));
    if (!wanted) continue;
    found.push({
      entry: { id: n.id, type: displayType(n), name: n.name, page: page.name, path: doc.path(n), ...d },
      at: n.sectionStatusInfo.lastUpdateUnixTimestamp ?? 0,
    });
  }
  // A record with no time sorts last; one time shared by several nodes (a set and its variants marked at once) is
  // broken by id, so the same file answers in the same order every time.
  return found.sort((a, b) => b.at - a.at || compareGuidIds(a.entry.id, b.entry.id)).map((f) => f.entry);
}
