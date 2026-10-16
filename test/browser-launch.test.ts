// Starting a browser: which one is chosen, what a launch that cannot start says, what it records, and a real launch
// closed again by another manager.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
  BrowserManager, browserCandidates, browserSearchDirs, children, confinedPath, demoteConfined, dudBrowser, pidAlive, processStart, root,
  throwawayProfile, win,
} from "./browser-helpers.ts";

test("a write the state directory refuses once registered is said in words: the launch record, the busy lease", { skip: (win || process.getuid?.() === 0) && "permissions do not bind here" }, async (t) => {
  // Registering, the first write there, is worded where the manager is made (tools.ts). The two after it said only
  // "EACCES: permission denied", with the path of a temporary file nobody asked about.
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/none", "User-Agent": "Chrome/1" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const dir = join(root, "unwritable-state");
  const profile = join(dir, "profile");
  const exe = join(dir, "fake-browser");
  mkdirSync(dir, { recursive: true });
  // A "browser" that says where its DevTools port is, as Chromium does in the profile, and exits: the launch reads it
  // and goes on to record the browser, with nothing left running.
  writeFileSync(exe, `#!/bin/sh\nprintf '${port}\\n/devtools/browser/none\\n' > '${join(profile, "DevToolsActivePort")}'\n`);
  chmodSync(exe, 0o755);
  const m = new BrowserManager({ executablePath: exe, userDataDir: profile, headless: true, stateDir: join(dir, "state") });
  chmodSync(m.stateDir, 0o555);
  const said = (what: string) => (e: Error) => {
    assert.ok(e.message.startsWith(`${what} in figma-reader's state directory, under ${m.stateDir}, which this process may not write (EACCES: `), e.message);
    assert.match(e.message, /\)\. Run it where that directory is writable\. Reading a local \.fig by its path/);
    return true;
  };
  try {
    await assert.rejects(m.launch(true, "work"), said("launching the browser records it (browser.json)"));
    let ran = false;
    await assert.rejects(m.busy(async () => void (ran = true)), said("a call through the browser marks it busy"));
    assert.equal(ran, false, "and nothing ran unannounced");
  } finally {
    chmodSync(m.stateDir, 0o755);
  }
});

test("a launch that fails after its browser started does not leave that browser running", { skip: (win || process.getuid?.() === 0) && "a POSIX stand-in, and permissions that bind" }, async (t) => {
  // Measured on Windows 11: a read that failed while the new browser was still writing its DevTools port escaped the
  // launch, and the browser, already up, ran on with no record. Nothing ever closed it, and every later call worked
  // in it. Here the record cannot be written, which fails the launch at the same point, after the spawn.
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/none", "User-Agent": "Chrome/1" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const dir = join(root, "orphan");
  const profile = join(dir, "profile");
  const exe = join(dir, "lingering-browser");
  mkdirSync(profile, { recursive: true });
  // Says where its port is, as Chromium does, and stays up as a browser would; its pid is left beside it.
  writeFileSync(exe, `#!/bin/sh\necho $$ > '${join(dir, "pid")}'\nprintf '${port}\\n/devtools/browser/none\\n' > '${join(profile, "DevToolsActivePort")}'\nexec sleep 30\n`);
  chmodSync(exe, 0o755);
  const m = new BrowserManager({ executablePath: exe, userDataDir: profile, headless: true, stateDir: join(dir, "state") });
  chmodSync(m.stateDir, 0o555);
  try {
    await assert.rejects(m.launch(true, "work"), /launching the browser records it/);
  } finally {
    chmodSync(m.stateDir, 0o755);
  }
  const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
  for (let i = 0; i < 50 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!pidAlive(pid), "the browser it started was stopped");
});

test("a launch that gives up waiting for the port does not leave its browser starting", { skip: win && "a POSIX stand-in" }, async () => {
  // One slow enough to outlast the wait (Edge took 10 s to start on a loaded Windows VM) would open its port later
  // with no record: found by every later call, closed by none.
  const dir = join(root, "slow-start");
  const profile = join(dir, "profile");
  const exe = join(dir, "slow-browser");
  mkdirSync(profile, { recursive: true });
  writeFileSync(exe, `#!/bin/sh\necho $$ > '${join(dir, "pid")}'\nexec sleep 30\n`);
  chmodSync(exe, 0o755);
  const m = new BrowserManager({ executablePath: exe, userDataDir: profile, headless: true, stateDir: join(dir, "state"), launchWaitMs: 1000 });
  await assert.rejects(m.launch(true, "work"), /never opened a DevTools port/);
  const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
  for (let i = 0; i < 50 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!pidAlive(pid), "the browser it started was stopped");
});

