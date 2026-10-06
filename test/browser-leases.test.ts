// The presence files every process here announces itself with (client, busy, export and download leases): what
// counts as live, and the heartbeat a holder in another pid namespace is judged by.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bootId, bystander, bystanderOfAnotherStart, children, LEASE_BEAT_MS, liveLeases, OTHER_BOOT, pidNamespace, processStamp, processStart, root, takeLease,
} from "./browser-helpers.ts";

test("a lease stamped in another boot does not count as live", { skip: !bootId() && "no boot id on this platform" }, () => {
  const dir = join(root, "boot-leases");
  const pid = bystander();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pid}-1-a`), `${OTHER_BOOT}|${processStart(pid)}`);
  const mine = takeLease(dir, `${process.pid}-1-b`);
  assert.deepEqual(liveLeases(dir), [`${process.pid}-1-b`]);
  assert.deepEqual(readdirSync(dir), [`${process.pid}-1-b`], "the pre-reboot lease is removed");
  rmSync(mine);
});

test("client and lease files of a reused pid do not count as live", () => {
  const dir = join(root, "leases");
  const pid = bystander();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(pid)), "1"); // pid alive, but not the process that registered
  writeFileSync(join(dir, `${pid}-123-abc`), processStart(pid)!);
  const mine = takeLease(dir);
  assert.deepEqual(liveLeases(dir).sort(), [`${pid}-123-abc`, String(process.pid)].sort());
  assert.deepEqual(readdirSync(dir).sort(), [`${pid}-123-abc`, String(process.pid)].sort(), "the stale one is removed");
  rmSync(mine);
});

test("a lease carries the stamp of the process that wrote it, so a pid held by another process is not live", async () => {
  // An empty stamp passes every test that only counts leases, and silently disables reused-pid detection for all
  // of them: liveLeases then falls back to plain liveness.
  const dir = join(root, "lease-stamp");
  const other = await bystanderOfAnotherStart();
  const borrowed = takeLease(dir, String(other)); // written by us, named for a live process that is not us
  assert.ok(readFileSync(borrowed, "utf8").length, "the lease is stamped");
  assert.deepEqual(liveLeases(dir), [], "the stamp says the named pid is not the process that took it");
  assert.ok(!existsSync(borrowed), "and the lease is dropped");
  const mine = takeLease(dir);
  assert.deepEqual(liveLeases(dir), [String(process.pid)]);
  rmSync(mine);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The same stamp as written by a process whose pids are numbered in another pid namespace (see processStamp). */
const inAnotherNamespace = (stamp: string, beat = LEASE_BEAT_MS) => {
  const [first, second] = stamp.split("|");
  return `${second === undefined ? `|${first}` : `${first}|${second}`}|${Number(pidNamespace() ?? 0) + 1}|${beat}`;
};

test("a lease says how often its holder will touch it, behind the fields an older build reads", () => {
  // 0.3.0 read a stamp as `const [first, second, ns] = stamp.split("|")` and judged by those three. The period is
  // a fourth field for that reason: what that build makes of a stamp of ours has to be what it made of its own,
  // since a shared cache is the one place these meet - and there it judges by pid, as it did before.
  const stamp = processStamp(process.pid);
  const start = processStart(process.pid) ?? "";
  if (!pidNamespace()) {
    // Off Linux there is no namespace to make a pid worthless in, so every reader judges by pid and no beat is
    // written: the stamp is what 0.3.0 wrote here, byte for byte.
    assert.equal(stamp, bootId() ? `${bootId()}|${start}` : start);
    return;
  }
  const parts = stamp.split("|");
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.slice(0, 3), [bootId() ?? "", start, pidNamespace()], "the three 0.3.0 reads are unchanged");
  assert.equal(Number(parts[3]), LEASE_BEAT_MS, "and the period is the holder's own, not one the reader assumes");
});

test("a lease from another pid namespace is live while its heartbeat moves, and collected once it stops", () => {
  // Nothing here can judge such a holder by pid (see sameStampedProcess), and before this nothing collected its
  // lease either: a container that crashed left one that outlived it, and every wait on that key then ran to the
  // caller's ceiling. Its own beat is what it is judged by instead, which needs no identity at all.
  const dir = join(root, "foreign-beat");
  mkdirSync(dir, { recursive: true });
  const lease = join(dir, "1-123-container");
  // A 20 ms period, so the silence to wait out here is 20 ms times the tolerance rather than the real minute.
  writeFileSync(lease, inAnotherNamespace(processStamp(process.pid), 20));
  assert.deepEqual(liveLeases(dir), ["1-123-container"], "a holder read for the first time is live: it has not been silent yet");
  const now = new Date();
  utimesSync(lease, now, now);
  assert.deepEqual(liveLeases(dir), ["1-123-container"], "and a touched one stays live");
  return sleep(400).then(() => {
    assert.deepEqual(liveLeases(dir), [], "the silence outlasted what the stamp asked for");
    assert.ok(!existsSync(lease), "and the lease is gone, for this reader and every later one");
  });
});

test("a process holding a lease goes on touching it, which is all a reader in another namespace has to go by", {
  // Not a platform being quieted: off Linux there is no pid namespace, so nothing here is ever judged by a beat
  // and takeLease starts no timer. The rule this covers cannot arise on a machine with one numbering of pids.
  skip: !pidNamespace() && "no pid namespace on this platform, so no lease is ever judged by its heartbeat",
}, async () => {
  // The rule above is worth nothing unless a holder really does keep its lease warm: a lease written once and left
  // alone reads, from another namespace, exactly like one a crashed process left. Only a second process can show
  // it, and only in real time, because the beat is a timer inside that process - here, one doing nothing else.
  const dir = join(root, "heartbeat");
  mkdirSync(dir, { recursive: true });
  const src = new URL("../src/browser.ts", import.meta.url).href;
  const code = `const { takeLease } = await import(${JSON.stringify(src)}); takeLease(${JSON.stringify(dir)}, "held"); setTimeout(() => {}, 60_000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" });
  children.push(child.pid!);
  const lease = join(dir, "held");
  // Two periods and the margin a loaded runner needs to start node at all: anything longer is no heartbeat.
  const deadline = Date.now() + 2 * LEASE_BEAT_MS + 10_000;
  while (!existsSync(lease) && Date.now() < deadline) await sleep(50);
  assert.ok(existsSync(lease), "the child took its lease");
  const first = statSync(lease).mtimeMs;
  while (statSync(lease).mtimeMs === first && Date.now() < deadline) await sleep(50);
  assert.notEqual(statSync(lease).mtimeMs, first, `the lease was never touched again within ${2 * LEASE_BEAT_MS} ms`);
  child.kill();
});
