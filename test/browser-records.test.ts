// Browser records outlive their processes and pids get reused: nothing may trust or signal a pid without checking
// it is still the process that was recorded. Tests only ever signal processes they spawned (see browser-helpers.ts).
// Also what tells a login apart (the cookie hint) and a browser that stops answering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bootId, BrowserManager, bystander, manager, OTHER_BOOT, ourBrowser, pidAlive, pidNamespace, processStart, profileHasLoginCookie, root,
  sameProcess,
} from "./browser-helpers.ts";

/** A directory name of its own for each cookie profile the tests below make. */
let n = 0;

test("a process is recognized by its start time, and a different start time is another process", async () => {
  // On macOS the start time is ps's lstart, which resolves to one second: this process and a child spawned in the
  // same second carry the identical string, which is what the run below asserts. Crossing into the next second
  // first is therefore not tidiness - it is the only way the pair is distinguishable there at all.
  if (process.platform === "darwin") await new Promise((r) => setTimeout(r, 1050 - (Date.now() % 1000)));
  const pid = bystander();
  const start = processStart(pid);
  assert.ok(start, "start time readable");
  assert.equal(processStart(pid), start, "stable across reads");
  if (process.platform === "win32") {
    // What Windows resolves, stated rather than assumed: Get-Process reports 100 ns ticks counted from when the
    // process was created, so two started one after another are two identities, and ownsProcess can rest on the
    // pair as it does on Linux. Five spawned back to back on a runner came out 4.6 to 13 ms apart, none alike.
    const next = processStart(bystander());
    assert.notEqual(next, start, "a process started right after has its own start time");
    assert.ok(Number(next) > Number(start), "and the later of the two is the later tick");
  } else if (process.platform === "linux") {
    // Reading the wrong field of /proc/<pid>/stat is invisible to any comparison of the value with itself, and a
    // wrong one still looks like a number. This one is ticks since boot (100 Hz, as /proc/uptime confirms), so a
    // process started just now sits at the current uptime; the neighbouring fields are a zero and a memory size.
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    const seconds = Number(start) / 100;
    assert.ok(seconds > 0 && seconds <= uptime + 1, `${start} ticks (${seconds}s) is within the uptime of ${uptime}s`);
    assert.ok(uptime - seconds < 60, `${seconds}s in, the child spawned above has just started (uptime ${uptime}s)`);
  } else {
    // How much this platform can tell apart, stated rather than assumed: exactly which second a process started in.
    // Two spawned back to back are one identity, so a pid reissued inside a second is indistinguishable from its
    // previous holder here, and only the command line in ownsProcess stands between that and process.kill.
    assert.equal(processStart(bystander()), start, "a process started in the same second has the same start time");
  }
  assert.notEqual(processStart(process.pid), start, "this process started before its child");
  assert.ok(sameProcess(pid, start));
  assert.ok(!sameProcess(pid, `${start}0`), "same pid, other start time: a reused pid");
  assert.ok(sameProcess(pid, undefined), "unknown start time falls back to liveness");
  process.kill(pid);
  for (let i = 0; i < 50 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(!sameProcess(pid, start));
});

// pid 1 is init, which every Unix has and no ordinary user may signal. Windows has no pid 1 at all and answers
// ESRCH for it; what stands for init there is pid 4, the System process, which not even an administrator can open
// (measured on the windows-latest runner, which runs elevated: pid 4, Secure System, smss, csrss, services and
// Defender all answer EPERM, and every pid that is simply not running answers ESRCH).
const UNSIGNALLABLE = process.platform === "win32" ? 4 : 1;

test("a running process this user may not signal is alive", { skip: process.getuid?.() === 0 && "running as root: pid 1 is signallable" }, () => {
  // Such a process is running, and the liveness probe comes back EPERM rather than ESRCH on both platforms.
  // Reading that as "gone" would drop the export and busy leases of every figma-reader running under another
  // account on this machine, and would let close() signal a pid that process still holds.
  let code: string | undefined;
  try {
    process.kill(UNSIGNALLABLE, 0);
  } catch (e: any) {
    code = e.code;
  }
  assert.equal(code, "EPERM", `pid ${UNSIGNALLABLE} is running and this user may not signal it`);
  assert.ok(pidAlive(UNSIGNALLABLE));
});

for (const [label, extra] of [["a mismatching start time", { start: "1" }], ["no start time (older record)", {}]] as const) {
  test(`release() with a work record whose pid was reused (${label}) neither launches nor signals`, async () => {
    const pid = bystander();
    const { m, marker, record } = manager();
    writeFileSync(record, JSON.stringify({ pid, headless: true, purpose: "work", ...extra }));
    await m.release();
    assert.ok(pidAlive(pid), "the unrelated process was not signalled");
    assert.ok(!existsSync(marker), "no browser was launched");
    assert.ok(!existsSync(record), "the stale record was removed");
  });
}

test("a login record whose pid was reused is stale: no login window is reported, closing it signals nothing", async () => {
  const pid = bystander();
  const { m, record } = manager();
  writeFileSync(record, JSON.stringify({ pid, headless: false, purpose: "login", start: "1" }));
  assert.equal(m.launchRecord(), undefined);
  writeFileSync(record, JSON.stringify({ pid, headless: false, purpose: "login", start: "1" }));
  await m.closeLoginWindow();
  assert.ok(pidAlive(pid));
});

/**
 * Half a second to live, and on a Unix a SIGTERM it ignores, so the wait in close() is real. Windows gives a
 * process no say in being terminated, so there it is gone the moment closeLoginWindow signals it; the half second
 * is what still makes the wait happen, and what the tests below assert is the same either way.
 */
const DYING = 'process.on("SIGTERM", () => {});\nsetTimeout(() => {}, 500)';

for (const purpose of ["work", "login"] as const) {
  test(`closing a ${purpose} browser keeps a record another process wrote while it waited`, async () => {
    const { m, record } = manager();
    const old = ourBrowser(m.opts.userDataDir, DYING);
    writeFileSync(record, JSON.stringify({ pid: old, headless: purpose === "work", purpose, start: processStart(old) }));
    const closing = purpose === "work" ? m.close() : m.closeLoginWindow();
    // The other process launches its browser and records it while we are still waiting for ours to exit.
    const fresh = ourBrowser(m.opts.userDataDir);
    const written = JSON.stringify({ pid: fresh, headless: true, purpose: "work", start: processStart(fresh) });
    writeFileSync(record, written);
    await closing;
    assert.equal(readFileSync(record, "utf8"), written, "the fresh record was left alone");
    assert.equal(m.launchRecord()?.pid, fresh, "so that browser is still managed");
    assert.ok(pidAlive(fresh), "and its process was not signalled");
  });
}

test("a record of the recorded process itself is kept", () => {
  const { m, record } = manager();
  const pid = ourBrowser(m.opts.userDataDir);
  writeFileSync(record, JSON.stringify({ pid, headless: true, purpose: "work", start: processStart(pid) }));
  assert.equal(m.launchRecord()?.pid, pid);
});

test("a login window whose cookie has not appeared is left open rather than closed", async () => {
  // This is what closeLoginWindow's SIGTERM rests on: it only ever signals a window whose auth cookie is already
  // committed to the profile, so the graceful exit it asks for carries nothing. Windows turns that signal into
  // TerminateProcess, which gives Chromium no chance to flush, and the login still survives because of this check.
  const { m, record } = manager();
  const pid = ourBrowser(m.opts.userDataDir);
  writeFileSync(record, JSON.stringify({ pid, headless: false, purpose: "login", start: processStart(pid), launchedAt: Date.now() }));
  await assert.rejects(m.session(), /A Figma login window is open/);
  assert.ok(pidAlive(pid), "the window was left open for the user, not signalled");
});

test("a record from another boot is stale however well its pid matches", { skip: !bootId() && "no boot id on this platform" }, async () => {
  // browser.json lives in the state dir and survives reboots, while processStart counts ticks since boot: the
  // recorded pair is reproducible by an unrelated process afterwards, and it alone authorises process.kill.
  const pid = bystander();
  const { m, marker, record } = manager();
  const stale = JSON.stringify({ pid, headless: true, purpose: "work", start: processStart(pid), boot: OTHER_BOOT });
  writeFileSync(record, stale);
  assert.equal(m.launchRecord(), undefined);
  assert.ok(!existsSync(record), "the stale record was removed");
  writeFileSync(record, stale);
  await m.release();
  assert.ok(pidAlive(pid), "the unrelated process was not signalled");
  assert.ok(!existsSync(marker), "no browser was launched");
});

test("a launch record from another pid namespace is not ours to trust, to delete, or to signal", async () => {
  // A live container's record, read here: its pid 1 is alive on this side too (init), and only the start time
  // recorded beside it - 12 ticks against 75899724 - stood between that record and process.kill. Deleting it is
  // no safer: the browser it names then goes unmanaged forever, while the process that could manage it looks for
  // a record that is gone.
  const pid = bystander();
  const { m, marker, record } = manager();
  const foreign = JSON.stringify({
    pid,
    headless: true,
    purpose: "work",
    start: processStart(pid),
    boot: bootId(),
    ns: String(Number(pidNamespace() ?? 0) + 1),
  });
  writeFileSync(record, foreign);
  assert.equal(m.launchRecord(), undefined, "a pid numbered somewhere else names nothing here");
  assert.equal(readFileSync(record, "utf8"), foreign, "and the record is left where the process that wrote it will look");
  await m.close();
  assert.ok(pidAlive(pid), "the process it names was not signalled");
  assert.equal(readFileSync(record, "utf8"), foreign, "nor was its record cleared out from under it");
  assert.ok(!existsSync(marker), "and no browser was launched");
});

test("busyElsewhere() lists other live processes working in the browser, not this one or a reused pid", async () => {
  const { m } = manager();
  const busy = join(m.stateDir, "busy");
  const other = bystander();
  const reused = bystander();
  mkdirSync(busy, { recursive: true });
  writeFileSync(join(busy, `${other}-1-a`), processStart(other)!);
  writeFileSync(join(busy, `${reused}-1-b`), "1");
  const seen = await m.busy(async () => m.busyElsewhere());
  assert.deepEqual(seen, [other]);
  assert.deepEqual(readdirSync(busy), [`${other}-1-a`], "own lease dropped after the work, stale one removed");
});

test("the login cookie hint ignores expired cookies and, when asked, cookies written before a login window opened", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const chrome = (unixMs: number) => BigInt(Math.round(unixMs + 11_644_473_600_000)) * 1000n;
  const now = Date.now();
  const profile = (rows: { created: number; updated?: number; expires: number }[], withUpdate = true) => {
    const dir = join(root, `cookies${n++}`);
    mkdirSync(join(dir, "Default"), { recursive: true });
    const db = new DatabaseSync(join(dir, "Default", "Cookies"));
    db.exec(`create table cookies (host_key text, name text, creation_utc integer, expires_utc integer, has_expires integer${withUpdate ? ", last_update_utc integer" : ""})`);
    for (const r of rows) {
      const cols = [".figma.com", "__Host-figma.authn", chrome(r.created), r.expires ? chrome(r.expires) : 0n, r.expires ? 1 : 0];
      if (withUpdate) cols.push(chrome(r.updated ?? r.created));
      db.prepare(`insert into cookies values (${cols.map(() => "?").join(",")})`).run(...cols);
    }
    db.close();
    return dir;
  };
  const day = 86_400_000;
  assert.ok(!profileHasLoginCookie(profile([])));
  const old = profile([{ created: now - 30 * day, expires: now + 300 * day }]);
  assert.ok(profileHasLoginCookie(old), "an unexpired cookie is a login hint");
  assert.ok(!profileHasLoginCookie(old, now - 60_000), "but not one written before the login window opened");
  assert.ok(!profileHasLoginCookie(profile([{ created: now - 30 * day, expires: now - day }])), "expired");
  assert.ok(profileHasLoginCookie(profile([{ created: now - 30 * day, expires: 0 }])), "session cookie without expiry");
  const rewritten = profile([{ created: now - 30 * day, updated: now - 1000, expires: now + 300 * day }]);
  assert.ok(profileHasLoginCookie(rewritten, now - 60_000), "overwritten after the window opened");
  const olderSchema = profile([{ created: now - 1000, expires: now + day }], false);
  assert.ok(profileHasLoginCookie(olderSchema, now - 60_000), "creation time when there is no last_update_utc");
  assert.ok(!profileHasLoginCookie(olderSchema, now));
});

