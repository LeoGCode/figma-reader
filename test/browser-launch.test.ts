// Starting a browser: which one is chosen, what a launch that cannot start says, what it records, and a real launch
// closed again by another manager.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrowserManager, browserCandidates, children, confinedPath, demoteConfined, dudBrowser, pidAlive, processStart, root, win,
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

// A real browser behind the dud, and on Windows every record written and read on the way costs a PowerShell call:
// measured at 9 s on one runner and 24 s on a slower one, which is too close to the suite's 30 s ceiling.
test("a browser that cannot start is passed over for one that can", { skip: !launchable && "no browser that starts", timeout: 60_000 }, async () => {
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
