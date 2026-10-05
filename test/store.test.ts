// The snapshot cache decides when a tool call pays for a browser export (up to a minute) and when it may serve an
// older copy, so each rule is pinned against a fake exporter that counts its calls.
import { after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { LEASE_BEAT_MS, pidNamespace, processStamp, takeLease } from "../src/browser.ts";
import { FigDocument } from "../src/fig-file.ts";
import { cleanStaleDownloads, type FigmaWeb } from "../src/figma-web.ts";
import { LEASE_POLL_MS, SnapshotStore } from "../src/store.ts";
import { figBytes } from "./fixtures.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "figma-reader-test-"));
  dirs.push(d);
  return d;
};

/** A .fig whose single page is named after the export that wrote it, so tests can tell snapshots apart. */
const fig = (label: string) => figBytes([{ id: "0:1", type: "CANVAS", parent: "0:0", name: label }]);
const label = (doc: { pages(): { name: string }[] }) => doc.pages()[0].name;
/** The label of the key's previous snapshot, read straight from its file. */
const prevLabel = (store: SnapshotStore, key = "K") => label(FigDocument.fromFile(key, store.previousPath(key), new Date()));

/**
 * Fake exporter: export n writes a file labelled "<tag> n"; `hold` keeps exports pending until released. The tag is
 * what tells two of these apart when they stand for two processes writing the same .fig.
 */
function exporter(tag = "export") {
  const calls: string[] = [];
  let gate: Promise<void> | undefined;
  let open = () => {};
  const web = {
    async saveLocalCopy(fileKey: string, path: string) {
      calls.push(fileKey);
      const n = calls.length;
      if (gate) await gate;
      if (fileKey === "BROKEN") throw new Error("export failed");
      writeFileSync(path, fig(`${tag} ${n}`));
    },
  };
  return {
    web: web as unknown as FigmaWeb,
    calls,
    hold() {
      gate = new Promise((r) => (open = r));
    },
    release() {
      gate = undefined;
      open();
    },
  };
}

const HOUR = 3_600_000;

/** Wait until n exports have started. Bounded: a regression that starts none used to spin here until CI was killed. */
const exportsStarted = async (x: { calls: string[] }, n: number) => {
  const deadline = Date.now() + 5_000;
  while (x.calls.length < n) {
    if (Date.now() > deadline) throw new Error(`only ${x.calls.length} of ${n} exports started within 5s`);
    await new Promise((r) => setImmediate(r));
  }
};

describe("SnapshotStore.get", () => {
  it("exports a missing file once, however many calls ask for it at the same time", async () => {
    const x = exporter();
    const store = new SnapshotStore(x.web, tempDir(), HOUR);
    const [a, b] = await Promise.all([store.get("K"), store.get("K")]);
    assert.equal(a, b);
    assert.deepEqual(x.calls, ["K"]);
    assert.equal(label(a), "export 1");
  });

  it("makes its directory with the first export into it, and not before", async () => {
    // A process that only reads local files writes nothing, which is what lets it run in a read-only sandbox.
    const x = exporter();
    const dir = join(tempDir(), "cache");
    const local = join(tempDir(), "local.fig");
    writeFileSync(local, fig("local"));
    const store = new SnapshotStore(x.web, dir, HOUR);
    assert.equal(label(await store.getLocal(local)), "local");
    assert.equal(store.peek("K"), undefined);
    assert.ok(!existsSync(dir), "made by a store that had only read");
    assert.equal(label(await store.get("K")), "export 1");
    assert.ok(existsSync(store.figPath("K")));
  });

  it("serves a snapshot younger than the max age without exporting, decoded once", async () => {
    const x = exporter();
    const dir = tempDir();
    writeFileSync(join(dir, "K.fig"), fig("on disk"));
    const store = new SnapshotStore(x.web, dir, HOUR);
    const first = await store.get("K");
    assert.equal(label(first), "on disk");
    assert.equal(await store.get("K"), first);
    assert.deepEqual(x.calls, []);
  });

  it("re-exports a snapshot older than the max age, and on refresh", async () => {
    const x = exporter();
    const dir = tempDir();
    writeFileSync(join(dir, "K.fig"), fig("old"));
    // Older than the max age but not twice as old: a window even slightly wider serves this file instead of exporting.
    const old = new Date(Date.now() - 1.5 * HOUR);
    utimesSync(join(dir, "K.fig"), old, old);
    const store = new SnapshotStore(x.web, dir, HOUR);
    assert.equal(label(await store.get("K")), "export 1");
    assert.equal(label(await store.get("K", true)), "export 2");
    assert.equal(label(await store.get("K")), "export 2");
  });

  it("answers a refresh that arrives during a normal load with a new export, not that load's result", async () => {
    const x = exporter();
    const store = new SnapshotStore(x.web, tempDir(), HOUR);
    x.hold();
    const normal = store.get("K");
    const refreshed = store.get("K", true);
    const again = store.get("K", true);
    assert.deepEqual(x.calls, [], "no export has begun yet");
    x.release();
    assert.equal(label(await normal), "export 1");
    assert.equal(label(await refreshed), "export 2");
    // Refreshes that overlap before any export of theirs begins share it: it begins after both of them asked, which
    // is all either one requires. This is the burst of tool calls an agent makes in one turn, and why a refresh is
    // not simply an export of its own.
    assert.equal(await again, await refreshed);
    assert.deepEqual(x.calls, ["K", "K"]);
  });

  it("does not answer a refresh with an export that had already begun when it asked", async () => {
    const x = exporter();
    const store = new SnapshotStore(x.web, tempDir(), HOUR);
    x.hold();
    const first = store.get("K", true);
    await exportsStarted(x, 1);
    // Whatever the user changed in Figma since export 1 began is not in it, so answering with it would report
    // pre-edit data as fresh, which is indistinguishable from the model making it up.
    const second = store.get("K", true);
    x.release();
    assert.equal(label(await first), "export 1");
    assert.equal(label(await second), "export 2");
    assert.deepEqual(x.calls, ["K", "K"]);
  });

  it("lets a refresh share a queued export that has not begun, however long it has been queued", async () => {
    const x = exporter();
    const store = new SnapshotStore(x.web, tempDir(), HOUR);
    x.hold();
    const normal = store.get("K");
    await exportsStarted(x, 1);
    // export 2 is queued behind export 1, which began before this call: this one gets the queued export, and so may
    // anyone asking later still, since it has not begun for them either.
    const queued = store.get("K", true);
    await new Promise((r) => setImmediate(r));
    const later = store.get("K", true);
    x.release();
    assert.equal(label(await normal), "export 1");
    assert.equal(await later, await queued);
    assert.equal(label(await queued), "export 2");
    assert.deepEqual(x.calls, ["K", "K"]);
  });

  it("does not answer a refresh with a queued export that had begun by the time it asked", async () => {
    const x = exporter();
    const store = new SnapshotStore(x.web, tempDir(), HOUR);
    x.hold();
    const normal = store.get("K");
    const first = store.get("K", true);
    await exportsStarted(x, 1);
    x.release();
    x.hold(); // export 1 already waits on the released gate; export 2 will wait on this one
    assert.equal(label(await normal), "export 1");
    await exportsStarted(x, 2);
    const second = store.get("K", true);
    x.release();
    assert.equal(label(await first), "export 2");
    assert.equal(label(await second), "export 3", "queued behind export 2, which began first");
    assert.deepEqual(x.calls, ["K", "K", "K"]);
  });

  it("serves the newer snapshot another process wrote to the shared cache, dated by its file", async () => {
    const x = exporter();
    const dir = tempDir();
    const store = new SnapshotStore(x.web, dir, HOUR);
    const exported = await store.get("K");
    assert.equal(exported.exportedAt.getTime(), statSync(join(dir, "K.fig")).mtime.getTime());
    writeFileSync(join(dir, "K.fig"), fig("other process"));
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, "K.fig"), later, later);
    assert.equal(label(await store.get("K")), "other process");
    assert.equal(label(store.peek("K")!), "other process");
    assert.deepEqual(x.calls, ["K"]);
  });

  it("lets a normal call share an in-flight refresh", async () => {
    const x = exporter();
    const store = new SnapshotStore(x.web, tempDir(), HOUR);
    x.hold();
    const refreshed = store.get("K", true);
    const normal = store.get("K");
    x.release();
    assert.equal(await normal, await refreshed);
    assert.deepEqual(x.calls, ["K"]);
  });

  it("lets a normal call share an export that had already begun, which only a refresh refuses", async () => {
    const x = exporter();
    // A max age of 0 is the setting that says "export every time", and the only one that tells sharing the export
    // apart from reading back the file it had just written, which looks the same from here.
    const store = new SnapshotStore(x.web, tempDir(), 0);
    x.hold();
    const refreshed = store.get("K", true);
    await exportsStarted(x, 1);
    const normal = store.get("K");
    x.release();
    assert.equal(await normal, await refreshed);
    assert.deepEqual(x.calls, ["K"], "a plain load takes any snapshot, and this one is being made now");
  });

  it("does not remember a failed export", async () => {
    const x = exporter();
    const store = new SnapshotStore(x.web, tempDir(), HOUR);
    await assert.rejects(store.get("BROKEN"), /export failed/);
    await assert.rejects(store.get("BROKEN"), /export failed/);
    assert.deepEqual(x.calls, ["BROKEN", "BROKEN"]);
  });

  it("keeps only the most recent documents in memory, re-reading others from disk without exporting", async () => {
    const x = exporter();
    const store = new SnapshotStore(x.web, tempDir(), HOUR, 2);
    const a = await store.get("A");
    const first = await store.get("B");
    assert.equal(await store.get("A"), a, "A is still in memory");
    await store.get("C"); // evicts B, the least recently used
    assert.equal(await store.get("A"), a);
    const b = await store.get("B");
    // Only identity tells a re-decode from a memory hit: the label is "export 2" either way, so asserting it alone
    // passed with the eviction deleted, and with room for one more document.
    assert.notEqual(b, first, "B was dropped from memory");
    assert.equal(label(b), "export 2", "and decoded again from its own file");
    assert.deepEqual(x.calls, ["A", "B", "C"]);
  });
});

