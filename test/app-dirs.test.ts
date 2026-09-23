// The trees this tool writes to have to be the ones the platform itself keeps such files in: Windows has never
// heard of ~/.local/state, and a login profile, a snapshot cache and a lease directory invented there are outside
// everything that backs up, syncs or cleans a Windows profile. Both mappings are pinned from whichever platform
// runs the suite, because CI has one job per platform and a mapping only one job can reach is one nobody reads
// until a user hits it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

const root = mkdtempSync(join(tmpdir(), "figma-reader-test-"));
process.env.HOME = root; // never name the real ~/.local/share, ~/.cache or ~/.local/state
process.env.USERPROFILE = root; // homedir() reads this one, not HOME, on Windows
// The Windows halves of that same profile, so the run on Windows names the temp directory rather than the real one.
process.env.APPDATA = join(root, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(root, "AppData", "Local");
delete process.env.FIGMA_READER_CACHE; // this file is about where the roots are when nothing moves them
const { accountCacheDir, accountDir, accountProfileDir, appRoot, checkAccountName } = await import("../src/account.ts");
const { defaultStateDir } = await import("../src/browser.ts");
after(() => rmSync(root, { recursive: true, force: true }));

/** A Windows environment as Windows sets it, so a run on Linux asserts the same mapping a Windows run gets. */
const WIN = { APPDATA: "C:\\Users\\dev\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" };

test("Windows keeps the login profile roaming and the rest on the machine", () => {
  assert.equal(appRoot("data", WIN, "win32"), join(WIN.APPDATA, "figma-reader"));
  assert.equal(appRoot("cache", WIN, "win32"), join(WIN.LOCALAPPDATA, "figma-reader", "Cache"));
  assert.equal(appRoot("state", WIN, "win32"), join(WIN.LOCALAPPDATA, "figma-reader", "State"));
  // Cache and state share %LOCALAPPDATA%: one name for both would be one tree holding snapshots and leases alike,
  // and clearing the cache would take the record of the running browser with it.
  assert.notEqual(appRoot("cache", WIN, "win32"), appRoot("state", WIN, "win32"));
});

test("Windows without those variables falls back to the AppData directories of the profile", () => {
  // A service, or a process started with a scrubbed environment, is handed neither. The directories Windows itself
  // uses are still where the profile is; ~/.local/state there would be a directory nothing else on the machine knows.
  assert.equal(appRoot("data", {}, "win32"), join(homedir(), "AppData", "Roaming", "figma-reader"));
  assert.equal(appRoot("cache", {}, "win32"), join(homedir(), "AppData", "Local", "figma-reader", "Cache"));
  assert.equal(appRoot("state", {}, "win32"), join(homedir(), "AppData", "Local", "figma-reader", "State"));
});

test("Linux and macOS keep the XDG layout, whatever the environment holds", () => {
  // macOS has ~/Library/Application Support and ~/Library/Caches, but every account that exists today has its login
  // and its snapshots under these paths, and they work there: moving them would sign those accounts out.
  for (const platform of ["linux", "darwin"] as const) {
    assert.equal(appRoot("data", WIN, platform), join(homedir(), ".local", "share", "figma-reader"));
    assert.equal(appRoot("cache", WIN, platform), join(homedir(), ".cache", "figma-reader"));
    assert.equal(appRoot("state", WIN, platform), join(homedir(), ".local", "state", "figma-reader"));
  }
});

test("every directory the code uses hangs off one of those roots", () => {
  assert.equal(accountDir("a"), join(appRoot("data"), "accounts", "a"));
  assert.equal(accountCacheDir("a"), join(appRoot("cache"), "accounts", "a"));
  assert.equal(defaultStateDir(), appRoot("state"));
});

/**
 * Names checkAccountName accepts, including the ones that mean something of their own on Windows: reserved device
 * names, a name ending in a dot, and names spelled like the directories beside the account roots.
 */
const NAMES = ["default", "acme", "Acme", "ACME", "con", "nul", "com1", "a.b", "a.", "x_y", "x-1", "cache", "Cache", "State", "accounts", "figma-reader", "a".repeat(64)];

test("an accepted account name stays under its root, on a case-insensitive filesystem too", () => {
  for (const name of NAMES) {
    assert.equal(checkAccountName(name), name, `${name} is accepted`);
    const dirs = [
      [appRoot("data"), accountDir(name)],
      [appRoot("data"), accountProfileDir(name, "brave")],
      [appRoot("cache"), accountCacheDir(name)],
    ];
    for (const [under, dir] of dirs) {
      // relative() is what tells "below" from "beside", and on Windows it compares the two path roots without case:
      // startsWith on the spellings of one root would answer no for C:\Users and c:\users.
      const rel = relative(under, dir);
      assert.ok(rel && !isAbsolute(rel) && !rel.split(sep).includes(".."), `${dir} is not under ${under}`);
      // A name spelled like a root beside this one must not reach it: State is a sibling of Cache on Windows, and on
      // that filesystem "state" and "State" are the same directory.
      for (const other of ["data", "cache", "state"] as const) assert.notEqual(dir.toLowerCase(), appRoot(other).toLowerCase());
    }
  }
});
