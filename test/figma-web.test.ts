// Login state decides whether the shared browser gets closed for a login window, so only Figma saying "no session"
// may count as logged out. The browser and figma.com are stubbed: no network, no real state.
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const root = mkdtempSync(join(tmpdir(), "figma-reader-test-"));
// Never touch the real state, cache or data directories. HOME is not what Windows reads: os.homedir() takes
// USERPROFILE there, and the roots are built from APPDATA and LOCALAPPDATA.
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.APPDATA = join(root, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(root, "AppData", "Local");
const { abandoned, cleanStaleDownloads, FigmaWeb, markOwner, moveDownload, releaseDownloadBehavior, TAB_MARK } = await import("../src/figma-web.ts");
const { bootId, processStart, takeLease } = await import("../src/browser.ts");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
after(() => rmSync(root, { recursive: true, force: true }));

/** Every wait in FigmaWeb, scaled: at 1 the loops below are minutes long, which is time no test would spend. */
const FAST = 0.02;

/** The browser-level CDP session: cookies for whoami, download events, and a record of what was sent. */
function fakeCdp() {
  const listeners = new Map<string, Set<(p: any) => void>>();
  const sent: { method: string; params: Record<string, any> }[] = [];
  return {
    sent,
    // Never settles: saveLocalCopy races this against the download, and a resolved one is "the browser died".
    closed: new Promise<void>(() => {}),
    send: async (method: string, params: Record<string, any> = {}) => {
      sent.push({ method, params });
      return method === "Storage.getCookies" ? { cookies: [{ domain: ".figma.com", name: "a", value: "b" }] } : {};
    },
    on(method: string, fn: (p: any) => void) {
      let set = listeners.get(method);
      if (!set) listeners.set(method, (set = new Set()));
      set.add(fn);
      return () => set!.delete(fn);
    },
    emit(method: string, params: Record<string, unknown>) {
      for (const fn of [...(listeners.get(method) ?? [])]) fn(params);
    },
  };
}

/** A browser stand-in that records whether anything tried to close it or open a login window. */
function fakeBrowser(over: Record<string, unknown> = {}, opts: { dir?: string; timeScale?: number } = {}) {
  const calls: string[] = [];
  const cdp = fakeCdp();
  const b = {
    managed: true,
    session: async () => cdp,
    launchRecord: () => undefined,
    busyElsewhere: () => [],
    busy: (fn: () => Promise<unknown>) => fn(),
    close: async () => void calls.push("close"),
    launchLoginWindow: async () => void calls.push("login"),
    ...over,
  };
  return { web: new FigmaWeb(b as any, opts.dir ?? root, opts.timeScale ?? FAST), calls, cdp };
}

const ORIGIN = "https://www.figma.com";
const KEY = "AbCdEf1234567890XyZ";

/** An element, with the properties the page-side expressions in figma-web.ts read off one. */
interface FakeEl {
  tag: string;
  tagName: string;
  attrs: Record<string, string>;
  value: string;
  className: string;
  textContent: string;
  dataset: { testid?: string };
  getAttribute(k: string): string | null;
  closest(sel: string): FakeEl | null;
  click(): void;
  blur(): void;
}

/** Only the selector shapes figma-web.ts uses: a tag, [attr], [attr="v"], [attr*="v"], and comma lists of those. */
function matches(e: FakeEl, sel: string): boolean {
  return sel.split(",").some((one) => {
    const s = one.trim();
    const tag = s.match(/^[a-z]+/i)?.[0];
    if (tag && e.tag !== tag) return false;
    for (const m of s.matchAll(/\[([\w-]+)(?:(\*?=)"?([^\]"]*)"?)?\]/g)) {
      const v = e.attrs[m[1]!];
      if (v === undefined) return false;
      if (m[2] === "=" && v !== m[3]) return false;
      if (m[2] === "*=" && !v.includes(m[3]!)) return false;
    }
    return true;
  });
}

function fakeDom() {
  const els: FakeEl[] = [];
  const doc = {
    visibilityState: "visible",
    body: { tagName: "BODY" },
    activeElement: null as FakeEl | null,
    querySelector: (sel: string) => els.find((e) => matches(e, sel)) ?? null,
    querySelectorAll: (sel: string) => els.filter((e) => matches(e, sel)),
  };
  const add = (tag: string, attrs: Record<string, string> = {}, onClick?: () => void) => {
    const e: FakeEl = {
      tag,
      tagName: tag.toUpperCase(),
      attrs,
      value: "",
      className: attrs.class ?? "",
      textContent: "",
      dataset: { testid: attrs["data-testid"] },
      getAttribute: (k) => attrs[k] ?? null,
      // Nothing in the fake page is nested, so an ancestor lookup only ever sees the element itself.
      closest: (sel) => (matches(e, sel) ? e : null),
      click: () => onClick?.(),
      blur: () => {
        if (doc.activeElement === e) doc.activeElement = null;
      },
    };
    els.push(e);
    return e;
  };
  return { doc, add, get: (sel: string) => doc.querySelector(sel) };
}

/**
 * The image Figma's clipboard write hands over. It carries the ids it was rendered from, so a test can see which
 * nodes the capture actually covered - that is the whole question behind the page/frame bleed.
 */
const pngBlob = (ids: string[], width: number, height: number) => ({
  size: 4096,
  width,
  height,
  ids,
  arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ ids, width, height })).buffer,
});