// Two stores on one cache dir stand for two server or CLI processes on the same account: they export a key to the
// same .fig, so exporting it twice at once both wastes a browser export (a minute, on one shared browser) and settles
// the snapshot by whichever of them renamed last. The lease each export announces itself with is the same kind the
// download directory uses, and carries the time the export began, which is what the refresh rule needs across
// processes: waiting for an export is not the same as being allowed to use it.
describe("SnapshotStore between processes", () => {
  it("waits for another process's export of the same key instead of starting a second one", async () => {
    const a = exporter("a"), b = exporter("b");
    const dir = tempDir();
    a.hold();
    const first = new SnapshotStore(a.web, dir, HOUR).get("K", true);
    await exportsStarted(a, 1);
    // Nothing is on disk yet, so without the wait this load has no answer but an export of its own.
    const second = new SnapshotStore(b.web, dir, HOUR).get("K");
    await new Promise((r) => setTimeout(r, 3 * LEASE_POLL_MS));
    a.release();
    assert.equal(label(await first), "a 1");
    assert.equal(label(await second), "a 1");
    assert.deepEqual(b.calls, [], "a plain load takes the snapshot the other process was already making");
  });

  it("does not let another process's running export answer a refresh asked after it began", async () => {
    const a = exporter("a"), b = exporter("b");
    const dir = tempDir();
    a.hold();
    const first = new SnapshotStore(a.web, dir, HOUR).get("K", true);
    await exportsStarted(a, 1);
    const second = new SnapshotStore(b.web, dir, HOUR).get("K", true);
    // Long enough that an export of its own would have started by now: it is queued behind the other one instead.
    await new Promise((r) => setTimeout(r, 3 * LEASE_POLL_MS));
    assert.deepEqual(b.calls, [], "not exporting alongside the other process");
    a.release();
    assert.equal(label(await first), "a 1");
    assert.equal(label(await second), "b 1", "its own export, begun after it asked");
    assert.deepEqual(b.calls, ["K"]);
  });

  it("says that it may export before it waits for another process's export, and never when a snapshot answers", async () => {
    // tools.ts registers with the browser when it hears this. Heard only once this load's own export began, the
    // process it waited for could be the browser's last client and close it on the way out, just as this one needs it.
    const a = exporter("a"), b = exporter("b");
    const dir = tempDir();
    let said = 0;
    const store = new SnapshotStore({ saveLocalCopy: b.web.saveLocalCopy, mayExport: () => void said++ }, dir, HOUR);
    a.hold();
    const first = new SnapshotStore(a.web, dir, HOUR).get("K", true);
    await exportsStarted(a, 1);
    const second = store.get("K", true);
    await new Promise((r) => setTimeout(r, 3 * LEASE_POLL_MS));
    assert.deepEqual([said, b.calls.length], [1, 0], "said so while it was still waiting");
    a.release();
    await first;
    assert.equal(label(await second), "b 1");
    // A snapshot fresh enough to answer, and a local file, ask nothing of the browser.
    assert.equal(await store.get("K"), await second);
    const local = join(tempDir(), "local.fig");
    writeFileSync(local, fig("local"));
    await store.getLocal(local);
    assert.equal(said, 1);
  });

  // A lease of this process's own pid, stamped as this process, is exactly what liveLeases reads as a live holder:
  // it stands for another process exporting the key, with the time in its name written by that process's clock.
  const holder = (dir: string, began: number, tag: string) => takeLease(join(dir, "exports", "K"), `${process.pid}-${began}-${tag}`);
  const polls = (n: number) => new Promise((r) => setTimeout(r, n * LEASE_POLL_MS));
  /**
   * Wait until the store's wait has read the lease directory once more. liveLeases deletes a lease whose process is
   * not the one that stamped it and never reports it as live, so a lease planted under pid 1 is a probe that poll
   * removes and the rule under test never sees. What a poll does with the leases it read happens before it sleeps,
   * so the probe being gone means that too. The waits below can then be sequenced against the store's polls rather
   * than against the clock: one poll landing on the wrong side of a lease being dropped is the whole difference
   * between these rules, and a sleep of n intervals is what slips on a loaded runner.
   */
  const polled = async (dir: string) => {
    const leases = join(dir, "exports", "K");
    const probe = join(leases, `1-${Date.now()}-probe`);
    mkdirSync(leases, { recursive: true });
    // Planted by rename, because writeFileSync creates the file and then writes it: a poll landing in between read
    // an empty stamp, which liveLeases reads as a live holder and never removes, so this waited out its 5 s while
    // the store's own wait waited for a lease that was never going away - a 30 s timeout instead of an assertion.
    // The staging name is outside the lease directory, where a poll would judge it a lease and delete it.
    const staged = join(dir, "exports", "probe.tmp");
    writeFileSync(staged, processStamp(process.pid));
    renameSync(staged, probe);
    const deadline = Date.now() + 5_000;
    while (existsSync(probe)) {
      if (Date.now() > deadline) throw new Error("the store did not poll for leases within 5s");
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  /**
   * The same stamp as written by a process whose pids are numbered in another pid namespace (see processStamp),
   * declaring `beat` as the period it touches its lease with. The real period is five seconds and the silence that
   * buries a holder is twelve of them, which no test can sit through; a small one changes how long that silence
   * has to last and nothing else about the rule.
   */
  const inAnotherNamespace = (stamp: string, beat = LEASE_BEAT_MS) => {
    const [first, second] = stamp.split("|");
    const ns = Number(pidNamespace() ?? 0) + 1;
    return `${second === undefined ? `|${first}` : `${first}|${second}`}|${ns}|${beat}`;
  };

  /** A lease of a holder in another namespace, as a container exporting this key leaves one. */
  const foreignHolder = (dir: string, tag: string, beat?: number) => {
    const leases = join(dir, "exports", "K");
    mkdirSync(leases, { recursive: true });
    const lease = join(leases, `1-${Date.now()}-${tag}`);
    writeFileSync(lease, inAnotherNamespace(processStamp(process.pid), beat));
    return lease;
  };

  /** One beat of a holder that is still there, as its own timer sends it (see beatLeases). */
  const beat = (lease: string) => {
    const now = new Date();
    utimesSync(lease, now, now);
  };

  /**
   * The error statSync gives for a path it cannot read for a reason other than there being no file, or undefined
   * where this platform offers none. The real ones cannot be arranged here - ESTALE on a shared cache whose server
   * restarted, EIO, the EPERM Windows answers while a delete is pending - so the stand-in is a link that points at
   * itself, which an unprivileged Windows process may not be allowed to make.
   */
  const UNREADABLE_CODE = (() => {
    const path = join(tempDir(), "K.fig");
    try {
      symlinkSync(basename(path), path);
    } catch {
      return undefined;
    }
    try {
      statSync(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === "ENOENT" ? undefined : code;
    }
    return undefined;
  })();

  it("does not answer a refresh with an export whose lease is stamped after the refresh by a clock that stepped back", async () => {
    const x = exporter();
    const dir = tempDir();
    // chrony's makestep, a resumed VM or date -s between the other process's takeLease and this read: the export
    // began before the refresh was asked for, and its lease says it began a minute after.
    const lease = holder(dir, Date.now() + 60_000, "skew");
    const store = new SnapshotStore(x.web, dir, HOUR);
    const refreshed = store.get("K", true);
    await polled(dir);
    writeFileSync(join(dir, "K.fig"), fig("pre-refresh"));
    rmSync(lease, { force: true });
    // Serving that file would report what Figma held before the edit as fresh, which is the whole point of the rule.
    assert.equal(label(await refreshed), "export 1");
    assert.deepEqual(x.calls, ["K"]);
  });

  it("does not let the clock catch up with a lease stamped just ahead of it while its export is still running", async () => {
    const x = exporter();
    const dir = tempDir();
    // A step back smaller than the export leaves a stamp this process's clock passes within a poll or two; re-dating
    // the lease then makes the same pre-refresh export look like one that began afterwards. One poll, so that the
    // lease is first read while the clock is still behind its stamp, then the clock passing it, then another poll.
    const lease = holder(dir, Date.now() + LEASE_POLL_MS, "small-skew");
    const store = new SnapshotStore(x.web, dir, HOUR);
    const refreshed = store.get("K", true);
    await polls(2);
    await polled(dir);
    writeFileSync(join(dir, "K.fig"), fig("pre-refresh"));
    rmSync(lease, { force: true });
    assert.equal(label(await refreshed), "export 1");
    assert.deepEqual(x.calls, ["K"]);
  });

  it("counts an export whose lease name carries no time at all as one that may have begun earlier", async () => {
    // Leases are named by whichever build of this server took them, and a differently-versioned process sharing the
    // cache may name them some other way; a name this build cannot date says nothing about when that export began.
    // Reading it as one that began after the refresh is what serves the pre-edit file; reading it as possibly older
    // costs an export.
    const x = exporter();
    const dir = tempDir();
    const lease = takeLease(join(dir, "exports", "K"), `${process.pid}-oldbuild`);
    const store = new SnapshotStore(x.web, dir, HOUR);
    const refreshed = store.get("K", true);
    await polled(dir);
    writeFileSync(join(dir, "K.fig"), fig("pre-refresh"));
    rmSync(lease, { force: true });
    assert.equal(label(await refreshed), "export 1");
    assert.deepEqual(x.calls, ["K"]);
  });

  it("answers a refresh with an export that began after it and outlived the one that had begun before", async () => {
    const x = exporter();
    const dir = tempDir();
    const older = holder(dir, Date.now(), "older");
    await polls(1);
    const store = new SnapshotStore(x.web, dir, HOUR);
    const refreshed = store.get("K", true);
    await polled(dir);
    // Two holders at once: both found no lease at the same instant. This one began after the refresh was asked for.
    const newer = holder(dir, Date.now(), "newer");
    await polled(dir);
    // A lease is dropped only once its export has written the file, so nothing written from here on is the older
    // export's, and this refresh can be answered without paying for an export of its own.
    rmSync(older, { force: true });
    await polled(dir);
    writeFileSync(join(dir, "K.fig"), fig("newer export"));
    rmSync(newer, { force: true });
    assert.equal(label(await refreshed), "newer export");
    assert.deepEqual(x.calls, [], "the wait bought an answer, not only serialization");
  });

  it("answers a refresh with an export that began after it whose file is dated behind this process's clock", async () => {
    const x = exporter();
    const dir = tempDir();
    const older = holder(dir, Date.now(), "older");
    await polls(1);
    const store = new SnapshotStore(x.web, dir, HOUR);
    const refreshed = store.get("K", true);
    await polled(dir);
    const newer = holder(dir, Date.now(), "newer");
    await polled(dir);
    rmSync(older, { force: true });
    await polled(dir);
    writeFileSync(join(dir, "K.fig"), fig("newer export"));
    // Nothing was on disk when the older export's lease went, so this file is the newer export's whatever time it
    // carries: a filesystem dating a write behind the reading of Date.now() that follows it is the same
    // disagreement as the one below, and a rule comparing the two times refused a file it could have answered with,
    // paying for an export of its own. The size of the skew is the machine's; it is written in here to be sure of.
    const behind = new Date(Date.now() - 1000);
    utimesSync(join(dir, "K.fig"), behind, behind);
    rmSync(newer, { force: true });
    assert.equal(label(await refreshed), "newer export");
    assert.deepEqual(x.calls, [], "the wait bought an answer, not only serialization");
  });

  it("does not answer a refresh with a file that was already on disk when the older export went", async () => {
    // The same two holders as above, in the other order: the file appears while the older export is still holding
    // its lease, so it may be that export's, and only what is written after the lease goes is provably not. The
    // instant the older holder was last seen is therefore the floor, not the instant the refresh was asked for -
    // which is the pre-edit export answering a re-read, the failure this whole mechanism exists for.
    const x = exporter();
    const dir = tempDir();
    const older = holder(dir, Date.now(), "older");
    await polls(1);
    const store = new SnapshotStore(x.web, dir, HOUR);
    const refreshed = store.get("K", true);
    await polled(dir);
    const newer = holder(dir, Date.now(), "newer");
    await polled(dir);
    writeFileSync(join(dir, "K.fig"), fig("older export"));
    await polled(dir);
    rmSync(older, { force: true });
    await polled(dir);
    rmSync(newer, { force: true });
    assert.equal(label(await refreshed), "export 1");
    assert.deepEqual(x.calls, ["K"], "one export of its own, the file on disk having answered nothing");
  });

  it("does not answer a refresh from two exports that were still running together", async () => {
    const x = exporter();
    const dir = tempDir();
    const older = holder(dir, Date.now(), "older");
    await polls(1);
    const store = new SnapshotStore(x.web, dir, HOUR);
    const refreshed = store.get("K", true);
    await polled(dir);
    const newer = holder(dir, Date.now(), "newer");
    await polled(dir);
    // Neither lease was dropped before the file appeared, so it may be the older export's, whichever renamed last.
    writeFileSync(join(dir, "K.fig"), fig("either export"));
    rmSync(older, { force: true });
    rmSync(newer, { force: true });
    assert.equal(label(await refreshed), "export 1");
    assert.deepEqual(x.calls, ["K"]);
  });

  it("does not answer a refresh from a file dated ahead of this process's clock by the one that wrote it", async () => {
    const x = exporter();
    const dir = tempDir();
    const older = holder(dir, Date.now(), "older");
    await polls(1);
    const store = new SnapshotStore(x.web, dir, HOUR);
    const refreshed = store.get("K", true);
    await polled(dir);
    const newer = holder(dir, Date.now(), "newer");
    await polled(dir);
    writeFileSync(join(dir, "K.fig"), fig("either export"));
    // The same two exports running together, and the file they leave dated by the filesystem's clock rather than by
    // this process's: on NTFS the first runs ahead of the second by up to a 15.6 ms timer tick, so a file already
    // written reads as newer than the instant both holders were last seen at. windows-latest served it to a refresh
    // about one run in four. The skew is written in rather than waited for, its size being the machine's, so that
    // what decides this is the rule and not the margin between two readings.
    const ahead = new Date(Date.now() + 1000);
    utimesSync(join(dir, "K.fig"), ahead, ahead);
    rmSync(older, { force: true });
    rmSync(newer, { force: true });
    assert.equal(label(await refreshed), "export 1");
    assert.deepEqual(x.calls, ["K"]);
  });

  it("ignores an export lease left behind by a process that is gone", async () => {
    const x = exporter();
    const dir = tempDir();
    // pid 1 is alive but is not the process this stamp was written by, which is how liveLeases tells the two apart.
    mkdirSync(join(dir, "exports", "K"), { recursive: true });
    writeFileSync(join(dir, "exports", "K", `1-${Date.now()}-dead`), processStamp(process.pid));
    const store = new SnapshotStore(x.web, dir, HOUR);
    assert.equal(label(await store.get("K", true)), "export 1");
    assert.deepEqual(x.calls, ["K"]);
  });

  it("waits for an export held in another pid namespace instead of dropping its lease as dead", async () => {
    const x = exporter();
    const dir = tempDir();
    // Two containers sharing a bind-mounted cache have their own pid namespaces (the download temp name already
    // says so), and a pid in one names another process in the other, or none. A container's pid 1 stamped 75516567
    // clock ticks since boot while the host's pid 1 read 12, under the one boot id, so the host judged a live
    // holder a pid reissued to someone else - and deleted its lease. That takes the floor with a pre-refresh export
    // still writing, whose file then answers the refresh.
    const lease = foreignHolder(dir, "container");
    const store = new SnapshotStore(x.web, dir, HOUR);
    const refreshed = store.get("K", true);
    // Polls rather than a poll of this test's own: a store that judged the lease dead stops polling at once, and
    // waiting for a poll that is never coming says only that, where these two assertions say what went wrong.
    await polls(3);
    assert.deepEqual(x.calls, [], "waiting for the other container's export");
    assert.ok(existsSync(lease), "and leaving alone the lease it has nothing to judge by");
    rmSync(lease, { force: true });
    assert.equal(label(await refreshed), "export 1");
  });

  it("keeps waiting for a holder in another namespace for as long as it keeps touching its lease", async () => {
    const x = exporter();
    const dir = tempDir();
    // The lease of a holder no pid here can judge is aged out by its heartbeat, and this is the holder the age
    // must not reach: a server in a container is one process for hours, and its client lease is taken once, by its
    // first call to the browser. Any rule that reads the lease's age instead of its beat collects it while it works.
    const lease = foreignHolder(dir, "long-lived", 20);
    const store = new SnapshotStore(x.web, dir, HOUR);
    const refreshed = store.get("K", true);
    for (let i = 0; i < 6; i++) {
      beat(lease); // its own timer, at six times the silence it would be dropped after
      await polls(1);
    }
    assert.deepEqual(x.calls, [], "still waiting for the other container's export");
    assert.ok(existsSync(lease), "and its lease is still there");
    rmSync(lease, { force: true });
    assert.equal(label(await refreshed), "export 1");
  });

  it("drops the lease of a holder in another namespace whose heartbeat stopped, and leaves it dropped", async () => {
    const x = exporter();
    const dir = tempDir();
    // A container that crashes leaves a lease nothing here can judge, and before this nothing collected one: every
    // refresh of that key waited out the whole 600 s ceiling before exporting, because the ceiling is per call.
    // Measured against a real pid namespace, on a lease left by a process that had exited: 2 s of a 2 s ceiling,
    // three refreshes in a row. What it costs now is one silence, once.
    const lease = foreignHolder(dir, "crashed", 20);
    const store = new SnapshotStore(x.web, dir, HOUR);
    assert.equal(label(await store.get("K", true)), "export 1");
    assert.ok(!existsSync(lease), "the lease of a holder that stopped saying it was there is gone");
    assert.equal(label(await store.get("K", true)), "export 2");
    assert.deepEqual(x.calls, ["K", "K"], "and the refresh after it waits for nothing");
  });

  it(
    "does not answer a refresh when the .fig could not be read at the instant the floor was taken",
    { skip: !UNREADABLE_CODE && "nothing here makes statSync fail for a reason other than the file not being there" },
    async () => {
      const x = exporter();
      const dir = tempDir();
      // Every statSync error read as "there is no file", and no file is a floor that anything on disk clears: a
      // reading that failed then answered the refresh with whatever the older export had left. A reading says
      // nothing unless it was taken.
      symlinkSync("K.fig", join(dir, "K.fig"));
      const older = holder(dir, Date.now(), "older");
      await polls(1);
      const store = new SnapshotStore(x.web, dir, HOUR);
      const refreshed = store.get("K", true);
      await polled(dir);
      const newer = holder(dir, Date.now(), "newer");
      await polled(dir);
      // The floor is taken at the instant the older export is seen gone, and here it cannot be read at all.
      rmSync(older, { force: true });
      await polled(dir);
      rmSync(join(dir, "K.fig"));
      writeFileSync(join(dir, "K.fig"), fig("older export"));
      rmSync(newer, { force: true });
      assert.equal(label(await refreshed), "export 1");
      assert.deepEqual(x.calls, ["K"]);
    },
  );

  it("does not answer a refresh from the file on disk when it gave up waiting for another export", async () => {
    const x = exporter();
    const dir = tempDir();
    writeFileSync(join(dir, "K.fig"), fig("pre-refresh"));
    // A holder that never goes, and a ceiling of no wait at all: the real one is ten minutes, which no test can
    // wait out. What the ceiling leaves is an export that is still running and began before this refresh, so the
    // file on disk is either that export's or the one it is about to rename over - neither answers this refresh.
    const held = holder(dir, Date.now(), "never-goes");
    const store = new SnapshotStore(x.web, dir, HOUR, 4, 0);
    assert.equal(label(await store.get("K", true)), "export 1");
    assert.deepEqual(x.calls, ["K"]);
    rmSync(held, { force: true });
  });

  it("answers with the file its own export wrote, not with whatever stands at the snapshot path", async () => {
    // Every process on this cache renames its own export onto the one path, so the snapshot read back after an
    // export is whatever renamed there last: a rival renaming continuously answered 39 of 40 refreshes with a file
    // this process had not exported, and at the ceiling that rival is the export the wait just gave up on.
    const dir = tempDir();
    const calls: string[] = [];
    const web = {
      async saveLocalCopy(fileKey: string, path: string) {
        calls.push(fileKey);
        writeFileSync(path, fig("mine"));
        writeFileSync(join(dir, `${fileKey}.fig`), fig("another process"));
      },
    } as unknown as FigmaWeb;
    const store = new SnapshotStore(web, dir, HOUR);
    assert.equal(label(await store.get("K", true)), "mine");
    assert.deepEqual(calls, ["K"]);
    assert.equal(label(store.peek("K")!), "mine", "and leaves its own export as the snapshot");
  });

  it("does not answer a refresh with a .fig that has gone from the cache since the floor was read", async () => {
    const x = exporter();
    const dir = tempDir();
    // What answers the refresh is a file that differs from the one the floor read, and no file is not one: a cache
    // being swept, or another process removing a snapshot it could not decode, would otherwise read as an export
    // that began after the refresh and be answered with a decode of a file that is not there.
    writeFileSync(join(dir, "K.fig"), fig("pre-refresh"));
    const older = holder(dir, Date.now(), "older");
    await polls(1);
    const store = new SnapshotStore(x.web, dir, HOUR);
    const refreshed = store.get("K", true);
    await polled(dir);
    const newer = holder(dir, Date.now(), "newer");
    await polled(dir);
    rmSync(older, { force: true });
    await polled(dir);
    rmSync(join(dir, "K.fig"));
    rmSync(newer, { force: true });
    assert.equal(label(await refreshed), "export 1");
    assert.deepEqual(x.calls, ["K"]);
  });

  it("answers a refresh with an export whose file carries the mtime of the one it replaced", async () => {
    const x = exporter();
    const dir = tempDir();
    // Two readings of the .fig are compared, and mtime alone is not one of them: a replacement written within the
    // mtime granularity, or by a writer that preserved it, carries the old time and differs only in size. The
    // floor is a reading of a file that is already there, which is what makes the pair the whole comparison.
    writeFileSync(join(dir, "K.fig"), fig("pre-refresh"));
    const kept = new Date(1_000_000_000_000);
    utimesSync(join(dir, "K.fig"), kept, kept);
    const before = statSync(join(dir, "K.fig")).size;
    const older = holder(dir, Date.now(), "older");
    await polls(1);
    const store = new SnapshotStore(x.web, dir, HOUR);
    const refreshed = store.get("K", true);
    await polled(dir);
    const newer = holder(dir, Date.now(), "newer");
    await polled(dir);
    rmSync(older, { force: true });
    await polled(dir);
    writeFileSync(join(dir, "K.fig"), fig("the newer export, at greater length"));
    utimesSync(join(dir, "K.fig"), kept, kept);
    const after = statSync(join(dir, "K.fig"));
    assert.equal(after.mtimeMs, kept.getTime(), "the same mtime");
    assert.notEqual(after.size, before, "and a different size, which is all there is to tell them apart");
    rmSync(newer, { force: true });
    assert.equal(label(await refreshed), "the newer export, at greater length");
    assert.deepEqual(x.calls, [], "the wait bought an answer, not only serialization");
  });

  // The leases above do not serialise exports: two processes can each find no live lease and both export, as the
  // tests above for two holders at once arrange, and the ceiling lets one export beside another still running. So the
  // swap onto the snapshot, the keeping of the one it replaced, and the reading of that pair go through a lock of
  // their own: a directory holding the holder's lease, under exports/.
  const lockDir = (dir: string) => join(dir, "exports", "K.publish");
  /** The publish lock as a process holds it, with `stamp` (its own processStamp by default) in its lease. */
  const plantLock = (dir: string, name: string, stamp = processStamp(process.pid)) => {
    mkdirSync(lockDir(dir), { recursive: true });
    writeFileSync(join(lockDir(dir), name), stamp);
  };
  /** A rival process's try at the lock, as underPublishLock makes it: true when it got in. */
  const rivalGetsIn = (dir: string) => {
    const staged = join(dir, "exports", "rival");
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, "1-rival"), processStamp(process.pid));
    try {
      renameSync(staged, lockDir(dir));
      rmSync(lockDir(dir), { recursive: true, force: true });
      return true;
    } catch {
      rmSync(staged, { recursive: true, force: true });
      return false;
    }
  };
  /** Run `during` while `fn` runs, at every link and rename it makes but those of the lock itself. */
  const atEveryStep = async (dir: string, during: () => void, fn: () => Promise<unknown>) => {
    const fs = createRequire(import.meta.url)("node:fs");
    const real = { renameSync: fs.renameSync, linkSync: fs.linkSync };
    let steps = 0;
    for (const name of ["renameSync", "linkSync"] as const) {
      fs[name] = (from: string, to: string) => {
        if (!String(to).startsWith(lockDir(dir)) && !String(to).startsWith(join(dir, "exports", "rival"))) {
          steps++;
          during();
        }
        return real[name](from, to);
      };
    }
    syncBuiltinESMExports();
    try {
      await fn();
    } finally {
      Object.assign(fs, real);
      syncBuiltinESMExports();
    }
    return steps;
  };

  it("keeps every other process out while it swaps an export onto the snapshot and keeps the one it replaced", async () => {
    // Injected between one export's link and its swap, another export's whole publish left the previous snapshot one
    // the current one had never replaced, and the snapshot that had been in between under neither name.
    const x = exporter();
    const dir = tempDir();
    const store = new SnapshotStore(x.web, dir, HOUR);
    await store.get("K");
    const outcomes: boolean[] = [];
    const steps = await atEveryStep(dir, () => outcomes.push(rivalGetsIn(dir)), () => store.get("K", true));
    assert.equal(steps, 3, "the link, the swap, and the link renamed onto the previous snapshot");
    assert.deepEqual(outcomes, [false, false, false], "no other process got the lock at any of them");
    assert.ok(!existsSync(lockDir(dir)), "and it is given back");
  });

  it("waits to publish while another process holds the lock, and publishes once it is given back", async () => {
    const x = exporter();
    const dir = tempDir();
    const store = new SnapshotStore(x.web, dir, HOUR);
    await store.get("K");
    plantLock(dir, `${process.pid}-other`);
    const refreshed = store.get("K", true);
    await exportsStarted(x, 2);
    await polls(3);
    assert.equal(label(new SnapshotStore(x.web, dir, HOUR).peek("K")!), "export 1", "exported and decoded, not yet swapped in");
    rmSync(lockDir(dir), { recursive: true, force: true });
    assert.equal(label(await refreshed), "export 2");
    assert.equal(prevLabel(store), "export 1");
  });

  it("takes over the publish lock of a holder that is gone", async () => {
    // pid 1 is alive but did not write this stamp, which is how liveLeases tells a holder that died. A ceiling of a
    // second makes a store that never takes the lock over publish without it instead, which leaves the lock behind.
    const x = exporter();
    const dir = tempDir();
    const store = new SnapshotStore(x.web, dir, HOUR, 4, 1000);
    await store.get("K");
    plantLock(dir, "1-crashed");
    assert.equal(label(await store.get("K", true)), "export 2");
    assert.ok(!existsSync(lockDir(dir)), "taken over and given back, not waited out");
  });

  it("takes over the publish lock of a holder in another pid namespace once it has been silent too long", async () => {
    const x = exporter();
    const dir = tempDir();
    const store = new SnapshotStore(x.web, dir, HOUR, 4, 5000);
    await store.get("K");
    plantLock(dir, "1-container", inAnotherNamespace(processStamp(process.pid), 20));
    const began = performance.now();
    assert.equal(label(await store.get("K", true)), "export 2");
    // Twelve silent beats of 20 ms: judged by its silence, since no pid here can judge it.
    assert.ok(performance.now() - began >= 12 * 20, "waited for the silence its stamp asks for");
    assert.ok(!existsSync(lockDir(dir)));
  });

  it("reads the previous snapshot together with the current one, and refuses a pair another export came between", async () => {
    const a = exporter("a"), b = exporter("b");
    const dir = tempDir();
    const first = new SnapshotStore(a.web, dir, HOUR);
    await first.get("K");
    const current = await first.get("K", true);
    assert.equal(label((await first.previousOf("K", current))!), "a 1", "the snapshot this one replaced");
    const outcomes: boolean[] = [];
    await atEveryStep(dir, () => outcomes.push(rivalGetsIn(dir)), () => first.previousOf("K", current));
    assert.deepEqual(outcomes, [false, false], "both read under the lock, so no export can come between them");
    // Another process publishes after `current` was read: the previous snapshot is now `current` itself, and
    // comparing the two answered that nothing had changed, with two equal dates as the only sign.
    await new SnapshotStore(b.web, dir, HOUR).get("K", true);
    await assert.rejects(first.previousOf("K", current), /the snapshot of K changed while it was being read/);
  });

  it("refuses a previous snapshot that is the current one rather than diff a snapshot with itself", async () => {
    const x = exporter();
    const dir = tempDir();
    const store = new SnapshotStore(x.web, dir, HOUR);
    const current = await store.get("K");
    assert.equal(await store.previousOf("K", current), undefined, "a first export has no previous snapshot");
    linkSync(store.figPath("K"), store.previousPath("K"));
    await assert.rejects(store.previousOf("K", current), /the previous snapshot of K is the same file as its current one/);
  });

  it("reads the previous snapshot from its own file, though the current one is one decode under its key and its path", async () => {
    // A snapshot is kept under its key and found again under its path (one decode for both). The previous snapshot
    // must never be answered by that sharing: a diff of the current document with itself reports nothing changed.
    const x = exporter();
    const dir = realpathSync(tempDir());
    const store = new SnapshotStore(x.web, dir, HOUR);
    await store.get("K");
    const current = await store.get("K", true);
    const decode = mock.method(FigDocument, "fromFile");
    try {
      assert.equal(await store.getLocal(store.figPath("K")), current, "the key and its path are one document");
      const prev = await store.previousOf("K", current);
      assert.notEqual(prev, current);
      assert.deepEqual([label(prev!), label(current)], ["export 1", "export 2"]);
      // Read by its own path afterwards, the previous snapshot is that same decode, and still not the current one.
      assert.equal(await store.getLocal(store.previousPath("K")), prev);
      assert.equal(decode.mock.callCount(), 1, "the previous snapshot decoded once, the current one not again");
    } finally {
      decode.mock.restore();
    }
  });

  it("registers with the browser before every wait an export makes, the publish lock's too, and never to read the pair", async () => {
    // The process a load waits on may be the browser's last client and close it on its way out, so a load says it
    // may export before any wait (see load). Publishing waits again, for the lock, after its export; and reading a
    // fresh snapshot and its previous one exports nothing, so it must not register at all.
    const x = exporter();
    const dir = tempDir();
    let said = 0;
    let saidAtExport = 0;
    const store = new SnapshotStore(
      { mayExport: () => void said++, saveLocalCopy: (k: string, p: string) => ((saidAtExport = said), x.web.saveLocalCopy(k, p)) },
      dir,
      HOUR,
    );
    await store.get("K");
    plantLock(dir, `${process.pid}-other`);
    const refreshed = store.get("K", true);
    await exportsStarted(x, 2);
    await polls(3);
    assert.deepEqual([said, saidAtExport], [2, 2], "said so before its export, and so before it waits for the lock");
    rmSync(lockDir(dir), { recursive: true, force: true });
    const current = await refreshed;
    assert.equal(label((await store.previousOf("K", current))!), "export 1");
    assert.equal(await store.get("K"), current);
    assert.equal(said, 2, "reading the pair asked nothing of the browser");
  });

  it(
    "reads the previous snapshot where it stands from a cache it may not write, and writes nothing there",
    { skip: (process.platform === "win32" || process.getuid?.() === 0) && "permissions do not bind here" },
    async () => {
      // A key whose snapshot is fresh is answered without writing, which is what lets a read-only sandbox use the
      // cache. diff previous gave both files a private name by hard link first, and failed there with EACCES/EROFS.
      const x = exporter();
      const dir = tempDir();
      const writer = new SnapshotStore(x.web, dir, HOUR);
      await writer.get("K");
      await writer.get("K", true);
      // Every directory of the cache made unwritable, the lease directories an export leaves included.
      const dirsOf = (d: string): string[] => [d, ...readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => dirsOf(join(d, e.name)))];
      const lock = (mode: number) => dirsOf(dir).reverse().forEach((d) => chmodSync(d, mode));
      const listing = () => readdirSync(dir, { recursive: true }).map(String).sort();
      // Another process, which may only read: a ceiling of 300 ms on the wait for a publish under way.
      const reader = new SnapshotStore(x.web, dir, HOUR, 4, 300);
      const before = listing();
      lock(0o555);
      try {
        const current = await reader.get("K");
        assert.equal(label((await reader.previousOf("K", current))!), "export 1");
        assert.deepEqual(listing(), before, "nothing written, not even for a moment that outlived the call");
      } finally {
        lock(0o755);
      }
      // A publish under way holds the lock between swapping the snapshot and renaming the previous one: a pair read
      // in place then may be one the snapshot never replaced, so it is refused, as previousOf refuses one read late.
      plantLock(dir, `${process.pid}-other`);
      lock(0o555);
      try {
        const current = await reader.get("K");
        await assert.rejects(reader.previousOf("K", current), /the snapshot of K changed while it was being read/);
      } finally {
        lock(0o755);
        rmSync(lockDir(dir), { recursive: true, force: true });
      }
      // A lock left by a holder that is gone, which this process cannot clear: read without it, and without waiting.
      plantLock(dir, "1-crashed");
      lock(0o555);
      try {
        const slow = new SnapshotStore(x.web, dir, HOUR, 4, 10_000);
        const current = await slow.get("K");
        const began = performance.now();
        assert.equal(label((await slow.previousOf("K", current))!), "export 1");
        assert.ok(performance.now() - began < 5_000, "not the ceiling waited out for a holder long gone");
      } finally {
        lock(0o755);
      }
    },
  );

  it("answers a refresh with an export whose file is the size of the one it replaced", async () => {
    const x = exporter();
    const dir = tempDir();
    // The other half of the pair: two exports of the same design differ by a byte in a name and not in length, so
    // size alone says they are one file, and the refresh pays for an export it need not have made.
    writeFileSync(join(dir, "K.fig"), fig("older export"));
    const old = new Date(Date.now() - HOUR);
    utimesSync(join(dir, "K.fig"), old, old);
    const before = statSync(join(dir, "K.fig"));
    const older = holder(dir, Date.now(), "older");
    await polls(1);
    const store = new SnapshotStore(x.web, dir, HOUR);
    const refreshed = store.get("K", true);
    await polled(dir);
    const newer = holder(dir, Date.now(), "newer");
    await polled(dir);
    rmSync(older, { force: true });
    await polled(dir);
    writeFileSync(join(dir, "K.fig"), fig("newer export"));
    const after = statSync(join(dir, "K.fig"));
    assert.equal(after.size, before.size, "the same size");
    assert.notEqual(after.mtimeMs, before.mtimeMs, "and a different mtime, which is all there is to tell them apart");
    rmSync(newer, { force: true });
    assert.equal(label(await refreshed), "newer export");
    assert.deepEqual(x.calls, [], "the wait bought an answer, not only serialization");
  });
});

