// Drives the logged-in figma.com web app over CDP: internal API calls, "Save local copy", "Copy as PNG".
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { bootId, BrowserManager, liveLeases, processStart, sameBoot, sameProcess, takeLease } from "./browser.ts";
import { CdpSession, MOD, sleep, type TargetInfo } from "./cdp.ts";
import type { Raw } from "./fig-file.ts";

const ORIGIN = "https://www.figma.com";
// Each server process owns one editor tab, marked through window.name with its pid.
const TAB_PREFIX = "figma-reader";
// The mark carries our start time as well as our pid, so a tab left by an exited process is not taken for a live
// one's after its pid is reused, and the boot that start time was measured in: a profile that restores its session
// brings window.name back across a reboot, where the pair names an unrelated process.
const TAB_START = processStart(process.pid);
const TAB_BOOT = bootId();
export const TAB_MARK = `${TAB_PREFIX}${TAB_BOOT ? `@${TAB_BOOT}` : ""}:${process.pid}${TAB_START ? `:${TAB_START}` : ""}`;
// Copy as PNG parks the image on a window global. It is namespaced per process so that two server
// processes sharing one tab can never consume each other's capture.
const PNG_KEY = `__figmaReaderPng_${process.pid}`;
const ORIG_WRITE_KEY = `__figmaReaderOrigWrite_${process.pid}`;
// Node ids Figma currently has selected, or null when the internal store cannot be read.
const SELECTION_EXPR =
  `(()=>{try{const s=window._fullscreen_?._store?.getState?.()?.mirror?.sceneGraphSelection;` +
  `return s?Object.keys(s):null}catch(e){return null}})()`;
/**
 * Whether the focused element is the Quick actions search box rather than merely some empty <input>. The check
 * used to be "an empty INPUT has focus", which a layer rename field, a page-name field, a comment composer and a
 * plugin input all satisfy: 45 characters of the query were measured going into an unrelated rename field, three
 * times over, from a tool advertised as read-only. Figma's markup is the only evidence available, so three
 * independent signals are accepted - the box's placeholder or aria-label, its CSS-module class name, or a
 * quick-action container around it - and anything else is left untouched and named by quickAction's diagnostic.
 */
const QUICK_ACTION_BOX =
  `(()=>{try{const a=document.activeElement;if(!a||a.tagName!=="INPUT"||a.value)return false;` +
  `const t=((a.getAttribute("placeholder")||"")+" "+(a.getAttribute("aria-label")||"")+" "+(a.className||"")).toLowerCase();` +
  `if(/quick.?action|find action|search action/.test(t))return true;` +
  `return !!a.closest?.('[data-testid*="quick-action"],[data-testid*="quick_action"],[data-testid*="quickAction"]')}catch(e){return false}})()`;
/** How long a node-id navigation may take to produce a selection before we give up. */
const SELECT_TIMEOUT_MS = 20_000;
/** How long one Copy as PNG attempt waits for the image. */
const CAPTURE_TIMEOUT_MS = 30_000;
const CAPTURE_ATTEMPTS = 2;
/** How long reading one captured image out of the page may take (decode, downscale, base64). */
const READ_PNG_TIMEOUT_MS = 30_000;

const LOGIN_MESSAGE =
  "Not logged into figma.com. A browser window was opened on the Figma login page: log in there and retry " +
  "(the window closes by itself), or call figma_login with wait_seconds to wait for the login.";

/** Figma answered an internal API call with an error status. */
export class FigmaApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Owner of a marked tab: undefined when not ours at all; pid 0 for legacy marks without one; start/boot when recorded. */
export function markOwner(name: string): { pid: number; start?: string; boot?: string } | undefined {
  if (name === TAB_PREFIX) return { pid: 0 };
  // The boot hangs off the prefix with '@' because a start time may itself contain ':' (ps lstart, off Linux).
  const m = name.match(/^figma-reader(?:@([^:]+))?:(\d+)(?::(.+))?$/);
  return m ? { pid: Number(m[2]), start: m[3], boot: m[1] } : undefined;
}

/** A tab marked by a process that is no longer running (pid gone, pid reused, or another boot entirely) is free. */
export const abandoned = (owner: { pid: number; start?: string; boot?: string }) =>
  owner.pid === 0 || !sameBoot(owner.boot) || !sameProcess(owner.pid, owner.start);

export interface RecentFile {
  key: string;
  name: string;
  editorType: string;
  teamId: string | null;
  updatedAt: string;
  touchedAt: string;
  url: string;
}