test("a login cookie still in the write-ahead log counts, not only a checkpointed one", async (t) => {
  // Chromium commits the cookie long before it checkpoints. Opening the DB with immutable=1 told SQLite to ignore
  // -wal (and any hot journal), so the fresh login was invisible and waitForLogin would spin to its deadline.
  const { DatabaseSync } = await import("node:sqlite");
  const dir = join(root, "wal-cookies");
  mkdirSync(join(dir, "Default"), { recursive: true });
  const db = new DatabaseSync(join(dir, "Default", "Cookies"));
  t.after(() => db.close());
  db.exec("pragma journal_mode=WAL");
  db.exec("create table cookies (host_key text, name text, creation_utc integer, expires_utc integer, has_expires integer, last_update_utc integer)");
  const chrome = (unixMs: number) => BigInt(Math.round(unixMs + 11_644_473_600_000)) * 1000n;
  db.prepare("insert into cookies values (?,?,?,?,?,?)").run(".figma.com", "__Host-figma.authn", chrome(Date.now()), 0n, 0, chrome(Date.now()));
  assert.ok(existsSync(join(dir, "Default", "Cookies-wal")), "the writer still holds the commit in the log");
  assert.ok(profileHasLoginCookie(dir, Date.now() - 60_000));
});

test("a browser that accepts the socket but never answers the target list fails instead of hanging", { timeout: 30_000 }, async (t) => {
  // reachable() has always had a timeout and targets() had none, so a swapping or frozen browser held editorTab
  // and newTab's retry loop for undici's 300 s headers timeout.
  const sockets: Socket[] = [];
  const server = createServer((req, res) => {
    if (req.url !== "/json/version") return; // /json/list: accepted, never answered
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x`, "User-Agent": "Chrome/1" }));
  });
  server.on("connection", (s) => sockets.push(s));
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.push(socket as Socket);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  t.after(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  const dir = join(root, "frozen");
  const m = new BrowserManager({ cdpUrl: `http://127.0.0.1:${port}`, userDataDir: join(dir, "profile"), headless: true, stateDir: join(dir, "state") });
  const started = Date.now();
  await assert.rejects(m.targets(), /abort|timed? ?out/i);
  assert.ok(Date.now() - started < 20_000, "gave up long before undici's headers timeout");
});
