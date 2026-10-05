// Snapshot cache: the latest exported .fig per file key on disk, and the one it replaced; decoded documents in memory.
import { existsSync, linkSync, mkdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cannotWrite, mayNotWrite } from "./account.ts";
import { dropLease, liveLeases, processStamp, takeLease } from "./browser.ts";
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
/** How often a held publish lock is looked at again: it is held for a few file operations (see underPublishLock). */
const PUBLISH_POLL_MS = 10;

/** Where the processes sharing the snapshot directory `dir` announce that they are exporting a key (see awaitOtherExport). */
const exportLeases = (dir: string, fileKey: string) => join(dir, "exports", fileKey);
/** Where a process reading the key's pair under names of its own announces it until those names are gone (see previousOf). */
const readerLeases = (dir: string, fileKey: string) => join(dir, "exports", `${fileKey}.reading`);

/**
 * The key, pid and tag a staging file's name carries: "<key>.fig.<pid>.<tag>.tmp" for an export's own file and for
 * diff previous's link to the snapshot, "<key>.previous.fig.<pid>.<tag>.tmp" for the links that keep and read the
 * previous one. moveDownload's copy of an export's file is named after that file, so it begins the same way.
 */
const STAGED = /^([A-Za-z0-9]+)\.(?:previous\.)?fig\.(\d+)\.([a-z0-9]+)\.tmp/;

/**
 * Whether the staging file `name` in the snapshot directory `dir` is still in use by the process that made it, which
 * is what cleanStaleDownloads asks before it sweeps one by its age. Every such file is made under a lease whose name
 * carries the same pid and tag - the export's own, or previousOf's - held for as long as the file is in use, so a live
 * one says it is in use however old the file looks, judged by liveLeases by the rules every lease here is judged by.
 *
 * Age alone was the rule, and no age can tell: an export's file carries the mtime of the download it was moved from,
 * a link carries the snapshot's, and both are older than any sweep that begins while they are used. A process that
 * reached the browser while another was decoding its export deleted the file under it, and the rename onto the
 * snapshot then failed. A name with no tag (an older build's), or one no live lease claims, is left to its age.
 */
export function stagedByLiveOwner(dir: string, name: string): boolean {
  const m = STAGED.exec(name);
  if (!m) return false;
  const [, fileKey, pid, tag] = m;
  return [exportLeases(dir, fileKey), readerLeases(dir, fileKey)].some((leases) =>
    liveLeases(leases).some((lease) => lease.split("-")[0] === pid && lease.endsWith(`-${tag}`)),
  );
}

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

/** A reading that could not be taken at all, which is neither a file nor the absence of one. */
const UNREADABLE = Symbol("unreadable");

/**
 * The .fig at `path` as it stands, or undefined when there is none: mtime and size, the pair fromDisk also keys its
 * decode by, since a replacement written within the mtime granularity carries the old time. Only a write changes
 * either, so two readings that differ are two files and the second was written between them - which is what the
 * cross-process rule below needs, and it takes no clock to say it.
 *
 * Any error but ENOENT is UNREADABLE rather than "no file": ESTALE on a shared cache whose server restarted, EIO,
 * the EPERM Windows answers for a file whose delete is still pending (this repo's own windows-latest run
 * 35874343135 logged one on a cache-shaped temporary path). A failed reading read as "nothing was there" makes
 * whatever stands there next look newer than it, which is the one direction that answers a refresh with an export
 * older than it.
 */
function asSeen(path: string): string | undefined | typeof UNREADABLE {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch (e) {
    return (e as NodeJS.ErrnoException | null)?.code === "ENOENT" ? undefined : UNREADABLE;
  }
}

/** A .fig is at `path` and is not the one the reading `seen` stands for, so it was written after that reading. */
function wroteSince(path: string, seen: string | undefined) {
  const now = asSeen(path);
  // A reading that failed is not a file, so it is not a write either: only a string is one.
  return typeof now === "string" && now !== seen;
}

/** What waiting for the other processes on this cache established; see awaitOtherExport. */
interface Floor {
  /** Whether an instant was reached at which no export that may be older than the refresh was still running. */
  reached: boolean;
  /** The .fig as it stood at that instant (see asSeen), undefined when there was none: the bar a newer one clears. */
  file: string | undefined;
}

/** The floor a reading of `path` sets. One that could not be taken bars nothing, so no instant was established. */
function floorAt(path: string): Floor {
  const file = asSeen(path);
  return file === UNREADABLE ? { reached: false, file: undefined } : { reached: true, file };
}

