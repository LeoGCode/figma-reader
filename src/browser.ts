// Browser lifecycle: attach to FIGMA_CDP_URL, or launch a Chromium-family executable on a persistent profile
// (headless for work, headed for login). Launched browsers are shared by every server using the same profile,
// discovered through Chromium's DevToolsActivePort file, and closed when the last server exits.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { appRoot } from "./account.ts";
import { CdpSession, sleep, type TargetInfo } from "./cdp.ts";

export interface BrowserOptions {
  /** Attach to an already running browser instead of launching one. */
  cdpUrl?: string;
  /** Browser executable; defaults to Playwright's Chromium. */
  executablePath?: string;
  /** Persistent profile directory (cookies = Figma login). */
  userDataDir: string;
  headless: boolean;
  stateDir: string;
}

interface LaunchRecord {
  pid: number;
  headless: boolean;
  purpose: "work" | "login";
  exe?: string;
  /** processStart() of pid when the record was written: a pid reused by another process has a different one. */
  start?: string;
  /** bootId() when the record was written: `start` counts from boot, so it means nothing after another one. */
  boot?: string;
  /** pidNamespace() of the process that launched it, which is the one `pid` is numbered in (see readRecord). */
  ns?: string;
  /** Unix ms just before the launch; a login window only counts auth cookies written after it. */
  launchedAt?: number;
}

/** How long the target list may take. A browser answers it in milliseconds; the ceiling is for one that cannot. */
const LIST_TIMEOUT_MS = 5_000;

export function pidAlive(pid: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}

// Windows has neither /proc nor ps, and wmic is not on a current image at all (gone from windows-latest, build
// 26100), so PowerShell is what can be asked about a process there. It is named by its own path because a server's
// environment need not carry System32 on PATH, and Windows PowerShell is in every supported version of Windows.
const POWERSHELL = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** One PowerShell expression about a process. Measured at 240-320 ms a call on a warm runner, so nothing asks twice. */
function powershell(expr: string): string | undefined {
  try {
    const out = execFileSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", expr], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

let ownStart: string | null | undefined;

/**
 * Opaque start time of a process, stable for its whole life, so a pid can be told apart from a later process that
 * reuses it. Linux: /proc/<pid>/stat field 22 (starttime, clock ticks since boot). Windows: Get-Process StartTime,
 * in 100 ns ticks from an absolute epoch. macOS: ps's lstart.
 *
 * The three do not resolve alike. A Linux tick is 10 ms; Windows counts from the process's own creation, and five
 * children spawned back to back on a runner came out 4.6 to 13 ms apart with no two alike. On both, a pid reissued
 * later is a different identity. lstart is one second, so on macOS two processes started inside one second are one
 * identity - a parent and the child it spawns routinely are - and every check built on this is that much weaker
 * there. ownsProcess, the one that authorises process.kill, reads the command line as well.
 *
 * Undefined where none of that can be read (no PowerShell, a process whose times this user may not see). Callers
 * then fall back to what they can still prove, which for ownsProcess is the command line and nothing weaker.
 */
export function processStart(pid: number): string | undefined {
  if (!pid) return undefined;
  if (pid !== process.pid) return readStart(pid);
  // Our own start time cannot change while we run, and it is what every lease and tab mark we write carries.
  // Reading it spawns a process off Linux - 300 ms of PowerShell on Windows - and takeLease asks for it each time.
  if (ownStart === undefined) ownStart = readStart(pid) ?? null;
  return ownStart ?? undefined;
}

function readStart(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name (field 2) is parenthesized and may contain spaces or ')'; fields restart after the last ')'.
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || undefined;
    } catch {
      return undefined;
    }
  }
  // Digits alone, which the stamp formats below need: they separate their own parts with '|' and ':'.
  if (process.platform === "win32") return powershell(`(Get-Process -Id ${pid}).StartTime.Ticks`);
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

let cachedBoot: string | null | undefined;

/**
 * Identity of the running boot, so that identities recorded before a reboot can be told apart from live ones:
 * /proc/sys/kernel/random/boot_id, or the boot timestamp from /proc/stat. Undefined off Linux, where records and
 * marks simply carry none. Neither form contains ':' or '|', which both mark formats rely on.
 */
export function bootId(): string | undefined {
  if (cachedBoot === undefined) cachedBoot = readBootId() ?? null;
  return cachedBoot ?? undefined;
}

function readBootId(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (id) return id;
  } catch {}
  try {
    return readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1];
  } catch {
    return undefined;
  }
}

/** False only when `boot` names a boot other than the running one; an unknown boot on either side cannot say. */
export function sameBoot(boot: string | undefined): boolean {
  const now = bootId();
  return boot === undefined || now === undefined || boot === now;
}