/**
 * A browser for the profile that holds its lock as Chromium does (SingletonLock names "<host>-<pid>") and stays up
 * without a DevTools port: started with `args`, it reports what it was launched with, as a browser's command line does.
 */
function lockHolderScript(dir: string, profile: string) {
  const script = join(dir, "holder.mjs");
  writeFileSync(script, "setTimeout(() => {}, 30_000);\n");
  // Its output away from the shell's: whoever waits on that shell (spawnSync) would otherwise wait for this too.
  return (args: string) => `'${process.execPath}' '${script}' ${args} </dev/null >/dev/null 2>&1 &\nln -s '${hostname()}'-$! '${join(profile, "SingletonLock")}'\necho $! > '${join(dir, "pid")}'\n`;
}

test("a launch that gives up stops the browser a launcher handed it to, not someone else's on the profile", { skip: win && "a POSIX stand-in" }, async () => {
  // A launcher that forks the browser and exits leaves the child gone already: stopping only the child left the
  // browser it started running, unrecorded, and named it "another browser".
  const dir = join(root, "forking-launcher");
  const profile = join(dir, "profile");
  mkdirSync(profile, { recursive: true });
  const exe = join(dir, "launcher");
  writeFileSync(exe, `#!/bin/sh\n${lockHolderScript(dir, profile)('"$@"')}exit 0\n`);
  chmodSync(exe, 0o755);
  const m = new BrowserManager({ executablePath: exe, userDataDir: profile, headless: true, stateDir: join(dir, "state"), launchWaitMs: 1000 });
  await assert.rejects(m.launch(true, "work"), /never opened a DevTools port/);
  const forked = Number(readFileSync(join(dir, "pid"), "utf8"));
  for (let i = 0; i < 50 && pidAlive(forked); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!pidAlive(forked), "the browser the launcher started was stopped");

  // Someone else's browser already on the profile, without this launch's tag: the launch is handed to it, as Chromium
  // does, and it is named, and left running.
  const other = join(root, "foreign-holder");
  const otherProfile = join(other, "profile");
  mkdirSync(otherProfile, { recursive: true });
  const holder = join(other, "holder.sh");
  writeFileSync(holder, `#!/bin/sh\n${lockHolderScript(other, otherProfile)(`--user-data-dir=${otherProfile}`)}`);
  chmodSync(holder, 0o755);
  spawnSync(holder);
  const theirs = Number(readFileSync(join(other, "pid"), "utf8"));
  children.push(theirs);
  const handoff = join(other, "handoff");
  writeFileSync(handoff, "#!/bin/sh\nexit 0\n");
  chmodSync(handoff, 0o755);
  const n = new BrowserManager({ executablePath: handoff, userDataDir: otherProfile, headless: true, stateDir: join(other, "state"), launchWaitMs: 1000 });
  await assert.rejects(n.launch(true, "work"), new RegExp(`in use by another browser \\(pid ${theirs}\\)`));
  assert.ok(pidAlive(theirs), "and theirs was left running");
});