/**
 * What the store asks of the browser side, and only on the way to an export (see load): a local .fig, or a snapshot
 * fresh enough to answer, asks nothing of it.
 */
type Exporter = Pick<FigmaWeb, "saveLocalCopy"> & {
  /** This load found no snapshot to answer from and may export; it has yet to wait for another process's export. */
  mayExport?(): void;
};

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

  private web: Exporter;
  readonly dir: string;
  private maxAgeMs: number;
  private maxDocs: number;
  private otherExportWaitMs: number;

  /**
   * `otherExportWaitMs` is a parameter only so that a test can reach the ceiling: what it leaves behind is an
   * export still running that this one has to answer around, and no test can wait out the ten real minutes.
   */
  constructor(web: Exporter, dir: string, maxAgeMs: number, maxDocs = 4, otherExportWaitMs = OTHER_EXPORT_WAIT_MS) {
    this.web = web;
    this.dir = dir;
    this.maxAgeMs = maxAgeMs;
    this.maxDocs = maxDocs;
    this.otherExportWaitMs = otherExportWaitMs;
  }

  figPath(fileKey: string) {
    return join(this.dir, `${fileKey}.fig`);
  }

  /**
   * The snapshot the key's latest export replaced, kept for figma_diff: exactly one per key, so each export that
   * replaces a snapshot replaces this one too (see keepPrevious). A key is letters and digits only, so this name is
   * never another key's figPath; it is not the shape cleanStaleDownloads sweeps either.
   */
  previousPath(fileKey: string) {
    return join(this.dir, `${fileKey}.previous.fig`);
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
   *
   * A snapshot of ours goes by two names: its key, and its path, which getLocal keeps under the real path. Reading by
   * key and then by that path is how a task pins itself to one snapshot, and it decoded the same file twice and kept
   * both. Under either name, a document kept under the other is that same file when its stamp agrees. Which name the
   * caller used still decides how the answer is dated (open in tools.ts), and both read the one file time.
   */
  private fromDisk(fileKey: string, path: string): FigDocument {
    const st = statSync(path);
    const stamp = `${st.mtimeMs}:${st.size}`;
    for (const name of [fileKey, this.otherName(fileKey, path)]) {
      const cached = name === undefined ? undefined : this.docs.get(name);
      if (cached && this.stamps.get(cached) === stamp) return this.remember(cached);
    }
    const doc = FigDocument.fromFile(fileKey, path, st.mtime);
    this.stamps.set(doc, stamp);
    return this.remember(doc);
  }

  /**
   * The name fromDisk's other reading of the same file is kept under: the real path of a key's snapshot, or the key
   * of a real path that is a snapshot here (<dir>/<key>.fig). A spelling this cannot resolve only costs a decode.
   */
  private otherName(fileKey: string, path: string): string | undefined {
    try {
      if (fileKey !== path) return realpathSync(path);
      return path.endsWith(".fig") && dirname(path) === realpathSync(this.dir) ? basename(path, ".fig") : undefined;
    } catch {
      return undefined;
    }
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
    return exportLeases(this.dir, fileKey);
  }

  /**
   * Wait while other processes export this key, and report the .fig the file on disk must differ from for the export
   * that wrote it to have provably begun after `since`; undefined when no other export was running. Leases of
   * processes that died are dropped by liveLeases, so a crashed holder costs one poll interval rather than the whole
   * wait - or, for a holder in another pid namespace, the silence its own stamp asks to be waited out (a minute),
   * paid once, since its lease is gone for every later refresh too.
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
    const deadline = Date.now() + this.otherExportWaitMs;
    // Each lease is dated once, the first time it is seen: a clock that stepped back is only visible while this
    // process's clock has not yet passed the stamp it left behind, so re-dating the same name later lets it through.
    const dated = new Map<string, boolean>();
    let live = liveLeases(leases);
    // The file is read after that first poll and not before it: an export older than `since` whose lease was already
    // gone had written the file by then, so this reading holds its work and no later one is taken for someone else's.
    let floor = floorAt(path);
    let older = false;
    for (; live.length; live = liveLeases(leases)) {
      // The ceiling is reached with an export still running, so whatever it writes from here on is unattributable.
      if (Date.now() > deadline) return { reached: false, file: undefined };
      for (const name of live) if (!dated.has(name)) dated.set(name, beganBefore(name, since));
      if (live.some((name) => dated.get(name))) older = true;
      else if (older) {
        // Every export older than `since` has gone since the last poll, so it had written the file by now.
        floor = floorAt(path);
        older = false;
      }
      await sleep(LEASE_POLL_MS);
    }
    return dated.size ? (older ? floorAt(path) : floor) : undefined;
  }

  private async load(fileKey: string, refresh: boolean): Promise<FigDocument> {
    const path = this.figPath(fileKey);
    // Every caller this load answers asked before it began, so an export beginning after this point answers them
    // all: the same instant `started` marks in get, written down as a clock for the processes that cannot see it.
    const since = Date.now();
    const fresh = () => existsSync(path) && Date.now() - statSync(path).mtimeMs < this.maxAgeMs;
    if (!refresh && fresh()) return this.fromDisk(fileKey, path);
    // Said before the wait below, not when this load's own export begins: whatever the exporter readies for one has
    // to be in place by the time the export waited for ends (tools.ts says why).
    this.web.mayExport?.();
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
    const tag = Math.random().toString(36).slice(2, 8);
    // A write into this cache that this process may not make, said in words (see cannotWrite).
    const unkept = (e: unknown) =>
      cannotWrite(e, `exporting ${fileKey} saves its snapshot in figma-reader's cache,`, this.dir, "Run it where that directory is writable, or set FIGMA_READER_CACHE to a directory that is.");
    let lease: string;
    try {
      // Made by the first export rather than by the store: a process that only reads local files or fresh snapshots
      // writes nothing here, which is all a read-only sandbox lets it do.
      mkdirSync(this.dir, { recursive: true });
      lease = takeLease(this.leaseDir(fileKey), `${process.pid}-${Date.now()}-${tag}`);
    } catch (e) {
      throw unkept(e);
    }
    // Export onto a name no other process writes, and swap that onto the snapshot; reading the snapshot back read
    // whatever stood there. Every process on this cache renames its own export onto the one path, and one landing
    // between this export's rename and that read answered with a file this process had not exported - 39 answers
    // in 40 with another process renaming continuously, and the answer above is the export that was still running
    // when the wait gave up on it, which is the pre-refresh one. The name is the shape moveDownload gives a copy
    // beside the snapshot, so cleanStaleDownloads sweeps one left behind by a crash between the export and the swap;
    // it carries the lease's pid and tag, which is what keeps that sweep off it while this export runs (see
    // stagedByLiveOwner).
    const mine = `${path}.${process.pid}.${tag}.tmp`;
    try {
      // Made empty before the browser is asked for anything, and the export is moved onto it. A cache directory that
      // already stands is not written by mkdir, and a lease directory that takes the lease says nothing of the one the
      // snapshot goes in: one that took no file was found only by the move, after the whole export.
      writeFileSync(mine, "", { flag: "wx" });
      await this.web.saveLocalCopy(fileKey, mine);
      const st = statSync(mine);
      // exportedAt comes from the file's mtime, as for a snapshot read back later, so both agree on its age. The
      // rename carries that mtime and size onto the snapshot, which is the reading fromDisk keys its decode by, so
      // reading the snapshot back finds this document rather than decoding the same bytes again.
      const doc = FigDocument.fromFile(fileKey, mine, st.mtime);
      this.stamps.set(doc, `${st.mtimeMs}:${st.size}`);
      // Only an export that decoded gets this far, so one that failed leaves the snapshot and the previous one alone.
      await this.underPublishLock(fileKey, () => this.publish(fileKey, mine, tag));
      return this.remember(doc);
    } catch (e) {
      // From here on a failed write may be the browser's or the download directory's, each worded where it happens:
      // only one whose path is in this directory is this cache's.
      const { path: at, dest } = (e ?? {}) as { path?: unknown; dest?: unknown };
      throw [dest, at].some((p) => typeof p === "string" && dirname(p) === this.dir) ? unkept(e) : e;
    } finally {
      // The lease goes only once the export it announces has written the file, which is what lets another process
      // read the lease being gone as that export's work being on disk.
      dropLease(lease);
      // In a directory that stopped taking writes this throws too, and would stand in for the error that said so: the
      // file is left to a later sweep instead.
      try {
        rmSync(mine, { force: true });
      } catch {}
    }
  }

  /**
   * Swap this export onto the snapshot, keeping the one it replaces as the key's previous snapshot. Always under the
   * key's publish lock (see underPublishLock).
   *
   * The snapshot being replaced is given a second name rather than moved: a hard link to the file at figPath, which
   * the export then renames over as it always has. Moving it first would leave the snapshot path empty until that
   * rename, and every reading of it above relies on there being a file: a process finding none there would export
   * again, take "no file" as the floor a refresh is judged by, or fail a decode it had just stat'ed for. The link
   * costs no copy and carries the old export's mtime, which is what dates the previous snapshot.
   *
   * The link becomes previousPath only once the export is the snapshot. The other order lost the history it was
   * there to keep: a rename onto the snapshot that failed (Windows refuses to replace a file another process has open)
   * left the old previous replaced by the snapshot that was still current, so the two were one file and the older
   * one was gone. Now a failed swap changes neither.
   *
   * Best effort past the swap: an export is never failed for its history. Without hard links (FAT, some network
   * mounts) nothing is kept; where the old previous cannot be replaced it stays as it was, older than it should be but
   * dated by its own time, which figma_diff reports. The staging name is the shape cleanStaleDownloads sweeps, for a
   * crash in between, with the export's pid and tag, so its lease keeps the sweep off it until then.
   */
  private publish(fileKey: string, mine: string, tag: string) {
    const staged = `${this.previousPath(fileKey)}.${process.pid}.${tag}.tmp`;
    let kept = false;
    try {
      try {
        linkSync(this.figPath(fileKey), staged);
        kept = true;
      } catch {
        // ENOENT is the first export of a key, which has nothing to keep.
      }
      renameSync(mine, this.figPath(fileKey));
      if (kept) {
        try {
          renameSync(staged, this.previousPath(fileKey));
        } catch {}
      }
    } finally {
      rmSync(staged, { force: true });
    }
  }

  /**
   * The previous snapshot of a key whose current snapshot is `current`, or undefined when none was kept. The two are
   * read as one generation: under the publish lock both files are given private names, so no export can publish
   * between the two readings and pair a previous snapshot with a current one that did not replace it. If an export
   * has published since `current` was read, this throws rather than answer about a pair nobody asked about; so it
   * does for a previous snapshot that is the current one, which no export here leaves behind, since a diff of the two
   * would report no change at all.
   *
   * Where no link can be made because this process may not write the cache (a read-only sandbox, a mount it can only
   * read), the pair is read in place instead (see previousInPlace): a key whose snapshot is fresh is answered without
   * writing anything (see load), and diff previous is such an answer. So it is where the lease that keeps a sweep off
   * the links cannot be taken, even in a cache that would take the links: a link without it is a file another
   * process's sweep may delete while it is being read.
   */
  async previousOf(fileKey: string, current: FigDocument): Promise<FigDocument | undefined> {
    const tag = Math.random().toString(36).slice(2, 8);
    // The shape cleanStaleDownloads sweeps, for a crash before they are removed below. A link carries the mtime of the
    // snapshot it names, older than any sweep, so this lease, taken before the first link and given up once the last
    // is gone, is what keeps a sweep in another process off them while they are read (see stagedByLiveOwner).
    const now = `${this.figPath(fileKey)}.${process.pid}.${tag}.tmp`;
    const was = `${this.previousPath(fileKey)}.${process.pid}.${tag}.tmp`;
    let lease: string;
    try {
      lease = takeLease(readerLeases(this.dir, fileKey), `${process.pid}-${Date.now()}-${tag}`);
    } catch (e) {
      // No lease, no links.
      if (mayNotWrite(e)) return this.previousInPlace(fileKey, current);
      throw e;
    }
    try {
      const kept = await this.underPublishLock(fileKey, () => {
        try {
          linkSync(this.previousPath(fileKey), was);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return "none";
          if (mayNotWrite(e)) return "unwritable";
          throw e;
        }
        try {
          linkSync(this.figPath(fileKey), now);
        } catch {
          // No snapshot to pair it with: the reading below then differs from current's, which says so.
        }
        return "linked";
      });
      if (kept === "none") return undefined;
      if (kept === "unwritable") return this.previousInPlace(fileKey, current);
      const seen = asSeen(now);
      if (seen !== this.stamps.get(current)) {
        throw new Error(`the snapshot of ${fileKey} changed while it was being read (another export replaced it, or it was removed); ask again`);
      }
      if (asSeen(was) === seen) {
        throw new Error(`the previous snapshot of ${fileKey} is the same file as its current one, so a diff of the two could only report no change`);
      }
      return this.fromDisk(this.previousPath(fileKey), was);
    } finally {
      rmSync(now, { force: true });
      rmSync(was, { force: true });
      dropLease(lease);
    }
  }

  /**
   * previousOf for a cache this process can read but not write, so that neither file can be given a private name. The
   * pair is read where it stands and judged by its readings: the snapshot must be `current` before the previous one
   * is decoded and after, the previous one must be the same file across its decode, and no publish may be under way
   * at either reading. A publish swaps the snapshot before it renames the previous one, under the lock, so between
   * its two renames the lock is held; a publish that finished in between moved the snapshot. Either is refused, as
   * previousOf refuses a pair another export came between.
   */
  private previousInPlace(fileKey: string, current: FigDocument): FigDocument | undefined {
    const path = this.previousPath(fileKey);
    const changed = () => new Error(`the snapshot of ${fileKey} changed while it was being read (another export replaced it, or it was removed); ask again`);
    const settled = () => !liveLeases(this.publishLock(fileKey)).length && asSeen(this.figPath(fileKey)) === this.stamps.get(current);
    const was = asSeen(path);
    if (was === undefined) return undefined;
    if (!settled()) throw changed();
    if (was === this.stamps.get(current)) {
      throw new Error(`the previous snapshot of ${fileKey} is the same file as its current one, so a diff of the two could only report no change`);
    }
    const prev = this.fromDisk(path, path);
    if (!settled() || asSeen(path) !== was || this.stamps.get(prev) !== was) throw changed();
    return prev;
  }

  /** Where the process holding the key's publish lock names itself (see underPublishLock). */
  private publishLock(fileKey: string) {
    return join(this.dir, "exports", `${fileKey}.publish`);
  }

  /**
   * Run `step`, a few file operations, while holding the key's publish lock: every change to the pair of snapshot
   * and previous snapshot, and every reading of the pair, goes through it. The export lease cannot be that: it says
   * an export is under way, and two processes can each find none and both export (see awaitOtherExport), or one can
   * reach the ceiling and export beside the other. Interleaved by injection, two publishes left a previous snapshot
   * that the current one never replaced - export B linked and swapped between export A's link and A's swap, so A kept
   * the snapshot B had replaced and B's was in neither name - and a diff reading the pair while an export published
   * compared a snapshot with itself and reported nothing changed.
   *
   * The lock is a directory holding one lease, as liveLeases reads one, moved into place whole by a rename: renaming
   * a directory fails where a directory that is not empty stands, so whoever's rename lands holds it, and nobody
   * holds it without having said who. A holder that died there has its lease dropped by liveLeases by the same rules
   * as an export lease (at once by pid; by its silence, for one in another pid namespace), and the empty directory it
   * leaves is removed: POSIX renames over an empty directory, Windows does not, and rmdir takes only an empty one, so
   * a holder that has just moved its own into place keeps it.
   *
   * Waiting has the export wait's ceiling, past which the step runs without the lock, as every publish did before
   * there was one; so does a lock that cannot be taken at all, since that is no reason to fail an export.
   */
  private async underPublishLock<T>(fileKey: string, step: () => T): Promise<T> {
    const lock = this.publishLock(fileKey);
    const tag = Math.random().toString(36).slice(2, 8);
    const name = `${process.pid}-${tag}`;
    const staged = `${lock}.${process.pid}.${tag}`;
    const deadline = Date.now() + this.otherExportWaitMs;
    let held = false;
    for (let missing = 0; ; ) {
      // Whether this process could stage a lock of its own at all, which a cache it may only read refuses.
      let staging = false;
      try {
        mkdirSync(staged, { recursive: true });
        writeFileSync(join(staged, name), processStamp(process.pid));
        staging = true;
        renameSync(staged, lock);
        held = true;
        break;
      } catch {
        rmSync(staged, { recursive: true, force: true });
      }
      if (!existsSync(lock)) {
        // Nothing stood in the way, so the lock cannot be taken here at all; a lock released at that instant is the
        // other way to get here, and that does not happen twice running.
        if (++missing > 1) break;
        continue;
      }
      missing = 0;
      if (Date.now() > deadline) break;
      if (!liveLeases(lock).length) {
        try {
          rmdirSync(lock);
          continue;
        } catch {}
        // Held by nobody, and this process can neither clear it nor stage one of its own (a read-only cache): it goes
        // ahead without, as where no lock can be taken at all, rather than wait out the ceiling for a holder long gone.
        if (!staging) break;
      }
      await sleep(PUBLISH_POLL_MS);
    }
    try {
      return step();
    } finally {
      if (held) {
        rmSync(join(lock, name), { force: true });
        try {
          rmdirSync(lock);
        } catch {}
      }
    }
  }

  /** Keep a document, as the most recently used: when over maxDocs, the least recently used is dropped. */
  private remember(doc: FigDocument) {
    this.docs.delete(doc.fileKey);
    this.docs.set(doc.fileKey, doc);
    while (this.docs.size > this.maxDocs) this.docs.delete(this.docs.keys().next().value!);
    return doc;
  }
}