/** What readPng's expression calls: a decode that keeps the ids, and a canvas that carries them through a resize. */
const captureGlobals = {
  createImageBitmap: async (b: any) => ({ width: b.width, height: b.height, ids: b.ids }),
  btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
  OffscreenCanvas: class {
    ids: string[] = [];
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return { imageSmoothingQuality: "", drawImage: (bmp: any) => (this.ids = bmp.ids) };
    }
    async convertToBlob() {
      return pngBlob(this.ids, this.width, this.height);
    }
  },
};

/** Ids the capture rendered, read back out of the base64 the page returned. */
const idsOf = (cap: { base64: string }) => JSON.parse(Buffer.from(cap.base64, "base64").toString()).ids as string[];

/** How the fake editor behaves: the parts that differ between the failures worth testing. */
interface Editor {
  /** Node ids the open page holds: what Ctrl+A selects, and which ?node-id values Figma can honour. */
  pageIds: string[];
  /** The Quick actions box opens, never opens, or a panel's own empty input keeps the focus instead. */
  box: "opens" | "never" | "rename";
  /**
   * Which of the three signals the box's markup carries. Figma's markup is all the evidence there is for which
   * input has the focus, and it has changed before, so each signal has to be enough on its own; the box Figma
   * ships today carries the first two.
   */
  boxSignals: ("placeholder" | "class" | "testid")[];
  /** Polls the box takes to take focus after Ctrl+/ reaches the canvas. */
  boxOpensAfter: number;
  /** A panel swallows the first Ctrl+/, as the Comments panel does on files with comments. */
  swallowFirstSlash: boolean;
  /** Whether Ctrl+Shift+C parks an image at all (a file that restricts copying never does). */
  copies: boolean;
  /** Size of the image a capture produces. */
  width: number;
  height: number;
}

interface FakeTab {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
  ctx: vm.Context;
  /** How many times the load-state expression was evaluated on this tab. */
  polls: number;
  /** Node ids Figma reports as selected; null stands for an internal store that cannot be read at all. */
  selection: string[] | null;
  /** Keys delivered to this tab, as "ctrl+shift+KeyC". */
  keys: string[];
  /** Text Input.insertText put into the page, one entry per call. */
  typed: string[];
  dom: ReturnType<typeof fakeDom>;
  /** Whether Ctrl+/ reached the canvas, and how many polls have passed since. */
  opening: boolean;
  boxPolls: number;
}

/**
 * Tabs as vm contexts, so the page-side expressions run as written, driven through the CDP calls FigmaWeb really
 * makes. Adoption only ever looks at tabs already on the origin, so a tab that has been used carries a figma.com
 * url; `redirect` stands for Figma answering a navigation with another url (its own file name, or /login).
 *
 * The tab also answers keystrokes the way the editor does: Ctrl+A selects the page, Ctrl+Shift+C writes an image
 * of the selection to the clipboard (through the page's own patched navigator.clipboard.write), Escape drops the
 * selection and the focus, and Ctrl+/ opens the Quick actions box - or does not, which is where the interesting
 * failures live.
 */