test("a DevTools port file that cannot be read is no browser yet, not a failed launch", async () => {
  // On Windows the browser holds the file locked while it writes it, and the EBUSY that read raised failed the launch
  // outright. A directory of that name can be neither read nor removed, here as there.
  const dir = join(root, "unreadable-port");
  const profile = join(dir, "profile");
  mkdirSync(join(profile, "DevToolsActivePort"), { recursive: true });
  const exe = dudBrowser(join(dir, "bin"), win ? "brave.exe" : "brave");
  const m = new BrowserManager({ executablePath: exe, userDataDir: profile, headless: true, stateDir: join(dir, "state") });
  await assert.rejects(m.launch(true, "work"), (e: Error) => {
    assert.match(e.message, /never opened a DevTools port/, "the launch's own answer about a browser that did not start");
    assert.doesNotMatch(e.message, /EISDIR|EBUSY|is a directory/i);
    return true;
  });
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

test("on a Mac the browsers in /Applications are found, behind any on PATH", () => {
  // A Mac app is never on PATH, so Brave in /Applications was "No Chromium-family browser found" until
  // FIGMA_BROWSER_PATH named it. The platform is handed in, so this runs wherever the suite does.
  const bundle = (app: string) => join("Applications", `${app}.app`, "Contents", "MacOS");
  const dirs = browserSearchDirs("darwin");
  for (const app of ["Brave Browser", "Google Chrome", "Chromium", "Microsoft Edge"]) {
    assert.ok(dirs.includes(join("/", bundle(app))), `/Applications holds ${app}`);
    assert.ok(dirs.includes(join(homedir(), bundle(app))), `and so does ~/Applications`);
  }
  // Only the bundles this adds: PATH itself holds .app directories on a Mac (an editor's bin, say), measured in a
  // terminal there, where the first version of this check failed on them.
  const elsewhere = browserSearchDirs("linux");
  assert.ok(!elsewhere.includes(join("/", bundle("Brave Browser"))), "no bundle is looked for off a Mac");
  assert.ok(!elsewhere.includes(join(homedir(), bundle("Brave Browser"))));

  const mac = join(root, "mac-picker");
  const onPath = join(mac, "bin");
  const brave = join(mac, bundle("Brave Browser"));
  for (const [dir, name] of [[onPath, "chromium"], [brave, "Brave Browser"]]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), "#!/bin/sh\nexit 1\n");
    chmodSync(join(dir, name), 0o755);
  }
  const found = browserCandidates([onPath, brave], "darwin");
  assert.deepEqual(found.slice(0, 2), [join(onPath, "chromium"), join(brave, "Brave Browser")], "PATH first, then the app");
  assert.ok(!browserCandidates([brave], "linux").includes(join(brave, "Brave Browser")), "an app's name is a Mac's alone");
});

// brave comes before every other name in the preference order, so a dud under it is what a first launch gets.
const dudDir = join(root, "fallthrough");
const dud = dudBrowser(dudDir, win ? "brave.exe" : "brave");

const chromium = [process.env.FIGMA_BROWSER_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter((p) => p !== undefined).find(existsSync);
/**
 * A browser that really starts, for a launch to land on. One known by path gets a wrapper beside the dud. Windows and
 * macOS need none, since the picker searches their install directories besides PATH (Program Files, /Applications):
 * the machine's own browser is the next candidate after the dud. Windows could lay out no working stand-in anyway (see
 * dudBrowser). macOS was left out until its picker found /Applications, so its runner skipped both tests below.
 */
const launchable = chromium ?? (win || process.platform === "darwin" ? browserCandidates()[0] : undefined);

// A real browser behind the dud, and on Windows every record written and read on the way costs a PowerShell call:
// measured at 9 s on one runner and 24 s on a slower one, which is too close to the suite's 30 s ceiling.
test("a browser that cannot start is passed over for one that can", { skip: !launchable && "no browser that starts", timeout: 60_000 }, async () => {
  // The picker used to commit to the first browser that existed, so a snap Chromium was a dead end: it exits
  // without opening a DevTools port, and nothing tried the working Chrome beside it. Here the first candidate
  // exits at once, exactly as that one does, and the launch must end on the browser behind it.
  if (!win && chromium) {
    const real = join(dudDir, "chromium");
    writeFileSync(real, `#!/bin/sh\nexec "${chromium}" "$@"\n`);
    chmodSync(real, 0o755);
  }
  const env = process.env.PATH;
  process.env.PATH = dudDir;
  const dir = join(root, "fallthrough-state");
  const manager = new BrowserManager({ userDataDir: throwawayProfile(join(dir, "profile")), ownsProfile: true, headless: true, stateDir: join(dir, "state") });
  try {
    // Playwright's build is appended whatever else is installed, so what matters here is the first two.
    const found = browserCandidates();
    assert.equal(found[0], dud, "the dud is preferred, so it is what a first launch gets");
    assert.ok(found.length > 1, `nothing behind the dud to fall through to: ${found.join(" ")}`);
    await manager.launch(true, "work");
    const rec = manager.launchRecord();
    assert.ok(rec, "the browser that started is recorded");
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
  const opts = { executablePath: launchable, userDataDir: throwawayProfile(join(dir, "profile")), ownsProfile: true, headless: true, stateDir: join(dir, "state") };
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