// A refresh used to rename the new export over the only copy there was, so "what changed since the last export" had
// nothing to compare against. The export it replaces is kept beside it, one per key, for figma_diff.
describe("SnapshotStore previous snapshot", () => {
  it("keeps the snapshot each export replaced, exactly one, dated by the export that made it", async () => {
    const x = exporter();
    const dir = tempDir();
    const store = new SnapshotStore(x.web, dir, HOUR);
    await store.get("K");
    assert.ok(!existsSync(store.previousPath("K")), "a first export has nothing to keep");
    const first = statSync(store.figPath("K"));
    await store.get("K", true);
    assert.equal(prevLabel(store), "export 1");
    assert.equal(statSync(store.previousPath("K")).mtimeMs, first.mtimeMs, "and its time is still that export's");
    await store.get("K", true);
    assert.deepEqual([label(store.peek("K")!), prevLabel(store)], ["export 3", "export 2"]);
    // One previous per key, and nothing left over from keeping it: the cache holds the two snapshots and the leases.
    assert.deepEqual(readdirSync(dir).sort(), ["K.fig", "K.previous.fig", "exports"]);
  });

  it("keeps the one a re-export of a stale snapshot replaced too", async () => {
    const x = exporter();
    const dir = tempDir();
    writeFileSync(join(dir, "K.fig"), fig("stale"));
    const old = new Date(Date.now() - 2 * HOUR);
    utimesSync(join(dir, "K.fig"), old, old);
    const store = new SnapshotStore(x.web, dir, HOUR);
    assert.equal(label(await store.get("K")), "export 1");
    assert.equal(prevLabel(store), "stale");
  });

  it("leaves the snapshot and the previous one as they were when an export fails", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "K.fig"), fig("current"));
    writeFileSync(join(dir, "K.previous.fig"), fig("previous"));
    // One export that throws, and one that writes a file that does not decode: both are failures, and a previous
    // replaced by either would leave the diff comparing against the very snapshot that is still current.
    let broken = true;
    const web = {
      async saveLocalCopy(_key: string, path: string) {
        if (broken) throw new Error("export failed");
        writeFileSync(path, "not a fig");
      },
    } as unknown as FigmaWeb;
    const store = new SnapshotStore(web, dir, HOUR);
    await assert.rejects(store.get("K", true), /export failed/);
    broken = false;
    await assert.rejects(store.get("K", true));
    assert.deepEqual([label(store.peek("K")!), prevLabel(store)], ["current", "previous"]);
    assert.deepEqual(readdirSync(dir).sort(), ["K.fig", "K.previous.fig", "exports"]);
  });

  it("never leaves the snapshot path empty while it keeps the previous one", async () => {
    // Another process reading the snapshot between two renames would find no file: it exports, reads "no file" as
    // the floor a refresh is judged by, or fails a decode it has just stat'ed for. Moving the snapshot to the
    // previous name and the export onto the snapshot is that window, so every rename and link is checked at the
    // call itself, in this process, before anything after it could fill the gap.
    const x = exporter();
    const dir = tempDir();
    const store = new SnapshotStore(x.web, dir, HOUR);
    await store.get("K");
    const fs = createRequire(import.meta.url)("node:fs");
    const real = { renameSync: fs.renameSync, linkSync: fs.linkSync };
    const seen: boolean[] = [];
    for (const name of ["renameSync", "linkSync"] as const) {
      fs[name] = (...args: unknown[]) => {
        seen.push(existsSync(store.figPath("K")));
        return real[name](...args);
      };
    }
    syncBuiltinESMExports();
    try {
      await store.get("K", true);
    } finally {
      Object.assign(fs, real);
      syncBuiltinESMExports();
    }
    assert.ok(seen.length >= 2, "the export renamed its file onto the snapshot, and kept the previous one");
    assert.ok(seen.every(Boolean), `the snapshot was missing at ${seen.filter((s) => !s).length} of ${seen.length} steps`);
    assert.equal(prevLabel(store), "export 1");
  });

  it("leaves the snapshot and the previous one as they were when the swap onto the snapshot fails", async () => {
    // The rename onto the snapshot is the step Windows refuses while another process has the file open. The previous
    // snapshot used to be replaced before it, so a failed swap left the current snapshot under both names and the
    // older one gone: the very history the previous snapshot is there to keep.
    const x = exporter();
    const dir = tempDir();
    const store = new SnapshotStore(x.web, dir, HOUR);
    await store.get("K");
    await store.get("K", true);
    const fs = createRequire(import.meta.url)("node:fs");
    const real = fs.renameSync;
    fs.renameSync = (from: string, to: string) => {
      if (to === store.figPath("K")) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      return real(from, to);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(store.get("K", true), /EPERM/);
    } finally {
      fs.renameSync = real;
      syncBuiltinESMExports();
    }
    assert.deepEqual([label(new SnapshotStore(x.web, dir, HOUR).peek("K")!), prevLabel(store)], ["export 2", "export 1"]);
    assert.deepEqual(readdirSync(dir).sort(), ["K.fig", "K.previous.fig", "exports"], "nothing staged left behind");
    assert.deepEqual(readdirSync(join(dir, "exports")).sort(), ["K"], "and the publish lock given back");
  });

  it("does not fail an export over a previous snapshot it cannot replace", async () => {
    const x = exporter();
    const dir = tempDir();
    const store = new SnapshotStore(x.web, dir, HOUR);
    await store.get("K");
    // Windows refuses to replace a file another process has open, as a diff reading the previous one would. A
    // directory in its place cannot be renamed over anywhere, which stands in for that here.
    mkdirSync(join(store.previousPath("K"), "held"), { recursive: true });
    assert.equal(label(await store.get("K", true)), "export 2");
    assert.equal(label(store.peek("K")!), "export 2");
    assert.ok(statSync(store.previousPath("K")).isDirectory(), "left as it was");
    assert.deepEqual(readdirSync(dir).sort(), ["K.fig", "K.previous.fig", "exports"], "and nothing staged left behind");
  });
});