function tabWorld(
  hooks: {
    redirect?: (url: string) => string;
    afterEvaluate?: (t: FakeTab, expr: string) => void;
    onNavigate?: (t: FakeTab, url: string) => void;
    onClick?: (t: FakeTab, testId: string) => void;
    editor?: Partial<Editor>;
  } = {},
) {
  const tabs = new Map<string, FakeTab>();
  const ed: Editor = {
    pageIds: ["1:2"],
    box: "opens",
    boxSignals: ["placeholder", "class"],
    boxOpensAfter: 1,
    swallowFirstSlash: false,
    copies: true,
    width: 800,
    height: 400,
    ...hooks.editor,
  };
  /**
   * Figma selecting nodes. It also rewrites the node-id in the address bar, which is how a page capture's
   * select-all left the next call looking at a url that named the very frame it wanted.
   */
  const select = (t: FakeTab, ids: string[]) => {
    t.selection = ids;
    if (!ids.length) return;
    const u = new URL(t.ctx.location.href);
    u.searchParams.set("node-id", ids[0]!.replace(":", "-"));
    t.url = t.ctx.location.href = u.href;
  };
  /** Land the tab on url with a loaded editor, as a real navigation does. */
  const go = (t: FakeTab, url: string) => {
    t.url = url;
    t.ctx.location.href = url;
    t.ctx.window._fullscreen_ = {
      isReady: () => true,
      _store: { getState: () => ({ mirror: { sceneGraphSelection: t.selection && Object.fromEntries(t.selection.map((id) => [id, 1])) } }) },
    };
    const node = new URL(url, ORIGIN).searchParams.get("node-id")?.replace("-", ":");
    // Figma selects the node a ?node-id names when the file holds it; a page id selects nothing.
    t.selection = node && ed.pageIds.includes(node) ? [node] : [];
    hooks.onNavigate?.(t, url);
  };
  const press = async (t: FakeTab, name: string) => {
    const doc = t.dom.doc;
    if (name === "Escape") {
      t.opening = false;
      t.boxPolls = 0;
      doc.activeElement = null;
      select(t, []);
    } else if (name === "ctrl+KeyA") {
      select(t, [...ed.pageIds]);
    } else if (name === "ctrl+Slash") {
      if (ed.box === "opens" && !(ed.swallowFirstSlash && t.keys.filter((k) => k === "ctrl+Slash").length === 1)) t.opening = true;
    } else if (name === "ctrl+shift+KeyC" && ed.copies && t.selection?.length) {
      // Through the page's own clipboard patch, so what parks the image is the code under test.
      t.ctx.__item = { types: ["image/png"], getType: async () => pngBlob(t.selection!, ed.width, ed.height) };
      await vm.runInContext("navigator.clipboard.write([__item])", t.ctx);
    }
  };
  const newTab = async (url = "about:blank") => {
    const id = `t${tabs.size}`;
    const dom = fakeDom();
    const ctx = vm.createContext({
      window: { name: "" },
      document: dom.doc,
      location: { href: url },
      navigator: { clipboard: { write: async () => {} } },
      ...captureGlobals,
    });
    const t: FakeTab = {
      id, type: "page", url, title: "", webSocketDebuggerUrl: `ws://x/${id}`, ctx,
      polls: 0, selection: [], keys: [], typed: [], dom, opening: false, boxPolls: 0,
    }; // prettier-ignore
    // The quick-action container is the box's own element here: nothing in the fake page is nested, so an ancestor
    // lookup only ever reaches the element itself.
    const box: Record<string, string> = {};
    if (ed.boxSignals.includes("placeholder")) box.placeholder = "Find actions, plugins and more";
    if (ed.boxSignals.includes("class")) box.class = "quick_actions--input--a1b2";
    if (ed.boxSignals.includes("testid")) box["data-testid"] = "quick-action-input";
    dom.add("input", box);
    // A panel field that is empty and focusable too: the old "an empty INPUT has focus" check could not tell it
    // from the box, and typed the query into it.
    dom.add("input", { "data-testid": "layer-name", "aria-label": "Rename layer" });
    dom.add("button", { "data-testid": "save-as", "aria-disabled": "true" }, () => hooks.onClick?.(t, "save-as"));
    tabs.set(id, t);
    return t;
  };
  const attach = async (info: { id: string }) => {
    const t = tabs.get(info.id)!;
    const dom = t.dom;
    return {
      open: true,
      closed: new Promise<void>(() => {}),
      close() {},
      evaluate: async (expr: string) => {
        if (expr.includes("isReady")) t.polls++;
        // Whatever it asks about the focused input is the poll that waits for the box to open.
        if (expr.includes("activeElement") && expr.includes("INPUT")) {
          if (ed.box === "rename") dom.doc.activeElement = dom.get('[data-testid="layer-name"]');
          else if (t.opening && ++t.boxPolls >= ed.boxOpensAfter) dom.doc.activeElement = dom.get("input");
        }
        const v = vm.runInContext(expr, t.ctx);
        hooks.afterEvaluate?.(t, expr);
        return v;
      },
      key: async (_key: string, code: string, _keyCode: number, modifiers = 0) => {
        const name = `${modifiers & 2 ? "ctrl+" : ""}${modifiers & 8 ? "shift+" : ""}${code}`;
        t.keys.push(name);
        await press(t, name);
      },
      send: async (method: string, params: Record<string, any> = {}) => {
        if (method === "Page.navigate") go(t, hooks.redirect ? hooks.redirect(params.url!) : params.url!);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: `frame-${t.id}` } } };
        if (method === "Input.insertText") {
          t.typed.push(params.text);
          const a = dom.doc.activeElement;
          if (a) a.value += params.text;
          // The action only offers itself once the query names it, and only the box's query reaches it.
          if (a === dom.get("input")) dom.get('button[data-testid="save-as"]')!.attrs["aria-disabled"] = "false";
        }
        return {};
      },
    };
  };
  return { tabs, ed, world: { targets: async () => [...tabs.values()], newTab, attach } };
}

const respond = (status: number, body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
};

const user = { id: "1", handle: "Ada", email: "ada@example.com" };
/** Logged in, which every tab-driving test needs before it gets to the editor. */
const loggedIn = () => respond(200, { meta: { users: [user] } });
/** A download directory of this test's own: the leases in it decide whether a foreign download may be adopted. */
const workDir = () => mkdtempSync(join(root, "work-"));

test("a session with a user is logged in; Figma's own 'no session' answers are logged out", async () => {
  const { web } = fakeBrowser();
  respond(200, { meta: { users: [user] } });
  assert.deepEqual(await web.whoami(), user);
  respond(200, { meta: { users: [] } });
  assert.equal(await web.whoami(), null);
  respond(401, { error: true, message: "unauthorized" });
  assert.equal(await web.whoami(), null);
  respond(403, { error: true });
  assert.equal(await web.whoami(), null);
});