export interface PngCapture {
  base64: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

/** "My App [AbCdEf1234567890XyZ].fig" -> "AbCdEf1234567890XyZ" */
export function keyFromFileName(path: string): string | undefined {
  return path.match(/\[([A-Za-z0-9]{10,})\]\.fig$/i)?.[1];
}

// A branch lives at /design/<mainKey>/branch/<branchKey>/<name>; its own key is the branch key. Reading the first
// key instead served the main file for a branch URL, silently showing different content. The URL shape is from
// Figma's docs: branching needs an Organization plan, which no account here has, so it is unverified end to end.
// deck/make/site/buzz are Figma's newer products: the export filter below already accepts their file extensions,
// and leaving them out also kept fileKeyFromPath undefined when Figma redirects /design/<key> to one of them, so
// the open file never compared equal and every openFile navigated again.
const FILE_PATH = /\/(?:design|file|proto|board|slides|deck|make|site|buzz)\/([A-Za-z0-9]{10,})(?:\/branch\/([A-Za-z0-9]{10,}))?/;

/** Key of the file a figma.com path shows (the branch's key for a branch path). */
export function fileKeyFromPath(path: string): string | undefined {
  const m = path.match(FILE_PATH);
  return m ? (m[2] ?? m[1]) : undefined;
}

/** Path part of an href, or undefined when it does not parse. */
function pathOf(href: string): string | undefined {
  try {
    return new URL(href).pathname;
  } catch {
    return undefined;
  }
}

/**
 * ref parsed as a figma.com URL, or undefined. Matching "figma.com" as a substring of the whole ref rejected
 * WWW.FIGMA.COM/... and Figma.com/... while accepting notfigma.com/... and any ref that merely mentions the host
 * in a query; only the parsed host says which site a URL names.
 */
function figmaUrl(ref: string): URL | undefined {
  try {
    // A URL pasted without its scheme ("figma.com/design/...") still names the file; URL() needs one to parse it.
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(ref) ? ref : `https://${ref}`);
    const host = u.hostname.toLowerCase();
    return host === "figma.com" || host.endsWith(".figma.com") ? u : undefined;
  } catch {
    return undefined;
  }
}

/** A ref resolved as a local file: keyed by the [key] in its name when it has one, else by its path. */
function localFile(local: string): { key: string; path: string; keyInName: boolean } {
  const path = resolve(local);
  return { key: keyFromFileName(path) ?? path, path, keyInName: !!keyFromFileName(path) };
}

export function parseFileRef(ref: string): { key: string; nodeId?: string; path?: string; keyInName?: boolean } {
  const url = figmaUrl(ref);
  const m = url?.pathname.match(FILE_PATH);
  if (url && m) {
    const node = url.searchParams.get("node-id");
    return { key: m[2] ?? m[1], nodeId: node ? node.replaceAll("-", ":") : undefined };
  }
  if (/^[A-Za-z0-9]{10,}$/.test(ref)) return { key: ref };
  // A filesystem path only now, and only for a ref shaped like one: trying existsSync(ref) first turned a bare
  // file key into a local path whenever the server's working directory happened to hold something of that name,
  // and FigDocument.fromFile then failed on it (a directory, say) with an opaque error.
  const local = ref.replace(/^~(?=\/)/, homedir());
  if (/\.fig$/i.test(local)) {
    if (!existsSync(local)) throw new Error(`local .fig not found: ${local}`);
    return localFile(local);
  }
  if (/[/.~]/.test(ref) && existsSync(local)) return localFile(local);
  throw new Error(`not a Figma file key or URL: ${ref}`);
}

export interface SelectionWait {
  /** Selected node ids, or null when Figma's internal store could not be read at all. */
  ids: string[] | null;
  /** False when the selection could not be inspected, so no claim about it may be made. */
  readable: boolean;
  /** Whether the selection is the one that was asked for; undefined when it was not inspectable. */
  matched?: boolean;
  waitedMs: number;
}

/** Failure of the selection step: says what was observed and refuses to assert what was not checked. */
export function selectionTimeoutMessage(fileKey: string, nodeId: string, sel: SelectionWait): string {
  const seen = sel.ids?.length
    ? `Figma selected ${sel.ids.slice(0, 5).join(", ")} instead`
    : "the selection stayed empty";
  return (
    `Figma did not select node ${nodeId} in ${fileKey}. Checked: the editor became ready after navigating ` +
    `to ?node-id=${nodeId.replace(":", "-")}, and ${seen} for ${(sel.waitedMs / 1000).toFixed(1)}s. ` +
    `Not checked: whether the node exists, is visible, or is a page - this reports only what Figma selected. ` +
    `A page id cannot be selected: load the file first so pages are recognized, or pass a frame id. ` +
    `Ids of layers inside an instance (I<instance>;<layer>) cannot be selected either.`
  );
}

