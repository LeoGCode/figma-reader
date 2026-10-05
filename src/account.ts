// Accounts keep projects that use different Figma logins isolated. Each named account has its own browser profile
// (the login) and its own snapshot cache, so one project never reuses another account's session or exported files.
// A project picks its account in .figma-reader.json; FIGMA_ACCOUNT (or the CLI's --account) overrides it.
// The per-platform roots everything we write hangs off live here too (appRoot), since accounts are most of it.
import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const CONFIG_FILE = ".figma-reader.json";
export const DEFAULT_ACCOUNT = "default";
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const tilde = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
export const expandHome = (p: string) => resolve(tilde(p));

const APP = "figma-reader";
export type AppRoot = "data" | "cache" | "state";
/** Linux and macOS: the XDG spelling, which is where every install made before this already keeps its files. */
const XDG: Record<AppRoot, string[]> = { data: [".local", "share"], cache: [".cache"], state: [".local", "state"] };

/**
 * Where this platform itself keeps that kind of file. Windows has no XDG directories: %APPDATA% is the half of a
 * user's profile that follows them between machines (the browser profile holding the login, account.json) and
 * %LOCALAPPDATA% the half that stays on the machine (snapshots, browser records, downloads). Both are read from the
 * environment, since a Windows profile may have been redirected elsewhere and only the variables say where.
 * macOS stays on the XDG paths although ~/Library/Application Support and ~/Library/Caches are its own answer:
 * those paths work there, and moving them would strand the logins and snapshots of every account that exists today.
 * env and platform are parameters so that both mappings can be checked from whichever platform runs the tests.
 */
export function appRoot(kind: AppRoot, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return join(homedir(), ...XDG[kind], APP);
  // Cache and state share %LOCALAPPDATA%, so each needs a name of its own below the application's directory.
  if (kind === "data") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), APP);
  return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), APP, kind === "cache" ? "Cache" : "State");
}

const dataRoot = () => appRoot("data");
export const accountDir = (name: string) => join(dataRoot(), "accounts", name);
/** FIGMA_READER_CACHE moves the cache root; accounts stay apart below it, as their snapshots must never mix. */
export const cacheRoot = () => (process.env.FIGMA_READER_CACHE ? expandHome(process.env.FIGMA_READER_CACHE) : appRoot("cache"));
export const accountCacheDir = (name: string) => join(cacheRoot(), "accounts", name);
/** One profile per browser binary: cookie encryption keys differ between Brave, Chromium and Chrome. */
export const accountProfileDir = (name: string, exe: string) =>
  join(accountDir(name), `profile-${basename(exe).replace(/[^a-z0-9-]/gi, "")}`);

/**
 * A write failed because this process may not make it there: a read-only sandbox (Codex's -s read-only), a read-only
 * mount, a directory another user owns. A macOS sandbox answers EPERM, as does Windows for a write its ACLs deny, where
 * Linux says EACCES or EROFS. A full or failing disk is something else, which moving elsewhere would not cure.
 */
export function mayNotWrite(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === "EROFS" || code === "EACCES" || code === "EPERM";
}

/** What cannotWrite ends with by default: the reads that would have needed no write at all. */
const READS_WITHOUT_WRITING =
  "Reading a local .fig by its path, or a key whose cached snapshot is still fresh (younger than FIGMA_SNAPSHOT_MAX_AGE_MIN, 30 minutes unless set), writes nothing.";

/**
 * The error for a write into one of the directories above that this process may not make (see mayNotWrite).
 * Raw, it was "EACCES: permission denied, mkdir '<path>'", which says neither what needed the directory nor that a
 * read needs none of it, and agents guessed. `doing` says what needed `dir`, `fix` what would let it; the system's
 * message stays in it, code and path included. `tail` is what reads without writing, which a write that no read could
 * stand in for (the image of a screenshot) leaves out. Any other error comes back as it is, to be thrown unchanged.
 */
export function cannotWrite(e: unknown, doing: string, dir: string, fix: string, tail = READS_WITHOUT_WRITING): unknown {
  if (!mayNotWrite(e)) return e;
  return new Error(`${doing} ${dir}, which this process may not write (${(e as Error).message}). ${fix}${tail ? ` ${tail}` : ""}`, { cause: e });
}

export function checkAccountName(name: string): string {
  if (!NAME.test(name)) throw new Error(`invalid account name ${JSON.stringify(name)}: use letters, digits, '.', '_' or '-'`);
  return name;
}

export interface ProjectConfig {
  path: string;
  account?: string;
  /** Absolute; relative entries in the file are resolved against the file's directory. */
  filesDirs?: string[];
  /**
   * Pages figma_search, figma_diff and figma_changes leave out by default, by name: archives, templates, a copied
   * design system.
   */
  excludePages?: string[];
}

/** The nearest .figma-reader.json from start upwards. */
export function findProjectConfig(start = process.cwd()): ProjectConfig | undefined {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const path = join(dir, CONFIG_FILE);
    if (existsSync(path)) return readProjectConfig(path);
    if (dirname(dir) === dir) return undefined;
  }
}