test("server errors, network errors and browser failures are errors, not 'logged out'", async () => {
  const { web } = fakeBrowser();
  respond(503, { error: true, message: "unavailable" });
  await assert.rejects(web.whoami(), /503/);
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(web.whoami(), /fetch failed/);
  const cdp = fakeBrowser({ session: async () => ({ send: async () => Promise.reject(new Error("CDP Storage.getCookies timed out")) }) });
  await assert.rejects(cdp.web.whoami(), /timed out/);
});

test("a transient failure does not close the shared browser or open a login window", async () => {
  const { web, calls } = fakeBrowser();
  respond(500, { error: true });
  await assert.rejects(web.ensureLoggedIn(), /500/);
  assert.deepEqual(calls, []);
});

test("orphaned downloads are cleaned at startup, but never while an export holds a live lease", () => {
  const cache = join(root, "cache");
  const orphan = join(cache, "downloads", "guid-1");
  mkdirSync(join(cache, "downloads"), { recursive: true });
  writeFileSync(orphan, "partial");
  const past = new Date(Date.now() - 60_000);
  utimesSync(orphan, past, past);
  const lease = takeLease(join(cache, "download-leases"), `${process.pid}-1-x`);
  cleanStaleDownloads(cache);
  assert.ok(existsSync(orphan), "kept while an export runs");
  rmSync(lease);
  cleanStaleDownloads(cache);
  assert.ok(!existsSync(orphan));
});

test("a half-copied snapshot left by a crash is swept", () => {
  // moveDownload copies through a temporary beside the destination when the cache is on another filesystem. A
  // crash in between leaves a full-size partial that no reader ever looks at: localFigFiles and store.peek both
  // ignore it, so it was a leak of up to one .fig per crash, cleaned by nothing.
  const cache = mkdtempSync(join(root, "sweep-"));
  mkdirSync(join(cache, "downloads"), { recursive: true });
  const partial = join(cache, `${KEY}.fig.4242.ab12cd.tmp`);
  const legacy = join(cache, `${KEY}.fig.4242.tmp`); // the name before the random suffix
  const snapshot = join(cache, `${KEY}.fig`);
  for (const f of [partial, legacy, snapshot]) writeFileSync(f, "bytes");
  const past = new Date(Date.now() - 60_000);
  for (const f of [partial, legacy]) utimesSync(f, past, past);
  cleanStaleDownloads(cache);
  assert.deepEqual(readdirSync(cache).filter((f) => f.endsWith(".tmp")), []);
  assert.ok(existsSync(snapshot), "the snapshot itself is not a leftover");

});

test("two copies onto one snapshot path cannot collide over their temporary", (t) => {
  // The pid alone is not unique: two containers sharing a bind-mounted cache have their own pid namespaces, and
  // the second copy then wrote over the first one's temporary while it was still being read - both are exporting
  // the same file key, so both name the temporary after the same destination.
  //
  // Only a destination on another filesystem makes moveDownload copy at all (on Linux /dev/shm is one); with both
  // paths on one filesystem it renames outright and there is no temporary to collide over. The temporary is also
  // gone by the time moveDownload returns, so its name is read off disk by stopping the last step: a rename onto a
  // directory fails, and what was copied stays where it was written, under its full name.
  if (!existsSync("/dev/shm")) return t.skip("no second filesystem to copy across");
  const from = mkdtempSync(join("/dev/shm", "figma-reader-test-"));
  const cache = mkdtempSync(join(root, "collide-"));
  const dest = join(cache, `${KEY}.fig`);
  mkdirSync(dest);
  try {
    const names = new Set<string>();
    for (const n of [1, 2]) {
      const src = join(from, `guid-${n}`);
      writeFileSync(src, `fig ${n}`);
      assert.throws(() => moveDownload(src, dest), { code: "EISDIR" });
      for (const f of readdirSync(cache)) if (f.endsWith(".tmp")) names.add(f);
    }
    assert.equal(names.size, 2, "two copies of one key, two temporaries");
    assert.deepEqual(
      [...names].map((f) => readFileSync(join(cache, f), "utf8")).sort(),
      ["fig 1", "fig 2"],
      "and neither was written over the other while it was being read",
    );
  } finally {
    rmSync(from, { recursive: true, force: true });
  }
});

test("a finished download is moved onto the snapshot even when the two are on different filesystems", () => {
  // The download directory belongs to the browser profile and the snapshot to the cache, which FIGMA_READER_CACHE
  // can put on another filesystem: rename then fails with EXDEV, and the export used to die at the last step. On
  // Linux /dev/shm is such another filesystem; elsewhere this covers the plain rename.
  const from = mkdtempSync(join(existsSync("/dev/shm") ? "/dev/shm" : tmpdir(), "figma-reader-test-"));
  const src = join(from, "guid-1");
  const dest = join(root, "moved.fig");
  writeFileSync(src, "fig bytes");
  try {
    moveDownload(src, dest);
    assert.equal(readFileSync(dest, "utf8"), "fig bytes");
    assert.ok(!existsSync(src), "and is not left behind in the directory the browser keeps writing to");
    // A copy straight onto the destination would be readable half-written; it goes through a temp file beside it.
    assert.deepEqual(readdirSync(root).filter((f) => f.endsWith(".tmp")), []);
  } finally {
    rmSync(from, { recursive: true, force: true });
  }
});

