// What the browser test files (test/browser-*.test.ts) share: a temp root that the state, data and cache roots are
// moved into before the browser module is loaded, the processes the tests spawn (killed when the file ends), and the
// stand-ins they launch. Not a test file itself.
//
// They were one file until it took 21.4 s of the 30 s --test-timeout on Node 22.18, which applies the timeout to each
// test file as a whole as well as to each test in it, and 24.9 s on a loaded machine: real timers, mostly (a heartbeat
// a second process has to show, a target list that never answers, launches that wait for a window). Each theme is a
// file of its own now, and the runner runs the files side by side.
import { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const root = mkdtempSync(join(tmpdir(), "figma-reader-test-"));
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
export const win = process.platform === "win32";
export const {
  bootId,
  BrowserManager,
  browserCandidates,
  confinedPath,
  demoteConfined,
  LEASE_BEAT_MS,
  liveLeases,
  pidAlive,
  pidNamespace,
  processStamp,
  processStart,
  profileHasLoginCookie,
  sameProcess,
  takeLease,
} = await import("../src/browser.ts");

export const children: number[] = [];
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
export function bystander(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  children.push(child.pid!);
  return child.pid!;
}

let n = 0;
/** A manager whose "browser" only records that it was started, so a launch is detectable and harmless. */
export function manager() {
  const dir = join(root, `m${n++}`);
  const exe = join(dir, "fake-browser");
  const marker = join(dir, "launched");
  mkdirSync(dir, { recursive: true });
  writeFileSync(exe, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(exe, 0o755);
  const m = new BrowserManager({ executablePath: exe, userDataDir: join(dir, "profile"), headless: true, stateDir: join(dir, "state") });
  return { m, marker, record: join(m.stateDir, "browser.json") };
}

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
export function ourBrowser(userDataDir: string, body = "setTimeout(() => {}, 60_000)"): number {
  const script = join(root, `browser${b++}.mjs`);
  writeFileSync(script, `${body}\n`);
  const child = spawn(process.execPath, [script, `--user-data-dir=${userDataDir}`], { stdio: "ignore" });
  // A spawn that never started leaves pid undefined, and a record naming no pid is read as no record at all: the
  // tests below would then assert undefined against undefined and pass having stood nothing in for anything.
  assert.ok(child.pid, `${script} did not start`);
  children.push(child.pid);
  return child.pid;
}

/** The boot id of a boot that is not this one. */
export const OTHER_BOOT = "0f9c8d2a-other-boot";

/**
 * A browser that starts and exits at once without ever opening a DevTools port, which is what a confined build
 * does when it cannot reach the profile: the candidate a launch has to pass over. Windows runs no script as an
 * executable -- libuv spawns a PE image and nothing else, and Node refuses a .cmd outright unless it is given a
 * shell -- so there it is node itself, which is certainly runnable and rejects browser flags as bad node options.
 */
export function dudBrowser(dir: string, name: string): string {
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
