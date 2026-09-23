// Accounts keep projects that use different Figma logins isolated. Each named account has its own browser profile
// (the login) and its own snapshot cache, so one project never reuses another account's session or exported files.
// A project picks its account in .figma-reader.json; FIGMA_ACCOUNT (or the CLI's --account) overrides it.
// The per-platform roots everything we write hangs off live here too (appRoot), since accounts are most of it.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function checkAccountName(name: string): string {
  if (!NAME.test(name)) throw new Error(`invalid account name ${JSON.stringify(name)}: use letters, digits, '.', '_' or '-'`);
  return name;
}

export interface ProjectConfig {
  path: string;
  account?: string;
  /** Absolute; relative entries in the file are resolved against the file's directory. */
  filesDirs?: string[];
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
  return raw;
}

function readProjectConfig(path: string): ProjectConfig {
  const raw = readConfigObject(path);
  const base = dirname(path);
  return {
    path,
    account: raw.account === undefined ? undefined : checkAccountName(raw.account),
    filesDirs: raw.filesDirs?.map((d: string) => resolve(base, tilde(d))),
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

export function writeAccountInfo(name: string, user: { email: string; handle: string }) {
  mkdirSync(accountDir(name), { recursive: true });
  const info: AccountInfo = { email: user.email, handle: user.handle, verifiedAt: new Date().toISOString() };
  writeFileSync(join(accountDir(name), "account.json"), `${JSON.stringify(info, null, 2)}\n`);
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