test("the download behaviour is kept while any export holds a lease, and re-armed for one taken during the reset", async () => {
  const leases = join(root, "reset-leases");
  const dir = join(root, "reset-downloads");
  const sent: Record<string, unknown>[] = [];
  const browser = (onSend?: () => void) => ({
    send: async (_method: string, params: Record<string, unknown> = {}) => (sent.push(params), onSend?.(), {}),
  });

  const held = takeLease(leases, `${process.pid}-busy-a`);
  await releaseDownloadBehavior(browser(), leases, dir);
  assert.equal(sent.length, 0, "another export is still downloading");
  rmSync(held);

  // Reading the leases and sending the reset are two round trips. An export that takes its lease in between would
  // download into the browser's default directory and be waited for, in ours, until the 600 s timeout.
  let late: string | undefined;
  await releaseDownloadBehavior(
    browser(() => (late ??= takeLease(leases, `${process.pid}-late-b`))),
    leases,
    dir,
  );
  assert.deepEqual(sent.map((p) => p.behavior), ["default", "allowAndName"]);
  assert.equal(sent[1]!.downloadPath, dir);
  rmSync(late!);

  sent.length = 0;
  await releaseDownloadBehavior(browser(), leases, dir);
  assert.deepEqual(sent.map((p) => p.behavior), ["default"], "with nobody left the reset stands");
});

test("a file whose name starts with 'login' opens normally instead of being read as a logged-out bounce", async () => {
  // Figma serves /design/<key>/ as /design/<key>/<file name>, so the name is part of the href we inspect.
  const { world } = tabWorld({ redirect: (url) => `${url}Login-flow?t=/login` });
  const { web, calls } = fakeBrowser(world);
  const page = await web.openFile(KEY);
  assert.equal(await page.evaluate("location.href"), `${ORIGIN}/design/${KEY}/Login-flow?t=/login`);
  assert.deepEqual(calls, [], "the shared browser was not closed for a login window");
});

test("a real bounce to the login page is still reported as logged out", async () => {
  const { world } = tabWorld({ redirect: () => `${ORIGIN}/login?return_url=%2Fdesign` });
  const { web, calls } = fakeBrowser(world);
  await assert.rejects(web.openFile(KEY), /Not logged into figma\.com/);
  assert.deepEqual(calls, ["close", "login"]);
});

test("a tab that lands on another file is not accepted as the file that was asked for", async () => {
  // What the editor ends up showing is decided by whoever navigated last, so "ready" alone said nothing about
  // which file is open: this is what turned a doubly-owned tab into an export cached under the wrong key.
  const OTHER = "ZzYyXx9876543210AbC";
  const { tabs, world } = tabWorld({
    redirect: () => `${ORIGIN}/design/${OTHER}/Someone-elses-file`,
    afterEvaluate: (t, expr) => {
      if (expr.includes("isReady") && t.polls === 2) t.ctx.location.href = `${ORIGIN}/design/${KEY}/My-App`;
    },
  });
  const { web } = fakeBrowser(world);
  const page = await web.openFile(KEY);
  assert.equal(await page.evaluate("location.href"), `${ORIGIN}/design/${KEY}/My-App`);
  assert.ok([...tabs.values()][0]!.polls > 2, "kept polling while the other file was open");
});

test("a cached editor tab that another process took over is left to it, not re-marked", async () => {
  const { tabs, world } = tabWorld();
  const { web } = fakeBrowser(world);
  const first = await (web as any).editorTab();
  assert.equal(tabs.get(first.info.id)!.ctx.window.name, TAB_MARK);
  // A tab that has been used sits on the origin; adoption only ever looks at those.
  tabs.get(first.info.id)!.url = `${ORIGIN}/design/${KEY}/My-App`;
  const other = `figma-reader:${process.ppid}:${processStart(process.ppid)}`; // a live process
  tabs.get(first.info.id)!.ctx.window.name = other;
  const second = await (web as any).editorTab();
  assert.notEqual(second.info.id, first.info.id, "moved to a tab of its own");
  assert.equal(tabs.get(first.info.id)!.ctx.window.name, other, "the other process's mark is untouched");
  // Our own tab whose name a cross-site navigation cleared is still ours.
  tabs.get(second.info.id)!.ctx.window.name = "";
  assert.equal((await (web as any).editorTab()).info.id, second.info.id);
});

test("an abandoned tab another process marks between our read and our write stays that process's tab", async () => {
  // The old claim wrote the mark unconditionally, slept and re-read it: whenever the rival's write landed after
  // that sleep, both processes verified their own mark and both owned the tab - two real processes did exactly
  // that, and an export then gets cached under the file key the other process was opening.
  const rival = `figma-reader:${process.ppid}:${processStart(process.ppid)}`;
  const { tabs, world } = tabWorld({
    afterEvaluate: (t, expr) => {
      if (expr === "window.name" && t.ctx.window.name === "figma-reader") t.ctx.window.name = rival;
    },
  });
  const contested = await world.newTab(`${ORIGIN}/design/${KEY}/My-App`);
  contested.ctx.window.name = "figma-reader"; // a mark with no owner: free to take
  const { web } = fakeBrowser(world);
  const got = await (web as any).editorTab();
  assert.equal(contested.ctx.window.name, rival, "the rival's mark is not overwritten");
  assert.notEqual(got.info.id, contested.id, "and the tab is left to it");
  assert.equal(tabs.size, 2);
});