// Every call that reaches the browser first sweeps the cache for what crashed exports left behind (cleanStaleDownloads),
// judging a file by its age. The store's own staging files have the swept shape and are older than the sweep while in
// use, so each test below runs that sweep, as another process starting meanwhile would, at the moment it hurt.
describe("SnapshotStore beside another process's sweep", () => {
  /**
   * Run `fn` with the sweep run right after each hard link it makes and right before each staging file it decodes,
   * and count both: a link has to outlive the first, and stay claimed until it has been read, past the second.
   */
  const sweptAtEveryStep = async <T>(dir: string, fn: () => Promise<T>) => {
    const fs = createRequire(import.meta.url)("node:fs");
    const real = fs.linkSync;
    const swept = { links: 0, decodes: 0 };
    fs.linkSync = (from: string, to: string) => {
      real(from, to);
      swept.links++;
      cleanStaleDownloads(dir);
    };
    syncBuiltinESMExports();
    const fromFile = FigDocument.fromFile;
    const decode = mock.method(FigDocument, "fromFile", (key: string, path: string, at: Date) => {
      if (path.endsWith(".tmp")) {
        swept.decodes++;
        cleanStaleDownloads(dir);
      }
      return fromFile.call(FigDocument, key, path, at);
    });
    try {
      return { result: await fn(), ...swept };
    } finally {
      decode.mock.restore();
      fs.linkSync = real;
      syncBuiltinESMExports();
    }
  };

  it("keeps an export's own file while it is decoded", async () => {
    // The file is the download moved into place, written before the decode began, so a sweep starting during the
    // decode (seconds, on a large file) found it older than itself and deleted it: the rename onto the snapshot failed.
    const dir = tempDir();
    const downloaded = new Date(Date.now() - 60_000);
    const web = {
      async saveLocalCopy(_key: string, path: string) {
        writeFileSync(path, fig("export 1"));
        utimesSync(path, downloaded, downloaded);
      },
    } as unknown as FigmaWeb;
    const fromFile = FigDocument.fromFile;
    const decode = mock.method(FigDocument, "fromFile", (key: string, path: string, at: Date) => {
      if (path.endsWith(".tmp")) cleanStaleDownloads(dir);
      return fromFile.call(FigDocument, key, path, at);
    });
    try {
      assert.equal(label(await new SnapshotStore(web, dir, HOUR).get("K")), "export 1");
      assert.equal(decode.mock.callCount(), 1, "the sweep ran during the decode");
    } finally {
      decode.mock.restore();
    }
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "and nothing staged is left behind");
  });

  it("keeps the previous snapshot when the sweep lands between the link that keeps it and its rename", async () => {
    const x = exporter();
    const dir = tempDir();
    const store = new SnapshotStore(x.web, dir, HOUR);
    await store.get("K");
    // The snapshot being replaced is older than the sweep, as it always is, and its link carries that time.
    const old = new Date(Date.now() - 2 * HOUR);
    utimesSync(store.figPath("K"), old, old);
    const swept = await sweptAtEveryStep(dir, () => store.get("K", true));
    assert.equal(label(swept.result), "export 2");
    assert.ok(swept.links > 0, "the link was made, so the sweep ran there");
    assert.equal(prevLabel(store), "export 1");
  });

  /** A store holding a pair diff previous reads, exported twenty and ten minutes ago: fresh, and older than any sweep. */
  const pair = async () => {
    const dir = tempDir();
    const store = new SnapshotStore(exporter().web, dir, HOUR);
    await store.get("K");
    await store.get("K", true);
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    utimesSync(store.previousPath("K"), at(20), at(20));
    utimesSync(store.figPath("K"), at(10), at(10));
    return { dir, store, current: await store.get("K") };
  };

  it("reads diff previous's pair under its own names while the sweep runs, until the previous one is decoded", async () => {
    // The lease that claims the two links has to stand until the previous snapshot is read from its link: given up as
    // soon as the links were made, a sweep before the decode deleted the file it was about to open.
    const { dir, store, current } = await pair();
    const swept = await sweptAtEveryStep(dir, () => store.previousOf("K", current));
    assert.equal(label(swept.result!), "export 1");
    assert.deepEqual([swept.links, swept.decodes], [2, 1], "a sweep after each link, and one as the previous one was opened");
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "and its own names are gone");
  });

  it(
    "reads diff previous's pair where it stands, linking nothing, when the lease that guards the links cannot be taken",
    { skip: (process.platform === "win32" || process.getuid?.() === 0) && "permissions do not bind here" },
    async () => {
      // A cache that takes the links but not that lease: links made without it had no live owner, and a sweep in another
      // process deleted them while they were read, which answered that the snapshot had changed when none had.
      const { dir, store, current } = await pair();
      const leases = join(dir, "exports", "K.reading");
      mkdirSync(leases, { recursive: true });
      chmodSync(leases, 0o555);
      try {
        const swept = await sweptAtEveryStep(dir, () => store.previousOf("K", current));
        assert.equal(label(swept.result!), "export 1");
        assert.equal(swept.links, 0, "no link made without the lease");
      } finally {
        chmodSync(leases, 0o755);
      }
    },
  );

  it("fails diff previous on a lease it cannot take for any other reason, rather than link without one", async () => {
    const { dir, store, current } = await pair();
    writeFileSync(join(dir, "exports", "K.reading"), "a file where the lease directory belongs");
    await assert.rejects(store.previousOf("K", current), (e: NodeJS.ErrnoException) => e.code === "EEXIST" || e.code === "ENOTDIR");
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "and no link made");
  });

  it(
    "says which directory an export could not write, what needed it, and what reads without writing",
    { skip: (process.platform === "win32" || process.getuid?.() === 0) && "permissions do not bind here" },
    async () => {
      // A read-only sandbox answered with the system's "EACCES: permission denied, mkdir '<path>'" and nothing else.
      const x = exporter();
      const dir = tempDir();
      chmodSync(dir, 0o555);
      try {
        await assert.rejects(new SnapshotStore(x.web, dir, HOUR).get("K"), (e: Error) => {
          const said = `exporting K saves its snapshot in figma-reader's cache, ${dir}, which this process may not write (EACCES: `;
          assert.ok(e.message.startsWith(said), e.message);
          assert.match(e.message, /FIGMA_READER_CACHE/);
          assert.match(e.message, /Reading a local \.fig by its path, or a key whose cached snapshot is still fresh .*, writes nothing\.$/);
          return true;
        });
        assert.deepEqual(x.calls, [], "and the browser was never asked for an export there was nowhere to keep");
      } finally {
        chmodSync(dir, 0o755);
      }
      // A cache directory that stands takes no write from mkdir, and the lease directory of the key may take the lease
      // while the directory the snapshot goes in takes nothing: the export ran, and only the move onto the snapshot's
      // directory said so, raw, once the whole export was spent.
      mkdirSync(join(dir, "exports", "K"), { recursive: true });
      chmodSync(dir, 0o555);
      try {
        await assert.rejects(new SnapshotStore(x.web, dir, HOUR).get("K"), (e: Error) => {
          assert.ok(e.message.startsWith(`exporting K saves its snapshot in figma-reader's cache, ${dir}, which this process may not write (EACCES: `), e.message);
          return true;
        });
        assert.deepEqual(x.calls, [], "still nothing asked of the browser");
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );

  it(
    "says the same of a write into the cache that fails later in the export",
    { skip: (process.platform === "win32" || process.getuid?.() === 0) && "permissions do not bind here" },
    async () => {
      // A cache that stops taking writes while the browser exports: the swap onto the snapshot is refused.
      const dir = tempDir();
      const web = {
        async saveLocalCopy(_key: string, path: string) {
          writeFileSync(path, fig("export 1"));
          chmodSync(dir, 0o555);
        },
      } as unknown as FigmaWeb;
      try {
        await assert.rejects(new SnapshotStore(web, dir, HOUR).get("K"), (e: Error) => {
          assert.ok(e.message.startsWith(`exporting K saves its snapshot in figma-reader's cache, ${dir}, which this process may not write (EACCES: `), e.message);
          assert.match(e.message, /rename/);
          return true;
        });
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );
});

describe("SnapshotStore.getLocal and peek", () => {
  it("re-reads a local .fig when it changes on disk", async () => {
    const store = new SnapshotStore(exporter().web, tempDir(), HOUR);
    const path = join(tempDir(), "Design.fig");
    writeFileSync(path, fig("v1"));
    const v1 = await store.getLocal(path);
    assert.equal(await store.getLocal(path), v1);
    writeFileSync(path, fig("v2"));
    const later = new Date(Date.now() + 5000);
    utimesSync(path, later, later);
    assert.equal(label(await store.getLocal(path)), "v2");
  });

  it("re-reads a local .fig replaced with the same mtime but a different size", async () => {
    const store = new SnapshotStore(exporter().web, tempDir(), HOUR);
    const path = join(tempDir(), "Design.fig");
    const same = new Date(1_000_000_000_000);
    writeFileSync(path, fig("v1"));
    utimesSync(path, same, same);
    await store.getLocal(path);
    writeFileSync(path, fig("version 2"));
    utimesSync(path, same, same);
    assert.equal(label(await store.getLocal(path)), "version 2");
  });

  it("decodes a local .fig once whichever way its path is written", async () => {
    const store = new SnapshotStore(exporter().web, tempDir(), HOUR);
    const dir = tempDir();
    writeFileSync(join(dir, "Design.fig"), fig("v1"));
    const a = await store.getLocal(join(dir, "Design.fig"));
    assert.equal(await store.getLocal(`${dir}/../${basename(dir)}/./Design.fig`), a);
  });

  it("never reads a half-moved download as the snapshot of the key it was named for", async () => {
    const x = exporter();
    const dir = tempDir();
    // A download that crosses a filesystem is copied to "<key>.fig.<pid>.tmp" next to the snapshot and renamed; one
    // left behind by an interrupted move is a partial file, and serving it would be serving a truncated design.
    writeFileSync(join(dir, "K.fig.4242.tmp"), fig("half moved"));
    const store = new SnapshotStore(x.web, dir, HOUR);
    assert.equal(label(await store.get("K")), "export 1");
    assert.deepEqual(x.calls, ["K"]);
  });

  it("peek returns a snapshot of any age without exporting, and nothing for a missing or unreadable one", () => {
    const x = exporter();
    const dir = tempDir();
    writeFileSync(join(dir, "OLD.fig"), fig("old"));
    const old = new Date(Date.now() - 48 * HOUR);
    utimesSync(join(dir, "OLD.fig"), old, old);
    writeFileSync(join(dir, "BAD.fig"), "not a fig");
    const store = new SnapshotStore(x.web, dir, HOUR);
    assert.equal(label(store.peek("OLD")!), "old");
    assert.equal(store.peek("MISSING"), undefined);
    assert.equal(store.peek("BAD"), undefined);
    assert.deepEqual(x.calls, []);
  });
});
