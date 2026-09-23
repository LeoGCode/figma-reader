// Which account a project gets decides whose Figma login and snapshot cache it uses, so the precedence is pinned here.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  accountCacheDir, accountDir, accountProfileDir, appRoot, CONFIG_FILE, findProjectConfig, resolveAccount, writeProjectAccount,
} from "../src/account.ts";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// Resolution walks up to the filesystem root, so a config above the temp dir would leak into every test project.
const strayConfig = findProjectConfig(tmpdir())?.path;

// Absolute on this platform, not only on a POSIX one: "/abs/figma" is rooted on Windows but names no drive, so
// resolve() there hangs it off whichever drive the process runs on and it is no longer the path the test wrote.
const ABS = resolve("/abs/figma");
const CACHE_ROOT = resolve("/srv/figma-cache");

const project = (config?: object) => {
  const root = mkdtempSync(join(tmpdir(), "figma-reader-test-"));
  roots.push(root);
  if (config) writeFileSync(join(root, CONFIG_FILE), JSON.stringify(config));
  const nested = join(root, "packages", "web");
  mkdirSync(nested, { recursive: true });
  return { root, nested };
};

test("no project file and no env is the default account", { skip: strayConfig && `${strayConfig} is above the temp dir` }, () => {
  const { nested } = project();
  assert.deepEqual(resolveAccount({}, nested), { name: "default", source: "default", config: undefined });
});

test("the nearest project file above the working directory picks the account", () => {
  const { root, nested } = project({ account: "acme" });
  const r = resolveAccount({}, nested);
  assert.equal(r.name, "acme");
  assert.equal(r.source, "project");
  assert.equal(r.config?.path, join(root, CONFIG_FILE));
});

test("FIGMA_ACCOUNT overrides the project file", () => {
  const { nested } = project({ account: "acme" });
  const r = resolveAccount({ FIGMA_ACCOUNT: "personal" }, nested);
  assert.equal(r.name, "personal");
  assert.equal(r.source, "env");
});

test("filesDirs resolve against the project file's directory", () => {
  const { root, nested } = project({ filesDirs: ["design", ABS] });
  const r = resolveAccount({}, nested);
  assert.equal(r.name, "default");
  assert.deepEqual(r.config?.filesDirs, [join(root, "design"), ABS]);
});

test("account names cannot escape the accounts directory", () => {
  // Backslash and a drive letter are separators too, on the platform whose roots these directories now live in.
  for (const name of ["../other", "..", ".hidden", "a\\b", "C:\\evil", "a b"]) {
    assert.throws(() => resolveAccount({ FIGMA_ACCOUNT: name }, tmpdir()), /invalid account name/, `${JSON.stringify(name)} is refused`);
  }
  const { nested } = project({ account: "a/b" });
  assert.throws(() => resolveAccount({}, nested), /invalid account name/);
});

test("a malformed project file is reported with its path, not ignored", () => {
  const { root, nested } = project();
  writeFileSync(join(root, CONFIG_FILE), "{ nope");
  assert.throws(() => resolveAccount({}, nested), (e: Error) => e.message.startsWith(join(root, CONFIG_FILE)));
  writeFileSync(join(root, CONFIG_FILE), JSON.stringify({ account: 3 }));
  assert.throws(() => resolveAccount({}, nested), /"account" must be a string/);
});

test("use keeps the project file's other settings", () => {
  const { root } = project({ account: "old", filesDirs: ["design"], extra: { kept: true } });
  writeProjectAccount(root, "new");
  assert.deepEqual(JSON.parse(readFileSync(join(root, CONFIG_FILE), "utf8")), { account: "new", filesDirs: ["design"], extra: { kept: true } });
});

test("use creates the project file when there is none", { skip: strayConfig && `${strayConfig} is above the temp dir` }, () => {
  const { root } = project();
  assert.deepEqual(writeProjectAccount(root, "acme"), { path: join(root, CONFIG_FILE), inheritedFrom: undefined });
  assert.deepEqual(JSON.parse(readFileSync(join(root, CONFIG_FILE), "utf8")), { account: "acme" });
});

test("use in a subdirectory keeps the settings of the project file above it", () => {
  // The new, nearer file shadows the project's, whose filesDirs used to be dropped here without a word.
  const { root, nested } = project({ account: "acme", filesDirs: ["design", ABS, "~/Downloads"], extra: 1 });
  const r = writeProjectAccount(nested, "personal");
  assert.deepEqual(r, { path: join(nested, CONFIG_FILE), inheritedFrom: join(root, CONFIG_FILE) });
  // The rebased entry is written with this platform's separator, which is the spelling resolve() reads back below.
  assert.deepEqual(JSON.parse(readFileSync(r.path, "utf8")), { filesDirs: [join("..", "..", "design"), ABS, "~/Downloads"], extra: 1, account: "personal" });
  const resolved = resolveAccount({}, nested);
  assert.equal(resolved.name, "personal");
  assert.deepEqual(resolved.config?.filesDirs, [join(root, "design"), ABS, join(homedir(), "Downloads")]);
  assert.equal(JSON.parse(readFileSync(join(root, CONFIG_FILE), "utf8")).account, "acme", "the project's own file is untouched");
});

test("use refuses to overwrite a malformed project file, naming it", () => {
  const { root } = project();
  const path = join(root, CONFIG_FILE);
  writeFileSync(path, "{ nope");
  assert.throws(() => writeProjectAccount(root, "acme"), (e: Error) => e.message.startsWith(path));
  // An array used to be spread into {"0": ...} and written back.
  writeFileSync(path, "[1]");
  assert.throws(() => writeProjectAccount(root, "acme"), /expected a JSON object/);
  assert.equal(readFileSync(path, "utf8"), "[1]");
});

test("accounts never share a profile or a cache", () => {
  assert.notEqual(accountProfileDir("a", "/usr/bin/brave"), accountProfileDir("b", "/usr/bin/brave"));
  assert.notEqual(accountCacheDir("a"), accountCacheDir("b"));
  assert.equal(accountProfileDir("a", "/usr/bin/brave"), join(accountDir("a"), "profile-brave"));
});

test("FIGMA_READER_CACHE moves the cache root but keeps accounts apart below it", () => {
  // It used to replace the per-account directory, so every account shared one snapshot cache.
  const saved = process.env.FIGMA_READER_CACHE;
  try {
    process.env.FIGMA_READER_CACHE = CACHE_ROOT;
    assert.equal(accountCacheDir("a"), join(CACHE_ROOT, "accounts", "a"));
    assert.notEqual(accountCacheDir("a"), accountCacheDir("b"));
    delete process.env.FIGMA_READER_CACHE;
    // Unset falls back to this platform's cache root, whichever that is; test/app-dirs.test.ts pins the roots.
    assert.equal(accountCacheDir("a"), join(appRoot("cache"), "accounts", "a"));
  } finally {
    if (saved === undefined) delete process.env.FIGMA_READER_CACHE;
    else process.env.FIGMA_READER_CACHE = saved;
  }
});