test("logged out: the work browser is replaced by a login window, unless another process is working in it", async () => {
  respond(401, {});
  const idle = fakeBrowser();
  await assert.rejects(idle.web.ensureLoggedIn(), /Not logged into figma\.com\. A browser window was opened/);
  assert.deepEqual(idle.calls, ["close", "login"]);

  const shared = fakeBrowser({ busyElsewhere: () => [4242] });
  await assert.rejects(shared.web.ensureLoggedIn(), /other figma-reader processes \(pid 4242\)/);
  assert.deepEqual(shared.calls, []);
});

test("tab marks carry the owner's boot and start time, and older marks still parse", () => {
  assert.deepEqual(markOwner("figma-reader@0f9c-boot:123:4567"), { pid: 123, start: "4567", boot: "0f9c-boot" });
  assert.deepEqual(markOwner("figma-reader:123"), { pid: 123, start: undefined, boot: undefined });
  // ps lstart (non-Linux) contains spaces and colons.
  assert.deepEqual(markOwner("figma-reader:123:Mon Sep 22 10:00:00 2026"), { pid: 123, start: "Mon Sep 22 10:00:00 2026", boot: undefined });
  assert.deepEqual(markOwner("figma-reader@0f9c-boot:123:Mon Sep 22 10:00:00 2026"), {
    pid: 123,
    start: "Mon Sep 22 10:00:00 2026",
    boot: "0f9c-boot",
  });
  assert.deepEqual(markOwner("figma-reader"), { pid: 0 });
  for (const name of ["", "other-app:1", "figma-reader:x", "figma-reader-1", "figma-reader@boot"]) assert.equal(markOwner(name), undefined, name);
  assert.deepEqual(markOwner(TAB_MARK), { pid: process.pid, start: processStart(process.pid), boot: bootId() }, "our own mark round-trips");
});

test("a tab is free only when its owner is gone, including when the owner's pid was reused", async (t) => {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => child.kill());
  const pid = child.pid!;
  const start = processStart(pid);
  assert.equal(abandoned({ pid, start }), false, "the recorded process is still running");
  // Before, a pid-only mark kept this tab owned for as long as any process held the pid.
  assert.equal(abandoned({ pid, start: `${start}0` }), true, "same pid, different process");
  assert.equal(abandoned({ pid, start: undefined }), false, "a pid-only mark of a live pid cannot be told apart, so it stays owned");
  assert.equal(abandoned({ pid: 0 }), true, "legacy mark");
  // A profile that restores its session brings window.name back, and start times count ticks since boot: the very
  // same pair names an unrelated process after a reboot.
  assert.equal(abandoned({ pid, start, boot: bootId() }), false, "this boot");
  assert.equal(abandoned({ pid, start, boot: "0f9c-another-boot" }), bootId() !== undefined, "another boot");
  child.kill();
  await new Promise((r) => child.once("exit", r));
  assert.equal(abandoned({ pid, start }), true, "the owner exited");
});

test("a screenshot of a page does not bleed into the screenshot of a frame on it", async () => {
  // Measured before the fix: the page capture pressed Ctrl+A and left everything selected, Figma rewrote the
  // node-id in the address bar to the first selected node, and the next call reused the tab because the frame it
  // wanted was among that selection. The image returned rendered 1:2 + 1:3 + 1:4 and was labelled "node 1:2".
  loggedIn();
  const { tabs, world } = tabWorld({ editor: { pageIds: ["1:2", "1:3", "1:4"] } });
  const { web } = fakeBrowser(world);
  const page = await web.copyAsPng(KEY, "0:1", 4000, true);
  assert.deepEqual(idsOf(page), ["1:2", "1:3", "1:4"], "select-all captured the whole page");
  assert.deepEqual([...tabs.values()][0]!.selection, [], "and cleared that selection before leaving the tab");
  const frame = await web.copyAsPng(KEY, "1:2", 4000);
  assert.deepEqual(idsOf(frame), ["1:2"], "the frame capture is the frame alone");
  assert.equal(tabs.size, 1, "in the one editor tab this process owns");
});