/** The file's JSON as written, after checking the fields this tool reads; other keys are kept untouched. */
function readConfigObject(path: string): Record<string, any> {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: expected a JSON object`);
  if (raw.account !== undefined && typeof raw.account !== "string") throw new Error(`${path}: "account" must be a string`);
  if (raw.filesDirs !== undefined && !(Array.isArray(raw.filesDirs) && raw.filesDirs.every((d: unknown) => typeof d === "string"))) {
    throw new Error(`${path}: "filesDirs" must be an array of paths`);
  }
  if (raw.excludePages !== undefined && !(Array.isArray(raw.excludePages) && raw.excludePages.every((p: unknown) => typeof p === "string"))) {
    throw new Error(`${path}: "excludePages" must be an array of page names`);
  }
  return raw;
}

function readProjectConfig(path: string): ProjectConfig {
  const raw = readConfigObject(path);
  const base = dirname(path);
  return {
    path,
    account: raw.account === undefined ? undefined : checkAccountName(raw.account),
    filesDirs: raw.filesDirs?.map((d: string) => resolve(base, tilde(d))),
    excludePages: raw.excludePages,
  };
}

export interface ResolvedAccount {
  name: string;
  /** Where the name came from: FIGMA_ACCOUNT / --account, the project file, or nothing set. */
  source: "env" | "project" | "default";
  config?: ProjectConfig;
}

export function resolveAccount(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ResolvedAccount {
  const config = findProjectConfig(cwd);
  if (env.FIGMA_ACCOUNT) return { name: checkAccountName(env.FIGMA_ACCOUNT), source: "env", config };
  if (config?.account) return { name: config.account, source: "project", config };
  return { name: DEFAULT_ACCOUNT, source: "default", config };
}

/**
 * A call refused before it began because nothing chose its account (see otherAccounts; tools.ts decides and words the
 * refusal). The CLI exits 2 on it, a single call and a batch alike. Kept here, with nothing to load, so that batch.ts
 * can tell a refused line from a failed one without importing the tools.
 */
export class AccountNotChosen extends Error {}

/**
 * The accounts that make the fallback to "default" a guess: nothing chose an account here, and these exist besides
 * it. "default" is then whichever login was set up first, often a personal one, and a call from a directory outside
 * the project (an agent's scratch directory) read client files through it with nothing in the answer to say so.
 * Empty when an account was chosen, "default" included (FIGMA_ACCOUNT, --account, a project file), or when "default"
 * is the only account there is, which is the setup every single-login machine has and keeps working as it did.
 * `accounts` is only called for the fallback, so a chosen account never depends on the data root being readable;
 * whatever it throws (see existingAccounts) is the caller's to refuse on.
 */
export function otherAccounts(resolved: ResolvedAccount, accounts: () => string[] = existingAccounts): string[] {
  return resolved.source === "default" ? accounts().filter((n) => n !== DEFAULT_ACCOUNT) : [];
}

/**
 * The accounts set up on this machine, for otherAccounts. listAccounts reads every failure as "no accounts", which for
 * the accounts command only shortens a list; here it let the fallback through on a machine whose other logins merely
 * could not be listed (EACCES, EIO, a home on a network share gone stale). So only a directory that is not there yet,
 * which is every machine that never logged in, means none, and any other failure is thrown. A symbolic link counts as
 * an account too, whatever it points at: it is not up to this check to prove that one is not a login.
 */
export function existingAccounts(dir = join(dataRoot(), "accounts")): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
    throw e;
  }
  return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name).sort();
}

/**
 * Bind a directory to an account, keeping the file's other settings. When the directory has no file yet but one above
 * it applies, the new file starts as a copy of that one (relative filesDirs rebased): a nearer file shadows the one
 * above completely, so writing only the account would silently drop the project's filesDirs here.
 */
export function writeProjectAccount(dir: string, account: string): { path: string; inheritedFrom?: string } {
  checkAccountName(account);
  const base = resolve(dir);
  const path = join(base, CONFIG_FILE);
  let raw: Record<string, any> = {};
  let inheritedFrom: string | undefined;
  if (existsSync(path)) raw = readConfigObject(path);
  else {
    const above = findProjectConfig(base);
    if (above) {
      const { account: _, ...rest } = readConfigObject(above.path);
      const from = dirname(above.path);
      raw = rest;
      if (rest.filesDirs) {
        raw.filesDirs = rest.filesDirs.map((d: string) => (isAbsolute(d) || /^~(\/|$)/.test(d) ? d : relative(base, resolve(from, d)) || "."));
      }
      inheritedFrom = above.path;
    }
  }
  writeFileSync(path, `${JSON.stringify({ ...raw, account }, null, 2)}\n`);
  return { path, inheritedFrom };
}

export interface AccountInfo {
  email?: string;
  handle?: string;
  verifiedAt?: string;
}

/** The Figma user last verified on this account, so it can be listed without starting a browser. */
export function readAccountInfo(name: string): AccountInfo {
  try {
    return JSON.parse(readFileSync(join(accountDir(name), "account.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Remember who the account's profile is logged in as; status and login call it once they have asked figma.com. */
export function writeAccountInfo(name: string, user: { email: string; handle: string }) {
  const info: AccountInfo = { email: user.email, handle: user.handle, verifiedAt: new Date().toISOString() };
  try {
    mkdirSync(accountDir(name), { recursive: true });
    writeFileSync(join(accountDir(name), "account.json"), `${JSON.stringify(info, null, 2)}\n`);
  } catch (e) {
    throw cannotWrite(e, "status and login record who the account's profile is logged in as (account.json) in figma-reader's data directory,", accountDir(name), "Run it where that directory is writable.");
  }
}

export function listAccounts(): string[] {
  try {
    return readdirSync(join(dataRoot(), "accounts"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
