// The tabs a profile would reopen: dropped before each launch of our own profile, and never from one given to us.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserManager, dudBrowser, root, win } from "./browser-helpers.ts";

// brave comes before every other name in the preference order, so a dud under it is what a first launch gets.
const dudDir = join(root, "fallthrough");
const dud = dudBrowser(dudDir, win ? "brave.exe" : "brave");

test("a launch forgets the tabs our own profile would reopen, and never those of a profile it was given", async () => {
  // Brave restores the last session by default: every launch reloaded the editor tabs earlier runs left open, and a
  // login window came up beside a restored window with a second Figma login page in it. The login itself is in the
  // cookie DB, which must survive; a FIGMA_USER_DATA_DIR profile may be someone's own browser, and keeps its tabs.
  // Sessions_Encrypted is where Chromium's EncryptSessionStorage restores from once it reads that first.
  for (const ownsProfile of [true, false]) {
    for (const purpose of ["work", "login"] as const) {
      const dir = join(root, `session-${ownsProfile}-${purpose}`);
      const profile = join(dir, "profile");
      for (const s of ["Sessions", "Sessions_Encrypted"]) {
        mkdirSync(join(profile, "Default", s), { recursive: true });
        writeFileSync(join(profile, "Default", s, "Tabs_13434747262928246"), "");
      }
      writeFileSync(join(profile, "Default", "Cookies"), "");
      const m = new BrowserManager({ executablePath: dud, userDataDir: profile, ownsProfile, headless: true, stateDir: join(dir, "state") });
      if (purpose === "work") await assert.rejects(m.launch(true, "work"), /never opened a DevTools port/);
      else await m.launchLoginWindow("about:blank");
      for (const s of ["Sessions", "Sessions_Encrypted"]) {
        assert.equal(existsSync(join(profile, "Default", s)), !ownsProfile, `${s}, ${purpose} launch, ownsProfile ${ownsProfile}`);
      }
      assert.ok(existsSync(join(profile, "Default", "Cookies")), "the login is kept");
    }
  }
});

// The browser reads its session as it starts, so what counts is what the profile holds at the spawn itself. A fake
// browser looking for itself loses the race to whatever runs synchronously after spawn() returns, so spawn is
// wrapped instead: the answer is taken at the call, in this process, before any line after it.
test("the saved tabs are gone before the browser starts, not after", async () => {
  const childProcess = createRequire(import.meta.url)("node:child_process");
  const realSpawn = childProcess.spawn;
  for (const purpose of ["work", "login"] as const) {
    const dir = join(root, `session-order-${purpose}`);
    const profile = join(dir, "profile");
    const left = () => ["Sessions", "Sessions_Encrypted"].filter((s) => existsSync(join(profile, "Default", s)));
    for (const s of ["Sessions", "Sessions_Encrypted"]) mkdirSync(join(profile, "Default", s), { recursive: true });
    const atSpawn: string[][] = [];
    childProcess.spawn = (exe: string, args: string[], ...rest: unknown[]) => {
      if (args.includes(`--user-data-dir=${profile}`)) atSpawn.push(left());
      return realSpawn(exe, args, ...rest);
    };
    syncBuiltinESMExports();
    try {
      const m = new BrowserManager({ executablePath: dud, userDataDir: profile, ownsProfile: true, headless: true, stateDir: join(dir, "state") });
      if (purpose === "work") await assert.rejects(m.launch(true, "work"), /never opened a DevTools port/);
      else await m.launchLoginWindow("about:blank");
    } finally {
      childProcess.spawn = realSpawn;
      syncBuiltinESMExports();
    }
    assert.deepEqual(atSpawn, [[]], `${purpose} launch: one spawn, with no saved tabs left at it`);
  }
});

// Windows refuses to delete a session file a running browser has open, since Chromium opens them with no sharing
// (read from its source, not measured). A directory we may not write stands in for that: the other directory must
// still go, and the launch must go on to its own outcome.
test("saved tabs that cannot be removed do not stop the launch", { skip: (win || process.getuid?.() === 0) && "permissions do not bind here" }, async () => {
  const dir = join(root, "session-locked");
  const profile = join(dir, "profile");
  const locked = join(profile, "Default", "Sessions");
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, "Tabs_13434747262928246"), "");
  chmodSync(locked, 0o555);
  try {
    for (const purpose of ["work", "login"] as const) {
      mkdirSync(join(profile, "Default", "Sessions_Encrypted"), { recursive: true });
      const m = new BrowserManager({ executablePath: dud, userDataDir: profile, ownsProfile: true, headless: true, stateDir: join(dir, `state-${purpose}`) });
      if (purpose === "work") await assert.rejects(m.launch(true, "work"), /never opened a DevTools port/);
      else await m.launchLoginWindow("about:blank");
      assert.ok(existsSync(join(locked, "Tabs_13434747262928246")), `${purpose}: could not be removed, and was not`);
      assert.ok(!existsSync(join(profile, "Default", "Sessions_Encrypted")), `${purpose}: the one that could be removed was`);
    }
  } finally {
    chmodSync(locked, 0o755);
  }
});