/** Failure of the capture step, after a selection was confirmed (or confirmed unreadable). */
export function captureTimeoutMessage(d: {
  nodeId: string;
  selection: SelectionWait;
  attempts: number;
  waitedMs: number;
  selectAll: boolean;
}): string {
  const sel = !d.selection.readable
    ? "could not be inspected (Figma's internal store was unavailable)"
    : d.selection.ids?.length
      ? `${d.selection.ids.length} node(s): ${d.selection.ids.slice(0, 5).join(", ")}`
      : "empty";
  return (
    `Copy as PNG produced no image for node ${d.nodeId} after ${d.attempts} attempt(s) of ` +
    `${(d.waitedMs / 1000).toFixed(1)}s each. Checked: the editor was ready, the shortcut was delivered, and ` +
    `Figma's selection was ${sel}${d.selectAll ? " (select-all was used because the id is a page)" : ""}. ` +
    `Not checked: whether the file restricts copying/exporting, or whether the node renders as an empty image.`
  );
}

/** Route downloads into dir and report their progress; browser-wide, so every export on this browser shares it. */
const armDownloads = (dir: string) => ({ behavior: "allowAndName", downloadPath: dir, eventsEnabled: true });

/**
 * Hand the browser-wide download behaviour back once no export still needs it. The check and the send are two
 * round trips, and another export can take its lease in between: its download would then go to the browser's
 * default directory and be waited for, in ours, until the 600 s timeout. So the leases are read again afterwards
 * and the directory re-armed for whoever appeared. All exports on a browser share one directory (see the lease
 * protocol in saveLocalCopyUnlocked), which is what makes re-arming with ours right for them too.
 */
export async function releaseDownloadBehavior(
  browser: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  leases: string,
  dir: string,
): Promise<void> {
  if (liveLeases(leases).length) return;
  await browser.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => {});
  if (!liveLeases(leases).length) return;
  await browser.send("Browser.setDownloadBehavior", armDownloads(dir)).catch(() => {});
}

/**
 * Move a finished download onto its destination. The download directory belongs to the browser profile and the
 * destination to the snapshot cache, which FIGMA_READER_CACHE can put on another filesystem: rename then fails with
 * EXDEV. Copying goes through a temporary file beside the destination, so the swap onto it stays a rename and no
 * reader ever decodes a .fig that is still being written.
 *
 * The temporary name carries a random suffix as well as the pid, like the leases do: two containers sharing a
 * bind-mounted cache have their own pid namespaces, so the pid alone let one overwrite the other's copy midway.
 * A crash between the copy and the rename leaves the temporary behind; cleanStaleDownloads sweeps it.
 */