test("a node capture takes the node asked for: not a different one, not one of several", async () => {
  loggedIn();
  // Selection lands asynchronously after the canvas is ready: Figma reports the previous one for a while.
  let polls = 0;
  const late = tabWorld({
    editor: { pageIds: [] },
    onNavigate: (t) => (t.selection = ["9:9"]),
    afterEvaluate: (t, expr) => {
      if (expr.includes("sceneGraphSelection") && ++polls === 3) t.selection = ["1:2"];
    },
  });
  await fakeBrowser(late.world).web.openFile(KEY, "1:2");
  assert.ok(polls >= 3, "it kept polling while another node was selected");

  const never = tabWorld({ editor: { pageIds: [] }, onNavigate: (t) => (t.selection = ["9:9"]) });
  await assert.rejects(fakeBrowser(never.world).web.openFile(KEY, "1:2"), (e: Error) => {
    assert.match(e.message, /Figma did not select node 1:2/);
    assert.match(e.message, /Figma selected 9:9 instead/);
    return true;
  });

  // The tab is shared: another process, or a user in an attached browser, can leave more than our node selected,
  // and the url still names it. Reusing the tab then fires Ctrl+Shift+C over all of it.
  const stale = tabWorld();
  const shared = fakeBrowser(stale.world);
  await shared.web.openFile(KEY, "1:2");
  const tab = [...stale.tabs.values()][0]!;
  tab.selection = ["1:2", "1:3"];
  await shared.web.openFile(KEY, "1:2");
  assert.deepEqual(tab.selection, ["1:2"], "the file was loaded again rather than reused with more selected");
});

test("a capture is downscaled to the size asked for, and never enlarged", async () => {
  loggedIn();
  const { world } = tabWorld({ editor: { pageIds: ["1:2"], width: 800, height: 400 } });
  const { web } = fakeBrowser(world);
  const small = await web.copyAsPng(KEY, "1:2", 200);
  assert.deepEqual([small.width, small.height], [200, 100]);
  assert.deepEqual([small.originalWidth, small.originalHeight], [800, 400], "the size Figma rendered is reported too");
  const big = await web.copyAsPng(KEY, "1:2", 4000);
  assert.deepEqual([big.width, big.height], [800, 400], "a limit above the image does not enlarge it");
  const silly = await web.copyAsPng(KEY, "1:2", 0);
  assert.deepEqual([silly.width, silly.height], [16, 8], "and a nonsense limit still yields an image");
});