function processCmdline(pid: number): string | undefined {
  try {
    if (process.platform === "linux") return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    // The Get-Process of the PowerShell every Windows ships (5.1) carries no command line; the CIM class does. An
    // argument holding a space comes back quoted around the whole of it, so "--user-data-dir=<path>" is still in
    // the string to be found.
    if (process.platform === "win32") return powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`);
    // -ww, because BSD ps cuts the command at the terminal width and --user-data-dir sits behind the executable's
    // path, which for a browser is a path inside an .app bundle: two -w mean no limit, so the profile is there to
    // be read. A truncated line would read as a browser on some other profile, which is the answer that relaunches.
    return execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

/** pid is alive and still the process that had start time `start` (any live process when start is unknown). */
export function sameProcess(pid: number, start: string | undefined): boolean {
  return pidAlive(pid) && (start === undefined || processStart(pid) === start);
}

let cachedNs: string | null | undefined;

/**
 * Identity of the pid namespace this process's pids are numbered in: the inode of /proc/self/ns/pid, which the
 * kernel gives each namespace on this boot. The number alone is taken, so that a stamp's parts still contain no
 * ':' (the link itself reads "pid:[4026531836]"). Undefined off Linux and wherever /proc cannot be read.
 */
export function pidNamespace(): string | undefined {
  if (cachedNs === undefined) cachedNs = readPidNamespace() ?? null;
  return cachedNs ?? undefined;
}

function readPidNamespace(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    return readlinkSync("/proc/self/ns/pid").match(/\[(\d+)\]/)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * How often a process touches the lease files it holds, and how many missed beats make a holder no pid here can name
 * dead. The period travels in the stamp rather than being assumed, so a build that changes it does not strand the
 * leases of one that has not. Twelve of them, a whole minute, because the touching is a timer and the only thing
 * that keeps it from firing is this process's own synchronous work: an export holds its lease across a 600 s CDP
 * wait the event loop is free during, and the decode after it is the long block. A minute of silence is a holder
 * that is gone, not one that is busy.
 */
export const LEASE_BEAT_MS = 5_000;
const LEASE_BEAT_TOLERANCE = 12;

/**
 * Identity of a process for a file that outlives it: "<boot>|<start>|<ns>|<beat>", or "<boot>|<start>", or the start
 * time alone where no boot id is readable. The boot belongs in it because processStart counts ticks since boot: on
 * Linux the whole pair is reproduced by unrelated processes after a reboot, and the stamp is what keeps a lease or a
 * record honest. A Windows start time counts from an absolute epoch instead, so there a bare one already means only
 * one boot. The namespace belongs in it because a pid means nothing outside the one it was issued in (see
 * sameStampedProcess), and two containers sharing a bind-mounted cache have their own. The beat is what is left to
 * judge such a holder by once the pid is worthless (see declaredBeat), and it is only written where there is a
 * namespace to make the pid worthless in.
 */
export function processStamp(pid: number): string {
  const boot = bootId();
  const start = processStart(pid) ?? "";
  const ns = pidNamespace();
  // The boot's place is held even when it is unknown, so that a reader can tell the third field from the second.
  if (ns) return `${boot ?? ""}|${start}|${ns}|${LEASE_BEAT_MS}`;
  return boot ? `${boot}|${start}` : start;
}

/**
 * The process that wrote `stamp` (see processStamp) is still the one holding pid, as sharply as processStart can
 * tell: on macOS a pid reissued within the same second passes, and anywhere the start time cannot be read at all a
 * live pid alone passes. What that costs is a lease read as live or a tab left unadopted, never a signal - killing
 * goes through ownsProcess, which does not rest on the start time alone.
 *
 * A stamp from another pid namespace passes too, because there is nothing here to judge it by: its pid names one of
 * our processes or none at all, and its start time counts ticks a container's /proc reports from its own pid 1. A
 * container's pid 1 stamped 75899724 ticks while the host's pid 1 read 12, under one boot id, so the host read a
 * live holder as a pid reissued to someone else - and liveLeases then deleted its lease while its export ran. Such a
 * holder is judged by its heartbeat instead, which is what liveLeases asks after this returns.
 */
export function sameStampedProcess(pid: number, stamp: string): boolean {
  const [first, second, ns] = stamp.split("|");
  // Stamps without a boot predate it, or come from a platform with none; they are read as bare start times, and
  // one written before the namespace was in the stamp is read as this build read every stamp before it.
  const boot = second === undefined ? undefined : first || undefined;
  if (!sameBoot(boot)) return false;
  if (ns !== undefined && ns !== pidNamespace()) return true;
  return sameProcess(pid, (second ?? first) || undefined);
}

/** Write via rename so a concurrent reader never sees a half-written file (and mistakes it for a stale one). */
function writeAtomic(path: string, data: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** Remove path only if it still holds `seen`: another process may have just replaced it with a fresh record. */
function removeIfUnchanged(path: string, seen: string) {
  try {
    if (readFileSync(path, "utf8") === seen) rmSync(path, { force: true });
  } catch {}
}

/**
 * The heartbeat period, in ms, that a stamp naming another pid namespace declares (see processStamp). That is the
 * one holder sameStampedProcess cannot judge, and so the one whose lease file's own mtime is all the evidence there
 * is. Undefined for a stamp this process can judge by pid, and for one written before the period was part of it
 * (0.3.0), which nothing here can tell apart from a holder that simply never touches its lease: those stay live, as
 * they do under the build that wrote them.
 */
function declaredBeat(stamp: string): number | undefined {
  const [, start, ns, beat] = stamp.split("|");
  if (start === undefined || ns === undefined || ns === pidNamespace()) return undefined;
  const ms = Number(beat);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** What a lease judged by its heartbeat looked like when this process last read it (see stillBeating). */
const beats = new Map<string, { mtime: number; since: number }>();

/**
 * The lease at `path` has been touched within `window` ms of running time as measured here. Every comparison is
 * between two readings of one clock - an mtime against an mtime, and this process's own elapsed time against itself
 * - because a cache reached across a pid namespace is reached across machines too, and an mtime held against
 * Date.now() reads a holder whose filesystem clock runs a minute behind as long dead. A lease this process has not
 * seen before is live: the first reading is only what the next is measured from, and that way round costs a
 * duplicate export, where the other way round deletes a live holder's lease and reports its pre-refresh export as
 * current.
 *
 * The span is monotonic running time, not wall time, because the two things wall time would count are exactly the
 * two that are not missed beats: a clock stepped by chrony or date -s, and a suspended machine, which stops the
 * holder's timer and this process for the same hour and leaves neither any the wiser.
 */
function stillBeating(path: string, window: number): boolean {
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return false;
  }
  const now = performance.now();
  const seen = beats.get(path);
  if (!seen || seen.mtime !== mtime) {
    beats.set(path, { mtime, since: now });
    return true;
  }
  return now - seen.since < window;
}

/**
 * Presence files named "<pid>[-...]" holding their owner's processStamp(), under dir. Returns the live ones and
 * removes those whose process exited, whose pid now belongs to another process, or - where no pid here can say -
 * whose heartbeat has stopped. Empty files predate the stamp.
 */
export function liveLeases(dir: string): string[] {
  const live: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {}
  const byBeat = new Set<string>();
  for (const f of names) {
    const path = join(dir, f);
    let stamp: string;
    try {
      stamp = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    // A holder this process can name by pid is judged by that; one in another pid namespace only by its heartbeat.
    const beat = declaredBeat(stamp);
    if (!sameStampedProcess(Number(f.split("-")[0]), stamp) || (beat !== undefined && !stillBeating(path, beat * LEASE_BEAT_TOLERANCE))) {
      removeIfUnchanged(path, stamp);
      continue;
    }
    if (beat !== undefined) byBeat.add(path);
    live.push(f);
  }
  // Forget the readings of leases that are no longer here: a container on a shared cache takes a lease per export,
  // and a server that runs for weeks would otherwise keep a reading of every one of them.
  for (const path of beats.keys()) if (!byBeat.has(path) && dirname(path) === dir) beats.delete(path);
  return live;
}

/** Leases this process holds, the ones beatLeases keeps warm. */
const held = new Set<string>();
let beatTimer: NodeJS.Timeout | undefined;

/**
 * Touch every lease this process holds. This is the whole of what tells a reader in another pid namespace that the
 * holder is still there: it has no pid of ours it can judge, and an mtime moving needs no identity at all.
 */
function beatLeases() {
  const now = new Date();
  for (const path of held) {
    try {
      utimesSync(path, now, now);
    } catch {
      // Gone: swept by a reader that gave up on us, or under a directory someone removed. Nothing left to announce.
      held.delete(path);
    }
  }
}

/** Create a presence file for this process under dir (see liveLeases); returns its path. */
export function takeLease(dir: string, name = String(process.pid)): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, processStamp(process.pid));
  held.add(path);
  // Only a stamp carrying a namespace declares a beat, and only such a stamp is ever judged by one; off Linux every
  // reader judges by pid. unref, because a client lease is held for as long as the process runs and a timer holding
  // the loop open would stop the CLI exiting.
  if (pidNamespace() && !beatTimer) {
    beatTimer = setInterval(beatLeases, LEASE_BEAT_MS);
    beatTimer.unref();
  }
  return path;
}

/** Give up a lease this process took: it stops being announced, and stops being touched. */
export function dropLease(path: string) {
  held.delete(path);
  if (!held.size && beatTimer) {
    clearInterval(beatTimer);
    beatTimer = undefined;
  }
  rmSync(path, { force: true });
}

const BROWSER_NAMES = ["brave", "brave-browser", "chromium", "chromium-browser", "google-chrome-stable", "google-chrome"];
// Windows spells them with an extension: there is no google-chrome-stable, and Brave is brave.exe.
const WINDOWS_NAMES = ["brave.exe", "chrome.exe", "chromium.exe", "msedge.exe"];
const onWindows = () => process.platform === "win32";
// path.delimiter, because Windows separates PATH with ';' and a split on ':' cuts every entry at its drive letter.
const pathEntries = () => (process.env.PATH ?? "").split(delimiter).filter(Boolean);
/**
 * Where Windows keeps browsers when they are not on PATH, which is the normal case: an installer writes to Program
 * Files and registers the app rather than extending PATH.
 */
function windowsDirs(): string[] {
  const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter((d): d is string => !!d);
  const apps = ["BraveSoftware\\Brave-Browser\\Application", "Google\\Chrome\\Application", "Chromium\\Application", "Microsoft\\Edge\\Application"];
  return roots.flatMap((root) => apps.map((app) => join(root, app)));
}

/**
 * Whether a path is inside a confined package. Such a build cannot reach a profile directory outside its own
 * sandbox, so it starts and exits without ever opening the DevTools port we drive it through. On Ubuntu
 * /usr/bin/chromium is usually a link to one, which is why the list below is an order of preference, not a choice.
 */
export const confinedPath = (path: string) => /^\/(snap|var\/lib\/snapd|var\/lib\/flatpak)\//.test(path) || path.includes("/flatpak/");

/** Where a link chain ends, which is what confinedPath has to judge: /usr/bin/chromium is itself an ordinary path. */
function linkTarget(path: string): string {
  let target = path;
  for (let i = 0; i < 10; i++) {
    try {
      const next = readlinkSync(target);
      // isAbsolute, not a leading '/': a Windows link target is "C:\...", which join would hang off the link's own
      // directory as "C:\...\C:\...", the same doubled drive letter a file URL's pathname produces.
      target = isAbsolute(next) ? next : join(dirname(target), next);
    } catch {
      return target;
    }
  }
  return target;
}
const sandboxed = (path: string) => confinedPath(linkTarget(path));

/** Ordinary builds first, confined ones after: kept, since one may be all there is, but never preferred. */
export const demoteConfined = (paths: string[]) => [...paths.filter((p) => !sandboxed(p)), ...paths.filter(sandboxed)];

/**
 * Every directory a browser is looked for in. One function rather than two reads inside the search, so that a test
 * can hand in a directory of its own: emptying PATH is no longer enough on Windows, where the install directories
 * above put the machine's real Chrome and Edge in front of anything a test lays out.
 */
export const browserSearchDirs = () => [...pathEntries(), ...(onWindows() ? windowsDirs() : [])];

/**
 * Installed browsers, best first. Existence is not usability -- a file can be there, be a directory, lack the execute
 * bit, or be a confined package that cannot use our profile -- and only launching settles it, so this returns every
 * candidate and launch() works down the list. Playwright's build ("Chrome for Testing") is last whatever else is
 * found: Google sign-in refuses it as insecure, which breaks "Continue with Google" on figma.com.
 */
export function browserCandidates(dirs = browserSearchDirs()): string[] {
  const found: string[] = [];
  // One browser is on PATH under several names once directories are merged: on Debian /bin links to /usr/bin, so
  // /bin/chromium and /usr/bin/chromium are one file and trying both is one failed launch paid for twice. The first
  // spelling is what gets reported, since that is the one a user would recognise.
  const seen = new Set<string>();
  const names = onWindows() ? WINDOWS_NAMES : BROWSER_NAMES;
  for (const name of names) {
    for (const dir of dirs) {
      const path = join(dir, name);
      let id: string;
      try {
        if (!statSync(path).isFile()) continue;
        accessSync(path, constants.X_OK);
        id = realpathSync(path);
      } catch {
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      found.push(path);
    }
  }
  const ordered = demoteConfined(found);
  try {
    const { chromium } = createRequire(import.meta.url)("playwright-core");
    const path = chromium.executablePath();
    if (existsSync(path) && !ordered.includes(path)) ordered.push(path);
  } catch {}
  return ordered;
}

/** The browser a call will use when none is named. Kept for callers that report one rather than launch it. */
export function defaultExecutable(): string {
  const first = browserCandidates()[0];
  if (!first) throw new Error("No Chromium-family browser found. Install Brave/Chromium/Chrome or set FIGMA_BROWSER_PATH.");
  return first;
}

/**
 * Spawn a detached browser. A spawn failure (missing or non-executable FIGMA_BROWSER_PATH) arrives as an 'error'
 * event, which would crash the whole server if unhandled; check() rethrows it as a clear launch error instead.
 */
function spawnBrowser(exe: string, args: string[]) {
  const cannotStart = (e: Error) => new Error(`Cannot start browser ${exe}: ${e.message}. Set FIGMA_BROWSER_PATH to a Chromium-family browser.`);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(exe, args, { detached: true, stdio: "ignore" });
  } catch (e) {
    // The other shape a refusal comes in, measured on a Windows runner: Node will not run a .bat or .cmd without a
    // shell and throws EINVAL from spawn itself rather than emitting it, so FIGMA_BROWSER_PATH on a launcher script
    // arrived as a bare "spawn EINVAL" with nothing said about what to do.
    throw cannotStart(e as Error);
  }
  let failed: Error | undefined;
  child.on("error", (e) => (failed = e));
  child.unref();
  return {
    process: child,
    check() {
      if (failed) throw cannotStart(failed);
    },
  };
}

export class BrowserManager {
  private browserSession?: CdpSession;
  private endpoint?: string;
  readonly stateDir: string;
  readonly opts: BrowserOptions;

  constructor(opts: BrowserOptions) {
    this.opts = opts;
    const id = createHash("sha1").update(opts.cdpUrl ?? opts.userDataDir).digest("hex").slice(0, 12);
    this.stateDir = join(opts.stateDir, id);
    takeLease(join(this.stateDir, "clients"));
  }

  get managed() {
    return !this.opts.cdpUrl;
  }

  get httpUrl() {
    return this.endpoint ?? this.opts.cdpUrl ?? "(not running)";
  }

  private get recordPath() {
    return join(this.stateDir, "browser.json");
  }

  /**
   * The launched browser, verified to still be the recorded process; a stale record is removed. The raw text comes
   * with it: every delete of the record must be conditional on it, so a record another process wrote meanwhile
   * survives (its browser would otherwise be unmanaged forever, holding the profile and the session).
   */
  private readRecord(): { raw: string; rec: LaunchRecord } | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.recordPath, "utf8");
    } catch {
      return undefined;
    }
    try {
      const rec = JSON.parse(raw) as LaunchRecord;
      // The record outlives reboots (it sits in the state dir) while `start` counts ticks since boot: after a
      // reboot the recorded pair can name an unrelated process, and that pair alone authorises process.kill.
      if (sameBoot(rec.boot) && this.ownsProcess(rec.pid, rec.start, rec.ns)) return { raw, rec };
      // A record written in another pid namespace is not evidence of anything here, and deleting it is itself an
      // act: the browser it names goes unmanaged forever, while the process that can manage it looks for a record
      // that is gone. A live container's record was read as a dead process's and removed - it names pid 1, stamped
      // 75899724 ticks in, and the host's pid 1 is an init that started at tick 12 - so this leaves it where it is.
      if (rec.ns !== undefined && rec.ns !== pidNamespace()) return undefined;
    } catch {}
    // The browser exited, or its pid now belongs to an unrelated process that must never be signalled.
    removeIfUnchanged(this.recordPath, raw);
    return undefined;
  }

  private record(): LaunchRecord | undefined {
    return this.readRecord()?.rec;
  }

  private writeRecord(r: Omit<LaunchRecord, "start" | "boot" | "ns">) {
    writeAtomic(this.recordPath, JSON.stringify({ ...r, start: processStart(r.pid), boot: bootId(), ns: pidNamespace() } satisfies LaunchRecord));
  }

  /**
   * pid is a browser on our profile: its start time is the recorded one or, lacking one (older records, the
   * profile lock), its command line names our profile. Anything else is a reused pid.
   *
   * A pid numbered in another pid namespace is one of those: it names one of our processes or none at all, and the
   * start time recorded beside it counts from the same boot, so a collision inside one 10 ms tick is all that
   * stands between that record and a signal sent to a process we have never heard of. Nothing here can own it.
   */
  private ownsProcess(pid: number, start?: string, ns?: string): boolean {
    if (ns !== undefined && ns !== pidNamespace()) return false;
    if (!pidAlive(pid)) return false;
    const onProfile = () => processCmdline(pid)?.includes(`--user-data-dir=${this.opts.userDataDir}`);
    if (start === undefined) return !!onProfile();
    if (processStart(pid) !== start) return false;
    // On Linux the start time is measured in clock ticks and on Windows from the process's own creation, and on
    // both that settles it. On macOS it is ps's lstart, at one-second resolution: a pid reissued within that second
    // carries the recorded string, and this is the only check standing between a recycled pid and process.kill. The
    // command line is the second half of it there, and refutes only when it could be read - a browser whose
    // arguments this user cannot see must not be left running, unmanaged and holding the profile, while a second
    // one is launched onto it.
    return process.platform === "linux" || process.platform === "win32" || onProfile() !== false;
  }

  private async reachable(url: string): Promise<{ webSocketDebuggerUrl: string; "User-Agent": string } | undefined> {
    try {
      const r = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1500) });
      return (await r.json()) as any;
    } catch {
      return undefined;
    }
  }

  /** Endpoint of a browser already running on our profile, if any. */
  private async discover(): Promise<string | undefined> {
    const file = join(this.opts.userDataDir, "DevToolsActivePort");
    if (!existsSync(file)) return undefined;
    const port = readFileSync(file, "utf8").split("\n")[0]?.trim();
    const url = `http://127.0.0.1:${port}`;
    return port && (await this.reachable(url)) ? url : undefined;
  }

  /** Pid of a browser holding the profile lock (running with or without a DevTools port). */
  private profileLockPid(): number | undefined {
    try {
      // "<hostname>-<pid>"; a lock left by a crash may name a pid since reused by something else.
      const target = readlinkSync(join(this.opts.userDataDir, "SingletonLock"));
      const dash = target.lastIndexOf("-");
      const pid = Number(target.slice(dash + 1));
      return target.slice(0, dash) === hostname() && this.ownsProcess(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Visible login window with no DevTools port: sites like Google sign-in refuse remotely controlled browsers.
   * Login is detected later, after the user closes the window, by a headless launch on the same profile.
   */
  async launchLoginWindow(url: string): Promise<number> {
    const exe = this.opts.executablePath ?? defaultExecutable();
    mkdirSync(this.opts.userDataDir, { recursive: true });
    rmSync(join(this.opts.userDataDir, "DevToolsActivePort"), { force: true });
    const launchedAt = Date.now();
    const child = spawnBrowser(exe, [`--user-data-dir=${this.opts.userDataDir}`, "--no-first-run", "--no-default-browser-check", "--new-window", url]);
    await sleep(1500);
    child.check();
    // Launcher scripts may exit after handing off; the profile lock names the real browser pid.
    const pid = this.profileLockPid() ?? child.process.pid!;
    this.writeRecord({ pid, headless: false, purpose: "login", exe, launchedAt });
    this.browserSession = undefined;
    this.endpoint = undefined;
    return pid;
  }

  /**
   * While a login window is open, only a cookie written after it opened counts: the profile may still hold an auth
   * cookie Figma has revoked (logged out everywhere, password changed) that has not expired yet.
   */
  loginCookiePresent(): boolean {
    const rec = this.record();
    return profileHasLoginCookie(this.opts.userDataDir, rec?.purpose === "login" ? rec.launchedAt : undefined);
  }

  /**
   * Close the login window. SIGTERM asks Chromium to shut down rather than dropping it, but nothing here rests on
   * that: both callers signal only once loginCookiePresent() has seen the auth cookie in the profile's cookie DB,
   * so the login is already on disk. Windows has no graceful signal to send -- process.kill(pid, "SIGTERM") is
   * TerminateProcess there, and the window is gone the moment it arrives.
   */
  async closeLoginWindow(): Promise<void> {
    const found = this.readRecord();
    if (found?.rec.purpose !== "login") return;
    const { raw, rec } = found;
    try {
      process.kill(rec.pid, "SIGTERM");
    } catch {}
    // Liveness, not identity, for the same reason as in close(): the wait is over when the process is gone.
    for (let i = 0; i < 100 && (pidAlive(rec.pid) || this.profileLockPid()); i++) await sleep(100);
    removeIfUnchanged(this.recordPath, raw);
  }

  async executable() {
    return this.opts.executablePath ?? defaultExecutable();
  }

  /**
   * Launch, trying each installed browser until one opens a DevTools port. Only launching proves a browser usable,
   * and a browser that cannot start exits at once -- the wait below ends on the child exiting, not on its ceiling --
   * so working down the list costs a moment rather than a timeout each. A browser named outright by
   * FIGMA_BROWSER_PATH is never substituted: someone who says which browser to use gets told it failed.
   */
  async launch(headless: boolean, purpose: LaunchRecord["purpose"], url = "about:blank"): Promise<string> {
    if (this.opts.executablePath) return this.launchWith(this.opts.executablePath, headless, purpose, url);
    const candidates = browserCandidates();
    if (!candidates.length) throw new Error("No Chromium-family browser found. Install Brave/Chromium/Chrome or set FIGMA_BROWSER_PATH.");
    const failures: string[] = [];
    for (const exe of candidates) {
      try {
        return await this.launchWith(exe, headless, purpose, url);
      } catch (e) {
        const message = (e as Error).message;
        // A profile already held by another browser is about this profile, not this executable: trying a different
        // browser on the same directory would fail the same way, and the message already says what to do.
        if (message.includes("is in use by another browser")) throw e;
        failures.push(`${exe}: ${message}`);
      }
    }
    throw new Error(`No installed browser could be started.\n${failures.map((f) => `  ${f}`).join("\n")}`);
  }

  private async launchWith(exe: string, headless: boolean, purpose: LaunchRecord["purpose"], url: string): Promise<string> {
    mkdirSync(this.opts.userDataDir, { recursive: true });
    rmSync(join(this.opts.userDataDir, "DevToolsActivePort"), { force: true });
    const args = [
      "--remote-debugging-port=0",
      `--user-data-dir=${this.opts.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1600,1000",
      ...(headless ? ["--headless=new", "--mute-audio"] : ["--new-window"]),
      url,
    ];
    const child = spawnBrowser(exe, args);
    for (let i = 0; i < 100; i++) {
      await sleep(200);
      child.check();
      const ep = await this.discover();
      if (ep) {
        this.writeRecord({ pid: this.profileLockPid() ?? child.process.pid!, headless, purpose, exe });
        this.endpoint = ep;
        this.browserSession = undefined;
        return ep;
      }
      if (child.process.exitCode !== null && !this.profileLockPid()) break;
    }
    const holder = this.profileLockPid();
    throw new Error(
      holder
        ? `Profile ${this.opts.userDataDir} is in use by another browser (pid ${holder}) without a DevTools port. ` +
            `Close it, or start it with --remote-debugging-port and set FIGMA_CDP_URL.`
        // Seen twice while setting up CI, from two different browsers: the process starts and exits without ever
        // writing DevToolsActivePort. Both causes are about the sandbox rather than the binary -- a snap or flatpak
        // package cannot reach a profile outside its own sandbox, and a kernel that restricts unprivileged user
        // namespaces (Ubuntu 24.04 onward) stops Chromium's own sandbox starting at all.
        : `Browser ${exe} started but never opened a DevTools port. Its sandbox is the usual reason: a snap or ` +
          `flatpak build cannot use a profile outside it, and a kernel restricting unprivileged user namespaces ` +
          `stops Chromium's sandbox starting. Try a native build via FIGMA_BROWSER_PATH, or a browser you start ` +
          `yourself with --remote-debugging-port and FIGMA_CDP_URL.`,
    );
  }

  /** Connect to the browser, launching a headless one on the profile when nothing is running. */
  async session(): Promise<CdpSession> {
    if (this.browserSession?.open) return this.browserSession;
    let ep = this.opts.cdpUrl ?? (await this.discover());
    if (!ep && this.opts.cdpUrl) {
      throw new Error(`No browser DevTools endpoint at ${this.opts.cdpUrl}.`);
    }
    if (!ep && this.record()?.purpose === "login") {
      if (!this.loginCookiePresent()) throw new Error("A Figma login window is open. Log in there, then retry.");
      await this.closeLoginWindow();
    }
    if (!ep) ep = await this.launch(this.opts.headless, "work");
    const v = await this.reachable(ep);
    if (!v) throw new Error(`Browser DevTools endpoint ${ep} is not reachable.`);
    this.endpoint = ep;
    this.browserSession = await CdpSession.connect(v.webSocketDebuggerUrl);
    return this.browserSession;
  }

  async isHeadless(): Promise<boolean> {
    await this.session();
    const v = await this.reachable(this.endpoint!);
    return !!v?.["User-Agent"].includes("HeadlessChrome");
  }

  /** User agent to present to figma.com: CloudFront rejects "HeadlessChrome". */
  async userAgent(): Promise<string> {
    await this.session();
    const v = await this.reachable(this.endpoint!);
    return (v?.["User-Agent"] ?? "").replace("HeadlessChrome", "Chrome");
  }

  async targets(): Promise<TargetInfo[]> {
    await this.session();
    // A browser that still accepts the websocket but never answers /json/list (swapping, frozen) left this pending
    // for undici's 300 s headers timeout, on the hot path of editorTab and of newTab's 20-iteration loop.
    const r = await fetch(`${this.endpoint}/json/list`, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    return ((await r.json()) as TargetInfo[]).filter((t) => t.type === "page");
  }

  async attach(target: TargetInfo): Promise<CdpSession> {
    if (!target.webSocketDebuggerUrl) throw new Error(`target ${target.id} has no debugger URL`);
    const s = await CdpSession.connect(target.webSocketDebuggerUrl);
    const ua = await this.userAgent();
    await s.send("Emulation.setUserAgentOverride", { userAgent: ua }).catch(() => {});
    // Headless pages have no OS focus; Figma ignores shortcuts without it.
    await s.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    return s;
  }

  async newTab(url: string, foreground = false): Promise<TargetInfo> {
    const b = await this.session();
    const { targetId } = await b.send("Target.createTarget", { url, newWindow: true, background: !foreground });
    for (let i = 0; i < 20; i++) {
      const t = (await this.targets()).find((x) => x.id === targetId);
      if (t?.webSocketDebuggerUrl) return t;
      await sleep(250);
    }
    throw new Error("new tab did not appear");
  }

  /** Connect to a browser already running on our profile; never launches one. */
  private async connectExisting(): Promise<CdpSession | undefined> {
    const ep = await this.discover();
    const v = ep ? await this.reachable(ep) : undefined;
    return v ? CdpSession.connect(v.webSocketDebuggerUrl).catch(() => undefined) : undefined;
  }

  /**
   * Close the browser if this manager's profile launched it (never an attached FIGMA_CDP_URL browser). The recorded
   * pid is signalled only while it is verifiably that browser, and no browser is ever started just to close it.
   */
  async close(): Promise<void> {
    const found = this.readRecord();
    if (!this.managed || !found) return;
    const { raw, rec } = found;
    if (rec.purpose === "work") {
      const s = this.browserSession?.open ? this.browserSession : await this.connectExisting();
      await s?.send("Browser.close", {}, 5000).catch(() => {});
    }
    // Waiting only has to notice the process is gone, and an identity check spawns one off Linux (ps, or 300 ms of
    // PowerShell on Windows) - fifty of them while a browser takes its time to exit. What authorises the signal is
    // still the full check, once, below; a pid reused mid-wait is held onto a little longer and then not signalled.
    for (let i = 0; i < 50 && pidAlive(rec.pid); i++) await sleep(100);
    if (this.ownsProcess(rec.pid, rec.start, rec.ns)) {
      try {
        process.kill(rec.pid);
      } catch {}
    }
    // Waiting for the old browser to die takes up to 5 s, in which another process can launch one and record it.
    removeIfUnchanged(this.recordPath, raw);
    this.browserSession = undefined;
    this.endpoint = undefined;
  }

  launchRecord() {
    return this.record();
  }

  private get busyDir() {
    return join(this.stateDir, "busy");
  }

  /** Run fn while advertising that this process is working in the browser, so no other process closes it meanwhile. */
  async busy<T>(fn: () => Promise<T>): Promise<T> {
    const lease = takeLease(this.busyDir, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      return await fn();
    } finally {
      dropLease(lease);
    }
  }

  /** Pids of other live processes currently working in this browser. */
  busyElsewhere(): number[] {
    const pids = liveLeases(this.busyDir).map((f) => Number(f.split("-")[0]));
    return [...new Set(pids)].filter((pid) => pid !== process.pid);
  }

  /** Unregister this server; close a launched browser when no other live server uses it. */
  async release(): Promise<void> {
    const dir = join(this.stateDir, "clients");
    dropLease(join(dir, String(process.pid)));
    const others = liveLeases(dir);
    const rec = this.record();
    // Keep a login window open for the user; only tear down work browsers.
    if (!others.length && rec?.purpose === "work") await this.close();
  }
}

/** Chromium cookie times are microseconds since 1601-01-01 UTC. */
const chromeTimeToUnixMs = (t: unknown) => Number(t ?? 0) / 1000 - 11_644_473_600_000;

/**
 * Cheap login hint readable while the login window runs (no DevTools there) or with no browser at all: an unexpired
 * Figma auth cookie in the profile's cookie DB, written at or after `since` (unix ms) when given. Values are
 * encrypted, so this is only a hint; callers verify with the real session.
 */
export function profileHasLoginCookie(userDataDir: string, since?: number): boolean {
  for (const rel of ["Default/Cookies", "Default/Network/Cookies"]) {
    const file = join(userDataDir, rel);
    if (!existsSync(file)) continue;
    try {
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
      // Read-only, but not immutable=1: that tells SQLite to ignore -wal and any hot journal, so a committed but
      // uncheckpointed login cookie is invisible (reproduced) and a crashed browser's journal is never rolled back.
      const db = new DatabaseSync(`file:${file}?mode=ro`, { readOnly: true });
      // select *: last_update_utc only exists in newer Chromium versions.
      const stmt = db.prepare("select * from cookies where host_key like '%figma.com' and name = '__Host-figma.authn'");
      stmt.setReadBigInts(true); // these timestamps exceed Number.MAX_SAFE_INTEGER
      const rows = stmt.all() as Record<string, unknown>[];
      db.close();
      const now = Date.now();
      const valid = rows.some((r) => {
        if (Number(r.has_expires ?? 1) && Number(r.expires_utc ?? 0) && chromeTimeToUnixMs(r.expires_utc) < now) return false;
        const written = Math.max(chromeTimeToUnixMs(r.creation_utc), chromeTimeToUnixMs(r.last_update_utc));
        return since === undefined || written >= since;
      });
      if (valid) return true;
    } catch {}
  }
  return false;
}

export const defaultStateDir = () => appRoot("state");
