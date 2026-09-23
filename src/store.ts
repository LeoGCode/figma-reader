// Snapshot cache: one exported .fig per file key on disk, decoded documents kept in memory.
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { liveLeases, takeLease } from "./browser.ts";
import { FigDocument } from "./fig-file.ts";
import type { FigmaWeb } from "./figma-web.ts";

const noop = () => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How often another process's export lease is re-read while waiting for it. Exported so tests need not guess it. */
export const LEASE_POLL_MS = 100;
/**
 * How long to wait for another process's export before exporting anyway. A holder that died has its lease dropped by
 * liveLeases within one poll, so this ceiling is only for one that is alive and no longer exporting; reaching it
 * costs the duplicate export the wait would have saved, which is what every export did before the wait existed.
 */
const OTHER_EXPORT_WAIT_MS = 600_000;

/**
 * An export whose lease name says it began at or before `since`, so it may be exporting the file as it was before
 * then. The time in the name is the holder's own Date.now(): one in the future means the clock stepped back between
 * that export and this read (chrony's makestep, a resumed VM, date -s), so it dates nothing and counts as older, as
 * does a name carrying no time at all.
 */
function beganBefore(name: string, since: number) {
  const began = Number(name.split("-")[1]);
  return !Number.isFinite(began) || began > Date.now() || began <= since;
}

/**
 * The .fig at `path` as it stands, or undefined when there is none: mtime and size, the pair fromDisk also keys its
 * decode by, since a replacement written within the mtime granularity carries the old time. Only a write changes
 * either, so two readings that differ are two files and the second was written between them - which is what the
 * cross-process rule below needs, and it takes no clock to say it.
 */
function asSeen(path: string): string | undefined {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return undefined;
  }
}

/** A .fig is at `path` and is not the one the reading `seen` stands for, so it was written after that reading. */
function wroteSince(path: string, seen: string | undefined) {
  const now = asSeen(path);
  return now !== undefined && now !== seen;
}

/** What waiting for the other processes on this cache established; see awaitOtherExport. */
interface Floor {
  /** Whether an instant was reached at which no export that may be older than the refresh was still running. */
  reached: boolean;
  /** The .fig as it stood at that instant (see asSeen), undefined when there was none: the bar a newer one clears. */
  file: string | undefined;
}

interface Inflight {
  promise: Promise<FigDocument>;
  /** It exports the live file, so it can serve a refresh request too. */
  refresh: boolean;
  /** Its export has begun, so it began before any request arriving from now on. */
  started: boolean;
}

export class SnapshotStore {
  private docs = new Map<string, FigDocument>();
  /** The file each document was decoded from, as seen then: another process can replace it in a shared cache dir. */
  private stamps = new WeakMap<FigDocument, string>();
  /** Loads in progress, at most one per key: a new one is only ever queued behind the one already there. */
  private inflight = new Map<string, Inflight>();

  private web: FigmaWeb;
  readonly dir: string;
  private maxAgeMs: number;
  private maxDocs: number;

  constructor(web: FigmaWeb, dir: string, maxAgeMs: number, maxDocs = 4) {
    this.web = web;
    this.dir = dir;
    this.maxAgeMs = maxAgeMs;
    this.maxDocs = maxDocs;
    mkdirSync(dir, { recursive: true });
  }

  figPath(fileKey: string) {
    return join(this.dir, `${fileKey}.fig`);
  }

  /**
   * Decode a local .fig (e.g. from File > Save local copy), re-reading it when the file changes on disk. Keyed by real
   * path, so "./a.fig" and its absolute path share one decode.
   */
  async getLocal(path: string): Promise<FigDocument> {
    const real = realpathSync(path);
    return this.fromDisk(real, real);
  }

  /** A snapshot already on disk or in memory, of any age, without exporting. */
  peek(fileKey: string): FigDocument | undefined {
    const path = this.figPath(fileKey);
    if (!existsSync(path)) return this.docs.has(fileKey) ? this.remember(this.docs.get(fileKey)!) : undefined;
    try {
      return this.fromDisk(fileKey, path);
    } catch {
      return undefined;
    }
  }

  /**
   * The decoded file, reusing the one in memory only while the file is unchanged. Size is compared too: a
   * replacement written within the mtime granularity (or with its mtime preserved) would otherwise never reload.
   */
  private fromDisk(fileKey: string, path: string): FigDocument {
    const st = statSync(path);
    const stamp = `${st.mtimeMs}:${st.size}`;
    const cached = this.docs.get(fileKey);
    if (cached && this.stamps.get(cached) === stamp) return this.remember(cached);
    const doc = FigDocument.fromFile(fileKey, path, st.mtime);
    this.stamps.set(doc, stamp);
    return this.remember(doc);
  }