test("a capture that never produces an image fails with what was checked, after a bounded number of attempts", async () => {
  // A file that restricts copying answers Ctrl+Shift+C with nothing at all. Without the attempt ceiling this
  // never returns, and the tool call hangs instead of saying why.
  loggedIn();
  const { tabs, world } = tabWorld({ editor: { pageIds: ["1:2"], copies: false } });
  const { web } = fakeBrowser(world, { timeScale: 0.005 });
  await assert.rejects(web.copyAsPng(KEY, "1:2", 400), (e: Error) => {
    assert.match(e.message, /Copy as PNG produced no image for node 1:2 after 2 attempt\(s\)/);
    assert.match(e.message, /Figma's selection was 1 node\(s\): 1:2/);
    return true;
  });
  assert.equal([...tabs.values()][0]!.keys.filter((k) => k === "ctrl+shift+KeyC").length, 2, "two attempts, not a loop");
});

test("the query reaches the Quick actions box or nothing at all", async () => {
  // The only check used to be "an empty INPUT has focus", which a layer rename field, a page-name field, a
  // comment composer and a plugin input all pass: 45 characters of the query were measured going into an
  // unrelated rename field, three times over, from a tool advertised as read-only.
  loggedIn();
  const rename = tabWorld({ editor: { box: "rename" } });
  const stubborn = fakeBrowser(rename.world, { dir: workDir() });
  await assert.rejects(stubborn.web.saveLocalCopy(KEY, join(root, "never.fig"), 500), /quick action "Save local copy" not available/);
  const t = [...rename.tabs.values()][0]!;
  assert.deepEqual(t.typed, [], "nothing was typed anywhere");
  assert.equal(t.dom.get('[data-testid="layer-name"]')!.value, "", "least of all into the field that had focus");
  assert.equal(t.keys.at(-1), "Escape", "and the menu was closed behind us");

  // The box that never opens is the case this check must not confuse with the one above: still nothing typed.
  const none = tabWorld({ editor: { box: "never" } });
  const quiet = fakeBrowser(none.world, { dir: workDir() });
  await assert.rejects(quiet.web.saveLocalCopy(KEY, join(root, "never.fig"), 500), /data-testid=save-as/);
  assert.deepEqual([...none.tabs.values()][0]!.typed, []);
});

test("any one of the three signals is enough to recognise the Quick actions box", async () => {
  // Figma's markup is the only evidence available, so the box is accepted on its placeholder or aria-label, on its
  // CSS-module class, or on a quick-action container around it - and the box it ships today carries two of those,
  // which is exactly what hides a typo in the other two. Figma renames one attribute and Save local copy stops
  // working, with the remaining fallbacks never having run.
  loggedIn();
  for (const signal of ["placeholder", "class", "testid"] as const) {
    const only = tabWorld({ editor: { boxSignals: [signal] } });
    const b = fakeBrowser(only.world, { dir: workDir() });
    // Nothing answers the click here, so the export times out - but only after the query reached the box and the
    // action ran, which is the failure being told apart from the box never being found at all.
    await assert.rejects(b.web.saveLocalCopy(KEY, join(root, `${signal}.fig`), 300), /Save local copy timeout/);
    const t = [...only.tabs.values()][0]!;
    assert.deepEqual(t.typed, ["Save local copy"], `the ${signal} signal alone was enough`);
    assert.equal(t.dom.get('[data-testid="layer-name"]')!.value, "", "and nothing went into the field beside it");
  }
});

test("Save local copy exports the download from our own frame, and cancels the other one it saw", async () => {
  loggedIn();
  const dir = workDir();
  const dest = join(dir, "out.fig");
  let cdp!: ReturnType<typeof fakeCdp>;
  const { tabs, world } = tabWorld({
    // The Comments panel swallows the first Ctrl+/ on files with comments, and the box takes a moment to open.
    editor: { swallowFirstSlash: true, boxOpensAfter: 3 },
    onClick: (t) => {
      cdp.emit("Browser.downloadWillBegin", { guid: "theirs", frameId: "frame-elsewhere", suggestedFilename: "Theirs.fig" });
      cdp.emit("Browser.downloadWillBegin", { guid: "ours", frameId: `frame-${t.id}`, suggestedFilename: "My App.fig" });
      writeFileSync(join(dir, "downloads", "ours"), "fig bytes");
      cdp.emit("Browser.downloadProgress", { guid: "ours", state: "completed" });
    },
  });
  const b = fakeBrowser(world, { dir });
  cdp = b.cdp;
  const other = takeLease(join(dir, "download-leases"), `${process.pid}-another-export`);
  assert.equal(await b.web.saveLocalCopy(KEY, dest, 500), dest);
  assert.equal(readFileSync(dest, "utf8"), "fig bytes", "the file that came from our frame, not the other one");
  assert.deepEqual(
    b.cdp.sent.filter((s) => s.method === "Browser.cancelDownload").map((s) => s.params.guid),
    ["theirs"],
    "and the one that was not ours is cancelled instead of left writing into the shared directory",
  );
  assert.equal([...tabs.values()][0]!.keys.filter((k) => k === "ctrl+Slash").length, 2, "the swallowed Ctrl+/ was retried");
  rmSync(other);
});

test("an export that is cancelled, or never reported for us, fails and leaves no download running", async () => {
  loggedIn();
  const cancelled = workDir();
  let a!: ReturnType<typeof fakeCdp>;
  const one = tabWorld({
    onClick: (t) => {
      a.emit("Browser.downloadWillBegin", { guid: "ours", frameId: `frame-${t.id}`, suggestedFilename: "My App.fig" });
      a.emit("Browser.downloadProgress", { guid: "ours", state: "canceled" });
    },
  });
  const first = fakeBrowser(one.world, { dir: cancelled });
  a = first.cdp;
  await assert.rejects(first.web.saveLocalCopy(KEY, join(cancelled, "out.fig"), 500), /Save local copy canceled/);
  assert.ok(!existsSync(join(cancelled, "out.fig")), "a cancelled download is not a snapshot");

  // Another export holds a lease, so a download reported on a frame that is not ours may be someone else's: it is
  // not adopted - but it is cancelled, which is what used to be skipped entirely (measured: nothing was sent).
  // It runs to completion here because that is when adopting it does the damage: the other process's file would be
  // renamed onto our key's cache path, serving a different design under our name and leaving its export waiting.
  const foreign = workDir();
  let bcdp!: ReturnType<typeof fakeCdp>;
  const two = tabWorld({
    onClick: () => {
      bcdp.emit("Browser.downloadWillBegin", { guid: "theirs", frameId: "frame-elsewhere", suggestedFilename: "Theirs.fig" });
      writeFileSync(join(foreign, "downloads", "theirs"), "their fig bytes");
      bcdp.emit("Browser.downloadProgress", { guid: "theirs", state: "completed" });
    },
  });
  const second = fakeBrowser(two.world, { dir: foreign });
  bcdp = second.cdp;
  const held = takeLease(join(foreign, "download-leases"), `${process.pid}-another-export`);
  await assert.rejects(second.web.saveLocalCopy(KEY, join(foreign, "out.fig"), 300), /Save local copy timeout/);
  assert.ok(!existsSync(join(foreign, "out.fig")), "another process's download is not this export's snapshot");
  assert.deepEqual(
    second.cdp.sent.filter((s) => s.method === "Browser.cancelDownload").map((s) => s.params.guid),
    ["theirs"],
  );
  rmSync(held);
});

test("a download Figma reports on another frame is still ours when no other export is running", async () => {
  // Figma has exported from a frame of its own on some builds. That download was ignored: it kept writing into
  // the shared directory while this export waited out its whole 600 s for an event naming our frame.
  loggedIn();
  const dir = workDir();
  const dest = join(dir, "out.fig");
  let cdp!: ReturnType<typeof fakeCdp>;
  const { world } = tabWorld({
    onClick: () => {
      cdp.emit("Browser.downloadWillBegin", { guid: "iframe", frameId: "frame-elsewhere", suggestedFilename: "My App.fig" });
      writeFileSync(join(dir, "downloads", "iframe"), "fig bytes");
      cdp.emit("Browser.downloadProgress", { guid: "iframe", state: "completed" });
    },
  });
  const b = fakeBrowser(world, { dir });
  cdp = b.cdp;
  assert.equal(await b.web.saveLocalCopy(KEY, dest, 500), dest);
  assert.equal(readFileSync(dest, "utf8"), "fig bytes");
});