export function moveDownload(src: string, dest: string) {
  try {
    renameSync(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    copyFileSync(src, tmp);
    renameSync(tmp, dest);
    rmSync(src, { force: true });
  }
}

export class FigmaWeb {
  private tabId?: string;
  private tab?: CdpSession;
  private queue: Promise<unknown> = Promise.resolve();

  private browser: BrowserManager;
  /** Root of the download directory and its leases. Public so that whoever cleans it cannot name a different one. */
  readonly downloadDir: string;
  private timeScale: number;

  constructor(browser: BrowserManager, downloadDir: string, timeScale = 1) {
    this.browser = browser;
    this.downloadDir = downloadDir;
    this.timeScale = timeScale;
  }

  /**
   * ms milliseconds of waiting, scaled. Every wait and deadline below goes through this, and the scale is 1
   * everywhere but in tests: the loops are minutes long end to end, and a test that had to sit through them in
   * real time would not be written at all. The numbers at the call sites are the real ones.
   */
  private ms(ms: number) {
    return ms * this.timeScale;
  }

  private forgetTab() {
    this.tab?.close();
    this.tab = undefined;
    this.tabId = undefined;
  }

  /** Logged-in user, or throws after opening a visible login window. */
  async ensureLoggedIn(): Promise<{ id: string; handle: string; email: string }> {
    const user = await this.whoami();
    if (user) return user;
    await this.openLogin();
    throw new Error(LOGIN_MESSAGE);
  }

  /** Open a visible figma.com login window: a plain browser for managed profiles, a tab for attached ones. */
  async openLogin(): Promise<void> {
    this.forgetTab();
    if (!this.browser.managed) {
      await this.browser.newTab(`${ORIGIN}/login`, true);
      return;
    }
    if (this.browser.launchRecord()?.purpose === "login") return;
    // The profile can only be open in one browser process, so the login window replaces the work browser. Never pull
    // it from under another process's export or capture: that would fail its work, which may not even need a login.
    const busy = this.browser.busyElsewhere();
    if (busy.length) {
      throw new Error(
        `Not logged into figma.com, but other figma-reader processes (pid ${busy.join(", ")}) are working in the shared ` +
          `browser, so it was not closed to open a login window. Retry when they finish.`,
      );
    }
    await this.browser.close();
    await this.browser.launchLoginWindow(`${ORIGIN}/login`);
  }

  /** Wait for login in the window (auth cookie appears, or the window is closed), then verify headless. */
  async waitForLogin(seconds: number) {
    const deadline = Date.now() + seconds * 1000;
    while (this.browser.launchRecord()?.purpose === "login" && !this.browser.loginCookiePresent()) {
      if (Date.now() > deadline) return null;
      await sleep(2000);
    }
    await sleep(3000); // let the browser persist the fresh cookies before closing it
    await this.browser.closeLoginWindow();
    const user = await this.whoami();
    if (!user) await this.openLogin();
    return user;
  }

  /** GET an internal www.figma.com/api endpoint with the browser's session cookies. */
  async api<T = any>(path: string): Promise<T> {
    const b = await this.browser.session();
    const { cookies } = await b.send("Storage.getCookies");
    const header = (cookies as any[])
      .filter((c) => c.domain === "figma.com" || c.domain.endsWith(".figma.com"))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const r = await fetch(`${ORIGIN}${path}`, {
      headers: { cookie: header, accept: "application/json", "x-csrf-bypass": "yes" },
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await r.json().catch(() => ({}))) as any;
    if (!r.ok || body?.error) {
      if (r.status === 401 || r.status === 403) {
        throw new FigmaApiError(`Figma API ${path}: ${r.status} ${body?.message ?? ""} (is the browser profile logged into figma.com?)`, r.status);
      }
      throw new FigmaApiError(`Figma API ${path}: ${r.status} ${body?.message ?? ""}`, r.status);
    }
    return body as T;
  }

  /**
   * The logged-in user, or null only when Figma says there is no session (401/403, or a session without a user).
   * Anything else (network error, 5xx, CDP failure) throws: treating it as logged out would close the shared
   * browser and open a login window for a login that is fine.
   */
  async whoami(): Promise<{ id: string; handle: string; email: string } | null> {
    let s: any;
    try {
      s = await this.api("/api/session/state");
    } catch (e) {
      if (e instanceof FigmaApiError && (e.status === 401 || e.status === 403)) return null;
      throw e;
    }
    const u = s?.meta?.users?.[0] ?? s?.meta?.user;
    return u ? { id: u.id, handle: u.handle, email: u.email } : null;
  }

  async recentFiles(): Promise<RecentFile[]> {
    await this.ensureLoggedIn();
    const j = await this.api("/api/recent_files");
    return (j.meta?.recent_files ?? []).map((f: any) => ({
      key: f.key,
      name: f.name,
      editorType: f.editor_type,
      teamId: f.team_id ?? null,
      updatedAt: f.updated_at,
      touchedAt: f.touched_at,
      url: `${ORIGIN}/${f.editor_type === "whiteboard" ? "board" : "design"}/${f.key}`,
    }));
  }

  /** Serialize work on this process's editor tab: concurrent calls would fight over selection and keystrokes. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const work = () => this.browser.busy(fn);
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Node ids Figma reports as selected; null when the internal store is not readable. */
  private selectedIds(page: CdpSession): Promise<string[] | null> {
    return page.evaluate<string[] | null>(SELECTION_EXPR).catch(() => null);
  }

  /**
   * Poll until Figma reports a selection: exactly `want` when given, otherwise any node. Returns
   * what was actually observed so callers can report facts. When the internal store is unreadable the
   * old fixed settle is used instead, so a change in Figma's internals degrades to the previous
   * behaviour rather than failing every capture.
   *
   * `want` has to BE the selection, not be among it: accepting it as one of several let a page capture
   * (which selects everything) hand its tab straight to the next node capture, and Ctrl+Shift+C then
   * copied the whole page and returned it labelled as that node.
   */
  private async awaitSelection(page: CdpSession, timeoutMs: number, want?: string): Promise<SelectionWait> {
    const start = Date.now();
    const hit = (ids: string[]) => (want ? ids.length === 1 && ids[0] === want : ids.length > 0);
    for (;;) {
      const ids = await this.selectedIds(page);
      if (ids === null) {
        await sleep(Math.max(0, this.ms(1500) - (Date.now() - start)));
        return { ids: null, readable: false, waitedMs: Date.now() - start };
      }
      const waitedMs = Date.now() - start;
      if (hit(ids) || waitedMs >= timeoutMs) return { ids, readable: true, matched: hit(ids), waitedMs };
      await sleep(this.ms(150));
    }
  }

  /**
   * Mark the tab as ours unless another process's mark is on it. An empty name is free: a cross-site navigation
   * (about:blank -> figma.com) clears window.name, including on our own tab.
   */
  private claim(s: CdpSession): Promise<boolean> {
    const mark = JSON.stringify(TAB_MARK);
    return s
      .evaluate<boolean>(`(window.name === "" || window.name === ${mark}) && ((window.name = ${mark}), true)`)
      .catch(() => false);
  }

  /** Our own dedicated editor tab, created on first use so user tabs are never navigated. */
  private async editorTab(retry = true): Promise<{ info: TargetInfo; session: CdpSession }> {
    const targets = await this.browser.targets();
    let info = this.tabId ? targets.find((t) => t.id === this.tabId) : undefined;
    if (info) {
      // Another process may have adopted the tab meanwhile (e.g. it saw our pid as dead): then it is theirs.
      if (!this.tab?.open) this.tab = await this.browser.attach(info);
      if (!(await this.claim(this.tab))) {
        this.forgetTab();
        info = undefined;
      }
    }
    if (!info) {
      // Adopt a tab left behind by a server process that has exited; never one a live process owns.
      for (const t of targets.filter((x) => x.url.startsWith(ORIGIN))) {
        const s = await this.browser.attach(t).catch(() => undefined);
        if (!s) continue;
        const seen = await s.evaluate<string>("window.name").catch(() => "");
        const owner = markOwner(seen);
        let claimed = false;
        if (owner !== undefined && (owner.pid === process.pid || abandoned(owner))) {
          // Write only while the name is still the one that was read. Writing unconditionally and re-reading let
          // two processes that both read the free mark verify their own write and both own the tab, whenever the
          // second write landed after the first process stopped looking: two real processes did exactly that.
          // One expression is one page task, so the read and the write cannot be interleaved.
          claimed = await s
            .evaluate<boolean>(`window.name === ${JSON.stringify(seen)} && ((window.name = ${JSON.stringify(TAB_MARK)}), true)`)
            .catch(() => false);
        }
        if (claimed) {
          this.tab?.close();
          this.tab = s;
          this.tabId = t.id;
          info = t;
          break;
        }
        s.close();
      }
    }
    if (!info) {
      this.tab?.close();
      this.tab = undefined;
      info = await this.browser.newTab("about:blank");
      this.tabId = info.id;
    }
    if (!this.tab?.open) this.tab = await this.browser.attach(info);
    await this.claim(this.tab);
    // A hidden tab (e.g. dragged into another window's tab strip) stops rendering; Copy as PNG then never fires.
    if ((await this.tab.evaluate<string>("document.visibilityState").catch(() => "visible")) === "hidden") {
      const b = await this.browser.session();
      await b.send("Target.activateTarget", { targetId: info.id }).catch(() => {});
      await sleep(this.ms(300));
      if (retry && (await this.tab.evaluate<string>("document.visibilityState").catch(() => "visible")) === "hidden") {
        this.tab.close();
        await b.send("Target.closeTarget", { targetId: info.id }).catch(() => {});
        this.tab = undefined;
        this.tabId = undefined;
        return this.editorTab(false);
      }
    }
    return { info, session: this.tab };
  }

  /**
   * Open fileKey (optionally selecting nodeId) in the editor tab and wait until the canvas is ready.
   * With requireSelection, also wait until Figma actually reports a selection instead of guessing a
   * settle time: every keystroke that follows depends on the node being selected. Pages never select,
   * so callers that intend to select-all pass requireSelection: false.
   */
  async openFile(fileKey: string, nodeId?: string, requireSelection = !!nodeId): Promise<CdpSession> {
    const { session } = await this.editorTab();
    const href: string = await session.evaluate("location.href");
    const want = nodeId?.replace(":", "-");
    let current: URL | undefined;
    try {
      current = new URL(href);
    } catch {}
    // Exact key of the open file: a branch path also contains its main file's key, and vice versa.
    const sameFile = !!current && fileKeyFromPath(current.pathname) === fileKey;
    const sameNode = !want || current?.searchParams.get("node-id") === want;
    const ready = sameFile && (await session.evaluate<boolean>("!!(window._fullscreen_?.isReady?.())").catch(() => false));
    if (ready && sameNode) {
      // Reuse the loaded file only when the node is still selected; otherwise fall through and re-navigate.
      if (!requireSelection) return session;
      const kept = await this.awaitSelection(session, this.ms(2000), nodeId);
      if (!kept.readable || kept.matched) return session;
    }

    const url = `${ORIGIN}/design/${fileKey}/${want ? `?node-id=${want}` : ""}`;
    await session.send("Page.navigate", { url });
    const deadline = Date.now() + this.ms(120_000);
    await sleep(this.ms(1500));
    while (Date.now() < deadline) {
      if (!session.open) throw new Error(`Figma editor tab closed while loading ${fileKey}`);
      const state = await session
        .evaluate<{ href: string; ready: boolean }>("({href: location.href, ready: !!(window._fullscreen_?.isReady?.())})")
        .catch(() => undefined);
      // Only the pathname says we were bounced to the login page: Figma puts the file name in the path, so a file
      // named "Login flow" loads at /design/<key>/Login-flow, and a query can carry "/login" as well.
      const path = state ? pathOf(state.href) : undefined;
      if (path === "/login" || path?.startsWith("/login/")) {
        await this.openLogin();
        throw new Error(LOGIN_MESSAGE);
      }
      // Which file actually loaded, not which one was asked for: sameFile was decided before navigating, and a
      // concurrent navigation (another process adopting this tab, or a user clicking around an attached browser)
      // would otherwise be accepted as this file and exported under its key.
      if (state?.ready && path && fileKeyFromPath(path) === fileKey) {
        await this.claim(session);
        if (!requireSelection) {
          await sleep(this.ms(1500)); // no selection to wait for: let zoom from node-id settle
          return session;
        }
        // Selection lands asynchronously after the canvas is ready, and takes seconds when the browser is
        // busy. Firing a shortcut before it lands captures nothing, so wait for the selection itself.
        const sel = await this.awaitSelection(session, this.ms(SELECT_TIMEOUT_MS), nodeId);
        if (!sel.readable || sel.matched) return session;
        throw new Error(selectionTimeoutMessage(fileKey, nodeId!, sel));
      }
      await sleep(this.ms(500));
    }
    throw new Error(`Figma editor did not become ready for ${fileKey}`);
  }

  /** Run File > Save local copy and return the path of the downloaded .fig. */
  saveLocalCopy(fileKey: string, destPath: string, timeoutMs = 600_000): Promise<string> {
    return this.exclusive(async () => {
      await this.ensureLoggedIn();
      return this.saveLocalCopyUnlocked(fileKey, destPath, timeoutMs);
    });
  }

  private async saveLocalCopyUnlocked(fileKey: string, destPath: string, timeoutMs: number): Promise<string> {
    const page = await this.openFile(fileKey);
    const browser = await this.browser.session();
    const { frameTree } = await page.send("Page.getFrameTree");
    const frameId: string = frameTree.frame.id;

    // Download behavior is browser-wide and shared by every server process: all use one directory,
    // each picks its own download by frame, and it is reset only when no other export holds a lease. The directory
    // is named after the browser profile (see tools.ts), because it is the browser that reads it: while it came from
    // the cache, two processes on one profile with different FIGMA_READER_CACHE values armed different directories,
    // and whoever armed second sent the other's download somewhere it was never waited for.
    const dir = join(this.downloadDir, "downloads");
    const leases = join(this.downloadDir, "download-leases");
    mkdirSync(dir, { recursive: true });
    const lease = takeLease(leases, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    let guid: string | undefined;
    let done: ((state: string) => void) | undefined;
    const finished = new Promise<string>((r) => (done = r));
    // Every export download seen during this attempt, adopted or not: an abandoned one keeps writing into the
    // shared directory and used to be cleaned only by the next cold start, because the cancel below was reached
    // for the adopted guid alone (measured on a download reported from another frame: nothing was ever sent).
    const seen = new Set<string>();
    const offBegin = browser.on("Browser.downloadWillBegin", (p) => {
      if (!/\.(fig|jam|deck|site|make|buzz)$/.test(p.suggestedFilename)) return;
      seen.add(p.guid);
      if (!guid && p.frameId === frameId) guid = p.guid;
    });
    const offProgress = browser.on("Browser.downloadProgress", (p) => {
      if (p.state !== "completed" && p.state !== "canceled") return;
      // A download Figma reports on a frame that is not ours (an export iframe, say) is still this export's when
      // no other export is running: the directory and the behaviour are browser-wide, and the only other writer
      // would be another process, which holds a lease while it exports. Without this the export waited out its
      // whole 600 s for an event that was never going to name our frame.
      if (!guid && seen.has(p.guid) && liveLeases(leases).length <= 1) guid = p.guid;
      if (p.guid === guid) done?.(p.state);
    });

    let state = "";
    try {
      await browser.send("Browser.setDownloadBehavior", armDownloads(dir));
      await this.quickAction(page, "Save local copy", "save-as");
      // A browser that dies mid-export never reports the download: fail at once instead of at the timeout.
      const gone = Promise.race([browser.closed, page.closed]).then(() => "interrupted: the browser connection closed");
      state = await Promise.race([finished, gone, sleep(timeoutMs).then(() => "timeout")]);
      if (state !== "completed") throw new Error(`Save local copy ${state}${guid ? "" : " (download never started; file may restrict copying)"}`);
      moveDownload(join(dir, guid!), destPath);
      return destPath;
    } finally {
      offBegin();
      offProgress();
      // Every download this attempt saw, not only the adopted one: an abandoned download would otherwise keep
      // writing into the shared directory until some later process cold-starts.
      for (const g of seen) {
        if (g === guid && state === "completed") continue;
        await browser.send("Browser.cancelDownload", { guid: g }).catch(() => {});
      }
      rmSync(lease, { force: true });
      for (const g of seen) rmSync(join(dir, g), { force: true });
      await releaseDownloadBehavior(browser, leases, dir);
    }
  }

  private async quickAction(page: CdpSession, query: string, testId: string) {
    // Panels that grab focus on load (e.g. Comments on files with comments) swallow Ctrl+/; clear focus and
    // confirm the Quick actions search box actually opened before typing, retrying a few times.
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.focusCanvas(page, true);
      await page.key("/", "Slash", 191, MOD.ctrl);
      let open = false;
      for (let i = 0; i < 12 && !open; i++) {
        await sleep(this.ms(250));
        open = await page.evaluate<boolean>(QUICK_ACTION_BOX).catch(() => false);
      }
      if (!open) continue;
      await page.send("Input.insertText", { text: query });
      for (let i = 0; i < 20; i++) {
        await sleep(this.ms(250));
        const clicked = await page.evaluate<boolean>(
          `(()=>{const b=document.querySelector('button[data-testid="${testId}"]');if(!b||b.getAttribute("aria-disabled")==="true")return false;b.click();return true})()`,
        );
        if (clicked) return;
      }
    }
    const diag = await page
      .evaluate<Raw>(`(()=>{const a=document.activeElement;const b=document.querySelector('button[data-testid="${testId}"]');
        return {active: a?.tagName+" "+(a?.getAttribute("aria-label")||a?.placeholder||""), input: a?.value, class: a?.className,
          button: b ? b.getAttribute("aria-disabled") : "missing",
          buttons: [...document.querySelectorAll('button[data-testid]')].slice(0,8).map(x=>x.dataset.testid),
          dialogs: [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].map(d=>d.textContent.trim().slice(0,120))}})()`)
      .catch((e) => ({ error: String(e) }));
    await page.key("Escape", "Escape", 27);
    throw new Error(`quick action "${query}" not available (data-testid=${testId}) ${JSON.stringify(diag)}`);
  }

  /** Select nodeId and run Edit > Copy as PNG, capturing the image in-page without touching the system clipboard. */
  copyAsPng(fileKey: string, nodeId: string, maxDimension: number, selectAll = false): Promise<PngCapture> {
    return this.exclusive(async () => {
      await this.ensureLoggedIn();
      return this.copyAsPngUnlocked(fileKey, nodeId, maxDimension, selectAll);
    });
  }

  /** Drop keyboard focus from panels that grab it on load (e.g. Comments), so canvas shortcuts reach Figma. */
  private async focusCanvas(page: CdpSession, escape: boolean) {
    // Escape also clears Figma's selection, so it is only safe before commands that do not need one.
    for (let i = 0; escape && i < 2; i++) {
      await page.key("Escape", "Escape", 27);
      await sleep(this.ms(150));
    }
    await page.evaluate("document.activeElement && document.activeElement !== document.body && document.activeElement.blur()").catch(() => {});
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 800, y: 500 });
  }

  private async copyAsPngUnlocked(fileKey: string, nodeId: string, maxDimension: number, selectAll: boolean): Promise<PngCapture> {
    let selection: SelectionWait = { ids: null, readable: false, waitedMs: 0 };
    for (let attempt = 1; ; attempt++) {
      // openFile guarantees a selection when one is required, so the shortcut below never fires into the void.
      const page = await this.openFile(fileKey, nodeId, !selectAll);
      await page.evaluate(`(()=>{
        const cb = navigator.clipboard;
        if (!window.${ORIG_WRITE_KEY}) window.${ORIG_WRITE_KEY} = cb.write.bind(cb);
        window.${PNG_KEY} = null;
        const write = async (items) => {
          for (const it of items) if (it.types.includes("image/png")) { window.${PNG_KEY} = await it.getType("image/png"); return; }
          return window.${ORIG_WRITE_KEY}(items);
        };
        write.__figmaReaderPid = ${process.pid};
        cb.write = write;
      })()`);
      try {
        await this.focusCanvas(page, false);
        if (selectAll) {
          await page.key("a", "KeyA", 65, MOD.ctrl);
          selection = await this.awaitSelection(page, this.ms(5000));
        } else {
          selection = await this.awaitSelection(page, this.ms(2000), nodeId);
        }
        // The budget is what one attempt waits for the image, so it is measured from the shortcut. Starting it
        // above spent up to 5 s of the 30 s on the selection, and captureTimeoutMessage then reported the whole
        // window as time spent waiting for the image.
        const started = Date.now();
        await page.key("C", "KeyC", 67, MOD.ctrl | MOD.shift);
        while (Date.now() - started < this.ms(CAPTURE_TIMEOUT_MS)) {
          await sleep(this.ms(250));
          if (await page.evaluate<boolean>(`!!window.${PNG_KEY}`)) return await this.readPng(page, maxDimension);
        }
        selection = await this.awaitSelection(page, 0); // report the selection as it stood at the end
        if (attempt >= CAPTURE_ATTEMPTS) {
          throw new Error(
            captureTimeoutMessage({ nodeId, selection, attempts: attempt, waitedMs: Date.now() - started, selectAll }),
          );
        }
      } finally {
        await page
          .evaluate(
            `window.${ORIG_WRITE_KEY} && navigator.clipboard.write?.__figmaReaderPid === ${process.pid} && ` +
              `(navigator.clipboard.write = window.${ORIG_WRITE_KEY})`,
          )
          .catch(() => {});
        // Select-all leaves the whole page selected in a tab the next call reuses. Measured: a page capture
        // followed by a capture of a frame of that page returned an image of the entire page, labelled as the
        // frame, because Ctrl+Shift+C copied the selection that was still standing.
        if (selectAll) await page.key("Escape", "Escape", 27).catch(() => {});
      }
    }
  }

  /** Read the captured blob out of the page, downscaled to maxDimension, as base64. */
  private async readPng(page: CdpSession, maxDimension: number): Promise<PngCapture> {
    // The size is read first so a failure can name it: decoding, downscaling and encoding a large capture used to
    // run under evaluate's 60 s default and fail as a bare "CDP Runtime.evaluate timed out", outside the retry
    // loop, saying nothing about what made it slow.
    const bytes = await page.evaluate<number>(`window.${PNG_KEY}?.size ?? 0`).catch(() => 0);
    try {
      return await this.decodePng(page, maxDimension);
    } catch (e) {
      throw new Error(
        `Figma's ${(bytes / 1e6).toFixed(1)} MB image could not be read out of the page within ` +
          `${READ_PNG_TIMEOUT_MS / 1000}s (decode, downscale to ${Math.max(16, Math.floor(maxDimension))}px, base64): ` +
          `${e instanceof Error ? e.message : String(e)}. Capture a smaller node: the image is decoded at its full ` +
          `size before it is downscaled.`,
      );
    }
  }

  private decodePng(page: CdpSession, maxDimension: number): Promise<PngCapture> {
    return page.evaluate<PngCapture>(
      `(async()=>{
      const blob = window.${PNG_KEY}; window.${PNG_KEY} = null;
      const bmp = await createImageBitmap(blob);
      const max = ${Math.max(16, Math.floor(maxDimension))};
      const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
      let out = blob, w = bmp.width, h = bmp.height;
      if (s < 1) {
        w = Math.max(1, Math.round(bmp.width * s)); h = Math.max(1, Math.round(bmp.height * s));
        const c = new OffscreenCanvas(w, h); const ctx = c.getContext("2d");
        ctx.imageSmoothingQuality = "high"; ctx.drawImage(bmp, 0, 0, w, h);
        out = await c.convertToBlob({ type: "image/png" });
      }
      const buf = new Uint8Array(await out.arrayBuffer());
      let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { base64: btoa(bin), width: w, height: h, originalWidth: bmp.width, originalHeight: bmp.height };
    })()`,
      this.ms(READ_PNG_TIMEOUT_MS),
    );
  }
}