  /** Get a decoded snapshot, exporting a fresh copy when missing, stale, or refresh is requested. */
  async get(fileKey: string, refresh = false): Promise<FigDocument> {
    const pending = this.inflight.get(fileKey);
    // A refresh is answered only by an export that begins after it was asked for. An entry's export begins when its
    // load runs, so `started` is the whole test, and it chains: while the entry is still queued its export will begin
    // after every caller that joins it, and once it has begun it began before this call, whose export goes behind it.
    // Serving a refresh from an export already under way was the bug: edit in Figma, ask to re-read, and the pre-edit
    // file comes back reported as fresh, which reads exactly like the model inventing it.
    if (pending && (!refresh || (pending.refresh && !pending.started))) return pending.promise;
    // Queue behind the pending load, never alongside it, as both would write the same file. A plain load is not
    // reused for a refresh even before it starts: it may answer from disk and never export at all.
    const start = pending ? pending.promise.then(noop, noop) : Promise.resolve();
    const entry: Inflight = { promise: undefined!, refresh, started: false };
    entry.promise = start
      .then(() => {
        entry.started = true;
        return this.load(fileKey, refresh);
      })
      .finally(() => {
        if (this.inflight.get(fileKey) === entry) this.inflight.delete(fileKey);
      });
    this.inflight.set(fileKey, entry);
    return entry.promise;
  }

  /** Where the processes sharing this cache announce that they are exporting a key (see awaitOtherExport). */
  private leaseDir(fileKey: string) {
    return join(this.dir, "exports", fileKey);
  }

  /**
   * Wait while other processes export this key, and report the .fig the file on disk must differ from for the export
   * that wrote it to have provably begun after `since`; undefined when no other export was running. Leases of
   * processes that died are dropped by liveLeases, so a crashed holder costs one poll interval rather than the whole
   * wait.
   *
   * The wait always buys serialization. It buys an answer only when every export that could have begun before
   * `since` was seen gone at a known instant: a lease is dropped only after its export has written the file, so
   * anything written after that instant is another export's, and the only ones left began after `since`.
   *
   * What marks that instant is a reading of the file itself, not a reading of this process's clock. The clock that
   * dates a write is the filesystem's: on NTFS it runs ahead of the Date.now() that follows it by up to a 15.6 ms
   * timer tick, so a file an export had already written read as newer than the instant its holder was last seen at,
   * and answered a refresh no export of it could answer - windows-latest failed the test for two exports running
   * together about one run in four. Comparing the file against itself asks one clock, whichever it is.
   */
  private async awaitOtherExport(fileKey: string, since: number): Promise<Floor | undefined> {
    const leases = this.leaseDir(fileKey);
    const path = this.figPath(fileKey);
    const deadline = Date.now() + OTHER_EXPORT_WAIT_MS;
    // Each lease is dated once, the first time it is seen: a clock that stepped back is only visible while this
    // process's clock has not yet passed the stamp it left behind, so re-dating the same name later lets it through.
    const dated = new Map<string, boolean>();
    let live = liveLeases(leases);
    // The file is read after that first poll and not before it: an export older than `since` whose lease was already
    // gone had written the file by then, so this reading holds its work and no later one is taken for someone else's.
    let floor: Floor = { reached: true, file: asSeen(path) };
    let older = false;
    for (; live.length; live = liveLeases(leases)) {
      // The ceiling is reached with an export still running, so whatever it writes from here on is unattributable.
      if (Date.now() > deadline) return { reached: false, file: undefined };
      for (const name of live) if (!dated.has(name)) dated.set(name, beganBefore(name, since));
      if (live.some((name) => dated.get(name))) older = true;
      else if (older) {
        // Every export older than `since` has gone since the last poll, so it had written the file by now.
        floor = { reached: true, file: asSeen(path) };
        older = false;
      }
      await sleep(LEASE_POLL_MS);
    }
    return dated.size ? (older ? { reached: true, file: asSeen(path) } : floor) : undefined;
  }

  private async load(fileKey: string, refresh: boolean): Promise<FigDocument> {
    const path = this.figPath(fileKey);
    // Every caller this load answers asked before it began, so an export beginning after this point answers them
    // all: the same instant `started` marks in get, written down as a clock for the processes that cannot see it.
    const since = Date.now();
    const fresh = () => existsSync(path) && Date.now() - statSync(path).mtimeMs < this.maxAgeMs;
    if (!refresh && fresh()) return this.fromDisk(fileKey, path);
    // Every process on this cache exports this key to the same .fig, so one export should answer them all where it
    // can. Two at once also settle the snapshot by which of them renamed last, which neither of them asked for.
    const floor = await this.awaitOtherExport(fileKey, since);
    if (floor !== undefined) {
      if (!refresh) {
        if (fresh()) return this.fromDisk(fileKey, path);
      } else if (floor.reached && wroteSince(path, floor.file)) {
        // The rule in get, across processes: the file on disk is no longer the one that stood there while an export
        // that could have begun before this load was still running, so the one that wrote it began after, and it
        // answers this refresh. Two holders at once never clear that bar together, since either of them may have
        // renamed last; then the wait only bought serialization.
        return this.fromDisk(fileKey, path);
      }
    }
    const lease = takeLease(this.leaseDir(fileKey), `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      await this.web.saveLocalCopy(fileKey, path);
    } finally {
      rmSync(lease, { force: true });
    }
    // exportedAt comes from the file's mtime, as for a snapshot read back later, so both agree on its age.
    this.docs.delete(fileKey);
    return this.fromDisk(fileKey, path);
  }

  /** Keep a document, as the most recently used: when over maxDocs, the least recently used is dropped. */
  private remember(doc: FigDocument) {
    this.docs.delete(doc.fileKey);
    this.docs.set(doc.fileKey, doc);
    while (this.docs.size > this.maxDocs) this.docs.delete(this.docs.keys().next().value!);
    return doc;
  }
}
