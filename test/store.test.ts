// The snapshot cache decides when a tool call pays for a browser export (up to a minute) and when it may serve an
// older copy, so each rule is pinned against a fake exporter that counts its calls.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pidNamespace, processStamp, takeLease } from "../src/browser.ts";
import type { FigmaWeb } from "../src/figma-web.ts";
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

  /** The same stamp as written by a process whose pids are numbered in another pid namespace (see processStamp). */
  const inAnotherNamespace = (stamp: string) => {
    const [first, second] = stamp.split("|");
    const ns = Number(pidNamespace() ?? 0) + 1;
    return second === undefined ? `|${first}|${ns}` : `${first}|${second}|${ns}`;
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
    const leases = join(dir, "exports", "K");
    mkdirSync(leases, { recursive: true });
    const lease = join(leases, `1-${Date.now()}-container`);
    writeFileSync(lease, inAnotherNamespace(processStamp(process.pid)));
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
