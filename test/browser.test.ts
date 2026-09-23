// Browser records outlive their processes and pids get reused: nothing may trust or signal a pid without checking
// it is still the process that was recorded. Tests only ever signal processes they spawned.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "figma-reader-test-"));
// Never touch the real state, cache or data directories. HOME is not what Windows reads: the roots there are built
// from APPDATA and LOCALAPPDATA, redirected below and created, as a real profile has them. USERPROFILE, which
// os.homedir() reads, is deliberately left alone: the launch tests below start a real Chromium, and one started
// with USERPROFILE pointing into a temp directory never opened a DevTools port at all (measured on a Windows
// runner: 20 s to the launch ceiling, against 1.3 s beside it). No manager here is left to find its own state
// directory, so nothing reads homedir() anyway.
process.env.HOME = root;
process.env.APPDATA = join(root, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(root, "AppData", "Local");
for (const d of [process.env.APPDATA, process.env.LOCALAPPDATA]) mkdirSync(d, { recursive: true });
const win = process.platform === "win32";
const { bootId, BrowserManager, browserCandidates, confinedPath, demoteConfined, liveLeases, pidAlive, processStart, profileHasLoginCookie, sameProcess, takeLease } =
  await import("../src/browser.ts");

const children: number[] = [];
after(() => {
  for (const pid of children) {
    try {
      process.kill(pid);
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
});

/**
 * A long-running process that is certainly not a browser on our profile: stands in for a reused pid. node runs it,
 * not sleep: Windows has no sleep of its own, and the one the runner happens to have comes from Git's bin directory
 * being on PATH, which is an accident for these tests to rest on.
 */
function bystander(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  children.push(child.pid!);
  return child.pid!;
}

let n = 0;
/** A manager whose "browser" only records that it was started, so a launch is detectable and harmless. */
function manager() {
  const dir = join(root, `m${n++}`);
  const exe = join(dir, "fake-browser");
  const marker = join(dir, "launched");
  mkdirSync(dir, { recursive: true });
  writeFileSync(exe, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(exe, 0o755);
  const m = new BrowserManager({ executablePath: exe, userDataDir: join(dir, "profile"), headless: true, stateDir: join(dir, "state") });
  return { m, marker, record: join(m.stateDir, "browser.json") };
}

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

let b = 0;
/**
 * A stand-in for a browser of ours: a process started with the profile on its command line, as a launch writes it.
 * That argument is not decoration - ownsProcess reads it on macOS, where ps's lstart resolves to one second and
 * cannot tell a pid reissued inside that second from the browser that held it.
 *
 * node runs the body rather than sh: Windows cannot run a shell script at all, and there is no intermediate shell
 * to exec anything, so the arguments the process reports are the ones written here and nothing is left behind for
 * after() to miss.
 */
function ourBrowser(userDataDir: string, body = "setTimeout(() => {}, 60_000)"): number {
  const script = join(root, `browser${b++}.mjs`);
  writeFileSync(script, `${body}\n`);
  const child = spawn(process.execPath, [script, `--user-data-dir=${userDataDir}`], { stdio: "ignore" });
  // A spawn that never started leaves pid undefined, and a record naming no pid is read as no record at all: the
  // tests below would then assert undefined against undefined and pass having stood nothing in for anything.
  assert.ok(child.pid, `${script} did not start`);
  children.push(child.pid);
  return child.pid;
}

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

const OTHER_BOOT = "0f9c8d2a-other-boot";

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

test("a lease carries the stamp of the process that wrote it, so a pid held by another process is not live", () => {
  // An empty stamp passes every test that only counts leases, and silently disables reused-pid detection for all
  // of them: liveLeases then falls back to plain liveness.
  const dir = join(root, "lease-stamp");
  const other = bystander();
  const borrowed = takeLease(dir, String(other)); // written by us, named for a live process that is not us
  assert.ok(readFileSync(borrowed, "utf8").length, "the lease is stamped");
  assert.deepEqual(liveLeases(dir), [], "the stamp says the named pid is not the process that took it");
  assert.ok(!existsSync(borrowed), "and the lease is dropped");
  const mine = takeLease(dir);
  assert.deepEqual(liveLeases(dir), [String(process.pid)]);
  rmSync(mine);
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

test("a browser executable that cannot be started rejects the launch instead of crashing the process", async () => {
  const dir = join(root, "missing");
  mkdirSync(dir, { recursive: true });
  const m = new BrowserManager({ executablePath: join(dir, "no-such-browser"), userDataDir: join(dir, "profile"), headless: true, stateDir: join(dir, "state") });
  await assert.rejects(m.launch(true, "work"), /Cannot start browser .*no-such-browser.*ENOENT/);
  await assert.rejects(m.launchLoginWindow("about:blank"), /Cannot start browser .*no-such-browser.*ENOENT/);
  // The second shape of refusal, which only Windows has: Node runs no .bat or .cmd without a shell, and says so by
  // throwing out of spawn rather than emitting an 'error' event, so this one does not pass through check() at all.
  if (win) {
    const cmd = join(dir, "launcher.cmd");
    writeFileSync(cmd, "@echo off\r\n");
    const viaScript = new BrowserManager({ executablePath: cmd, userDataDir: join(dir, "profile"), headless: true, stateDir: join(dir, "state") });
    await assert.rejects(viaScript.launch(true, "work"), /Cannot start browser .*launcher\.cmd.*EINVAL/);
    await assert.rejects(viaScript.launchLoginWindow("about:blank"), /Cannot start browser .*launcher\.cmd.*EINVAL/);
  }
});

// FIGMA_BROWSER_PATH first, so CI can point this at a browser it knows launches: /usr/bin/chromium exists on a
// GitHub runner but is a snap wrapper that never opens a DevTools port, which is a skip that hides the test.
test("a browser is chosen by what can run, and a confined build only as a last resort", () => {
  // existsSync was the only test, so a directory, a file without the execute bit and a snap wrapper all counted as
  // an installed browser. The snap is the one that bites: on Ubuntu /usr/bin/chromium is usually a link into one,
  // it was preferred over a native Chrome beside it, and it exits before opening a DevTools port.
  const bin = join(root, "picker");
  mkdirSync(join(bin, "a"), { recursive: true });
  mkdirSync(join(bin, "b"), { recursive: true });
  const put = (dir: string, name: string, mode: number) => {
    const p = join(bin, dir, name);
    writeFileSync(p, "#!/bin/sh\nexit 1\n");
    chmodSync(p, mode);
    return p;
  };
  // The names this platform looks for: Windows has no google-chrome-stable, and looks for an .exe.
  const [braveName, chromeName, chromiumName] = win ? ["brave.exe", "chrome.exe", "chromium.exe"] : ["brave", "google-chrome-stable", "chromium"];
  // Windows has no execute bit: fs.access(X_OK) succeeds for every file that exists, so "there, not runnable" is
  // not a state the picker can recognise there, and such a candidate is dropped by failing to launch instead.
  if (!win) put("a", chromiumName, 0o644); // there, not runnable
  mkdirSync(join(bin, "a", chromeName));  // a directory of that name
  const chrome = put("b", chromeName, 0o755);
  const brave = put("b", braveName, 0o755);
  // The directories are handed in rather than arranged behind the code's back: Windows searches the standard
  // install directories besides PATH, so emptying PATH still left the runner's own Chrome and Edge in front.
  const found = browserCandidates([join(bin, "a"), join(bin, "b")]);
  // brave before the Chrome spelling is the declared preference; neither of the two unusable files appears.
  assert.deepEqual(found.slice(0, 2), [brave, chrome]);
  if (!win) assert.ok(!found.includes(join(bin, "a", chromiumName)), "a file that cannot be executed is not a browser");
  assert.ok(!found.includes(join(bin, "a", chromeName)), "nor is a directory");
  // Playwright's build is refused by Google sign-in, so it comes last whatever else is installed.
  assert.ok(found.length === 2 || found[found.length - 1].includes("ms-playwright"), found.join(" "));
  // The ordering, which needs paths that no test machine has: a snap is preferred by name (chromium before
  // google-chrome-stable) and must still end up behind it, while staying in the list in case it is all there is.
  assert.deepEqual(
    demoteConfined(["/snap/bin/chromium", "/usr/bin/google-chrome-stable", "/var/lib/flatpak/app/x/chrome", "/usr/bin/brave"]),
    ["/usr/bin/google-chrome-stable", "/usr/bin/brave", "/snap/bin/chromium", "/var/lib/flatpak/app/x/chrome"],
  );
  // The rule itself, on the paths a link resolves to.
  for (const p of ["/snap/bin/chromium", "/var/lib/snapd/snap/bin/chromium", "/var/lib/flatpak/app/org.chromium.Chromium/current/chrome"]) {
    assert.equal(confinedPath(p), true, p);
  }
  for (const p of ["/usr/bin/chromium", "/usr/lib/brave/brave", "/opt/google/chrome/chrome"]) {
    assert.equal(confinedPath(p), false, p);
  }
});

/**
 * A browser that starts and exits at once without ever opening a DevTools port, which is what a confined build
 * does when it cannot reach the profile: the candidate a launch has to pass over. Windows runs no script as an
 * executable -- libuv spawns a PE image and nothing else, and Node refuses a .cmd outright unless it is given a
 * shell -- so there it is node itself, which is certainly runnable and rejects browser flags as bad node options.
 */
function dudBrowser(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  if (!win) {
    writeFileSync(path, "#!/bin/sh\nexit 1\n");
    chmodSync(path, 0o755);
    return path;
  }
  // A link, because node.exe is about 100 MB; a hard link cannot cross a volume, and the tool cache a runner keeps
  // node in need not be on the one holding the temp directory.
  try {
    linkSync(process.execPath, path);
  } catch {
    copyFileSync(process.execPath, path);
  }
  return path;
}

// brave comes before every other name in the preference order, so a dud under it is what a first launch gets.
const dudDir = join(root, "fallthrough");
const dud = dudBrowser(dudDir, win ? "brave.exe" : "brave");

const chromium = [process.env.FIGMA_BROWSER_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter((p) => p !== undefined).find(existsSync);
/**
 * A browser that really starts, for a launch to land on. A Unix lays out a wrapper around one beside the dud;
 * Windows can lay out no working stand-in at all (see dudBrowser) and does not need to, since the picker searches
 * the standard install directories besides PATH: the machine's own browser is the next candidate after the dud.
 */
const launchable = chromium ?? (win ? browserCandidates()[0] : undefined);

test("a browser that cannot start is passed over for one that can", { skip: !launchable && "no browser that starts" }, async () => {
  // The picker used to commit to the first browser that existed, so a snap Chromium was a dead end: it exits
  // without opening a DevTools port, and nothing tried the working Chrome beside it. Here the first candidate
  // exits at once, exactly as that one does, and the launch must end on the browser behind it.
  if (!win) {
    const real = join(dudDir, "chromium");
    writeFileSync(real, `#!/bin/sh\nexec ${chromium} "$@"\n`);
    chmodSync(real, 0o755);
  }
  const env = process.env.PATH;
  process.env.PATH = dudDir;
  const dir = join(root, "fallthrough-state");
  const manager = new BrowserManager({ userDataDir: join(dir, "profile"), headless: true, stateDir: join(dir, "state") });
  try {
    // Playwright's build is appended whatever else is installed, so what matters here is the first two.
    const found = browserCandidates();
    assert.equal(found[0], dud, "the dud is preferred, so it is what a first launch gets");
    assert.ok(found.length > 1, `nothing behind the dud to fall through to: ${found.join(" ")}`);
    await manager.launch(true, "work");
    const rec = manager.launchRecord()!;
    children.push(rec.pid);
    assert.equal(rec.exe, found[1], "the browser that started is the one recorded");
  } finally {
    process.env.PATH = env;
    await manager.release();
  }
});

test("a browser named outright is never quietly swapped for another", async () => {
  // Falling through is for a choice we made; someone who sets FIGMA_BROWSER_PATH made their own, and silently
  // using a different browser would answer about a profile and a login they did not ask for.
  const dir = join(root, "named-state");
  const manager = new BrowserManager({ executablePath: dud, userDataDir: join(dir, "profile"), headless: true, stateDir: join(dir, "state") });
  await assert.rejects(manager.launch(true, "work"), (e: Error) => {
    assert.match(e.message, /never opened a DevTools port/);
    assert.ok(e.message.includes(dud), "says which browser failed");
    assert.ok(!e.message.includes("No installed browser"), "did not fall through to another");
    return true;
  });
});

// A launch, the record it writes and the close that reads it, end to end on a real browser: the identity in that
// record is what stands between a reused pid and process.kill.
test("a launched headless browser is recorded with its identity and closed by release() from a fresh manager", { skip: !launchable && "no browser that starts" }, async () => {
  const dir = join(root, "real");
  const opts = { executablePath: launchable, userDataDir: join(dir, "profile"), headless: true, stateDir: join(dir, "state") };
  const first = new BrowserManager(opts);
  await first.launch(true, "work");
  const rec = first.launchRecord()!;
  children.push(rec.pid);
  assert.equal(rec.start, processStart(rec.pid));
  // Another manager (as in the next CLI run) has no session: it must connect to the running browser, not launch one.
  await new BrowserManager(opts).release();
  assert.ok(!pidAlive(rec.pid), "browser closed");
  assert.equal(first.launchRecord(), undefined);
});