/** A half-copied snapshot moveDownload left behind: "<key>.fig.<pid>.tmp" before the random suffix, and after it. */
const HALF_COPIED = /\.fig\.\d+(?:\.[a-z0-9]+)?\.tmp$/;

/**
 * Remove leftovers of exports that never finished: old per-export dirs, half-copied snapshots, and downloads/
 * when no export is running.
 */
export function cleanStaleDownloads(dir: string) {
  try {
    const names = readdirSync(dir);
    for (const f of names) if (f.startsWith("dl-")) rmSync(join(dir, f), { recursive: true, force: true });
    const checked = Date.now();
    if (liveLeases(join(dir, "download-leases")).length) return;
    // A crash between moveDownload's copy and its rename leaves a full-size partial beside the snapshot. Nothing
    // reads those names - localFigFiles and store.peek both ignore them - so they were pure leaked disk, up to
    // one .fig per crash. Same rule as below: an export in progress keeps writing, so only an untouched one goes.
    for (const f of names) {
      if (!HALF_COPIED.test(f)) continue;
      const st = statSync(join(dir, f), { throwIfNoEntry: false });
      if (st && st.mtimeMs < checked) rmSync(join(dir, f), { force: true });
    }
    // An export takes its lease before its download starts, so any file older than the check is orphaned.
    const downloads = join(dir, "downloads");
    for (const f of readdirSync(downloads)) {
      const path = join(downloads, f);
      if (statSync(path).mtimeMs < checked) rmSync(path, { recursive: true, force: true });
    }
  } catch {}
}
