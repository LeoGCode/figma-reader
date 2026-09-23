// The read-only Figma tools shared by the MCP server (mcp.ts) and the CLI (cli.ts). No Figma plugin and no API token:
// data comes from local .fig files or the logged-in figma.com web app over CDP, via "Save local copy" (.fig, decoded
// locally) and "Copy as PNG" (captured in-page).
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { accountCacheDir, accountProfileDir, expandHome, resolveAccount, writeAccountInfo } from "./account.ts";
import { BrowserManager, defaultExecutable, defaultStateDir } from "./browser.ts";
import { componentUsage, componentUses } from "./component-usage.ts";
import type { Raw } from "./fig-file.ts";
import { cleanStaleDownloads, FigmaWeb, parseFileRef } from "./figma-web.ts";
import { groupUnresolved, scanText } from "./instance-text.ts";
import { imageExt, localFigFiles } from "./local-files.ts";
import { bytesHex, displayType, Normalizer } from "./normalize.ts";
import { outline } from "./outline.ts";
import { searchPattern } from "./search-query.ts";
import { SnapshotStore } from "./store.ts";
import { tokenUsage } from "./token-usage.ts";
import { extractStyles, extractVariables, stylesToCss, variablesToCss, variablesToDtcg } from "./tokens.ts";

/** Spellings of the loopback address: a browser listening on it is reached by every one of them. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A path as the filesystem knows it. realpathSync alone cannot be used: a profile directory does not exist until the
 * browser first starts there, and realpathSync throws on a path that is not there yet. So the deepest part that does
 * exist is resolved and the rest kept as written.
 */
function realPath(p: string): string {
  const abs = resolve(p);
  const rest: string[] = [];
  for (let dir = abs; ; ) {
    try {
      return join(realpathSync(dir), ...rest);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return abs;
      rest.unshift(basename(dir));
      dir = parent;
    }
  }
}

/**
 * One browser, one key. The download directory and the leases beside it are shared by every process on a browser, so
 * two spellings of one browser are two lease directories that cannot see each other: the holder of the other one
 * hands the browser-wide download behaviour back while this process is mid-download, whose .fig then lands in the
 * browser's default directory and is waited for until the 600 s timeout. "http://localhost:9222" and
 * "http://127.0.0.1:9222/" hashed to different keys, and so did a profile reached through a symlink.
 */
function browserKey(cdpUrl: string | undefined, userDataDir: string): string {
  if (!cdpUrl) return realPath(userDataDir);
  try {
    const u = new URL(cdpUrl);
    const host = u.hostname.toLowerCase();
    return `${LOOPBACK.has(host) ? "127.0.0.1" : host}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    // Not a URL: nothing to canonicalise, and the raw spelling is still one key, as it was for every endpoint before.
    return cdpUrl;
  }
}

export const account = resolveAccount();
// path.delimiter, because a split on ':' cuts "C:\designs" into "C" and "\designs" on Windows: neither is a
// directory, so a configured one was never searched and list-files answered that there are no local files at all.
const localDirs = process.env.FIGMA_FILES_DIRS
  ? process.env.FIGMA_FILES_DIRS.split(delimiter).filter(Boolean).map(expandHome)
  : (account.config?.filesDirs ?? [join(homedir(), "Downloads")]);
// Snapshots are per account: a file exported with one login must not be served to a project using another. A profile
// or browser given directly, with no account named, gets a cache of its own keyed by that profile or endpoint.
const customProfile = process.env.FIGMA_CDP_URL || process.env.FIGMA_USER_DATA_DIR;
const cacheName = customProfile && account.source === "default"
  ? `custom-${createHash("sha1").update(process.env.FIGMA_CDP_URL || expandHome(customProfile)).digest("hex").slice(0, 10)}`
  : account.name;
const cacheDir = accountCacheDir(cacheName);
let executablePath = process.env.FIGMA_BROWSER_PATH ? expandHome(process.env.FIGMA_BROWSER_PATH) : undefined;
if (!executablePath && !process.env.FIGMA_CDP_URL) {
  try {
    executablePath = defaultExecutable();
  } catch {}
}
const browser = new BrowserManager({
  cdpUrl: process.env.FIGMA_CDP_URL || undefined,
  executablePath,
  userDataDir: process.env.FIGMA_USER_DATA_DIR
    ? expandHome(process.env.FIGMA_USER_DATA_DIR)
    : accountProfileDir(account.name, executablePath ?? "chromium"),
  headless: !/^(0|false|no)$/i.test(process.env.FIGMA_HEADLESS ?? "1"),
  stateDir: defaultStateDir(),
});
// Where the browser puts a "Save local copy" download. The setting is browser-wide, so every process on one browser
// has to name the same directory; the cache cannot name it, since FIGMA_READER_CACHE moves per process and whoever
// armed it second sent the other's download somewhere it was never waited for. The profile is what they share (the
// CDP endpoint when the browser is someone else's), and it lives beside the other state we keep about that browser.
const downloadDir = join(
  defaultStateDir(),
  "downloads",
  createHash("sha1").update(browserKey(process.env.FIGMA_CDP_URL || undefined, browser.opts.userDataDir)).digest("hex").slice(0, 10),
);
const web = new FigmaWeb(browser, downloadDir);

const DEFAULT_MAX_AGE_MIN = 30;
/**
 * How old a snapshot may be before it is exported again. A value that is not a number used to become NaN, and
 * "age < NaN" is false for every snapshot: a "30m" typo turned every single tool call into a full browser export
 * (up to a minute each), with nothing said anywhere.
 */
function snapshotMaxAgeMin(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_AGE_MIN;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0) {
    process.stderr.write(`figma-reader: FIGMA_SNAPSHOT_MAX_AGE_MIN=${JSON.stringify(raw)} is not a number of minutes; using ${DEFAULT_MAX_AGE_MIN}\n`);
    return DEFAULT_MAX_AGE_MIN;
  }
  return n;
}
const store = new SnapshotStore(web, cacheDir, snapshotMaxAgeMin(process.env.FIGMA_SNAPSHOT_MAX_AGE_MIN) * 60_000);
cleanStaleDownloads(web.downloadDir);
// Downloads landed under the cache until they were named after the profile, so an upgrade leaves some there.
cleanStaleDownloads(cacheDir);

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
  content: Content[];
  isError?: boolean;
}
export interface Tool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  /**
   * Whether this tool changes nothing outside our own caches, which mcp.ts publishes as readOnlyHint: an MCP client
   * uses that hint to run a tool without asking the user, so a tool that writes a path the caller chose must not
   * carry it. See WRITES_PATH and WRITES_STATE.
   */
  readOnly: boolean;
  run: (args: any) => Promise<ToolResult>;
}
export const tools: Tool[] = [];

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 1));

/**
 * Write where the caller said, and answer with the absolute path so the result says where it landed. The path is not
 * fenced to the working directory: an MCP server is started wherever the client happens to start it (often "/"), and
 * "write the tokens into my project" is the point of out_file. What keeps it from being written unasked is that the
 * tools taking such a path publish readOnlyHint: false, so the client asks the user rather than auto-approving.
 */
function writeOut(path: string, content: string | Uint8Array) {
  const abs = resolve(path.replace(/^~(?=\/)/, homedir()));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

const fileArg = z
  .string()
  .describe(
    "Path to a local .fig file, or a Figma file key / figma.com/design/... URL. A node-id in the URL is used when this " +
      "tool takes node_id and it is omitted; a tool that answers about the whole file ignores it. " +
      "A key or URL uses a local '<name> [<key>].fig' from FIGMA_FILES_DIRS when one exists, otherwise exports through the browser.",
  );
/**
 * figma_screenshot never reads a local .fig for the image: it renders the live file in the browser, and reads a local
 * copy only to recognise a page id, which cannot be selected. fileArg promising it would be used was wrong there.
 */
const screenshotFileArg = z
  .string()
  .describe(
    "A Figma file key or figma.com/design/... URL (a node-id in the URL is used when node_id is omitted). The image always " +
      "comes from the live file in the browser, so a local .fig path works only if its name carries the key " +
      "('<name> [<key>].fig'), and is read only to tell whether node_id is a page.",
  );
const refreshArg = z
  .boolean()
  .optional()
  .describe(
    "Skip local/cached copies and export the live file through the browser. Has no effect when file is a path to a .fig: " +
      "that file is read as it is on disk and the result carries refreshIgnored; pass the key or URL to export the live file instead.",
  );
/**
 * Said in the description of every tool whose result is dated. A snapshot answers for the file as it was, and a
 * reader who is only told the answer is "fresh" cannot tell one taken before their last edit from an invention: the
 * time can be quoted, and is the one thing that makes the difference visible. The two names are not the same claim:
 * see open(), where a copied file's time is only when the copy was written.
 */
const EXPORTED_AT_NOTE =
  "The result is dated by the copy it answers from. exportedAt is the ISO-8601 time this tool exported that snapshot " +
  "through the browser: report what the design said then rather than as current, and pass refresh to export it again. " +
  "For a local .fig the field is fileModifiedAt, that copy's own file time, which copying, syncing or re-downloading " +
  "the file resets: the design data can be older than it says, and nothing here can date it.";
/** Missing components listed by figma_get_text; the rest are counted, never dropped silently. */
const MAX_UNRESOLVED_GROUPS = 20;

const PREVIEW_CHARS = 120;
/**
 * A search hit's text, cut to a length that keeps the result readable. The cut is marked: `truncated` next to it
 * counts results, not characters, so a string cut mid-word sat next to truncated: false and was quoted as the whole
 * text. figma_get_text and figma_get_node return the string itself.
 */
function preview(s: string | undefined) {
  if (s === undefined || s.length <= PREVIEW_CHARS) return { characters: s };
  return { characters: `${s.slice(0, PREVIEW_CHARS)}...`, charactersTruncated: true };
}

/** Newest local .fig whose name carries this file key. */
function localFileForKey(key: string): string | undefined {
  return localFigFiles(localDirs).find((f) => f.key === key)?.path;
}

async function open(file: string, refresh?: boolean) {
  const ref = parseFileRef(file);
  const path = ref.path ?? (refresh ? undefined : localFileForKey(ref.key));
  const doc = path ? await store.getLocal(path) : await store.get(ref.key, refresh);
  const key = ref.path ? (ref.keyInName ? ref.key : undefined) : ref.key;
  const source = path ? "local" : "web";
  // A .fig carries no export time of its own, only its file time, and what that time means depends on who wrote the
  // file. For a snapshot we exported it is the export; for a file the user supplied it is when that copy was last
  // written, which cp, rsync, unzip, a Drive sync, a re-download and git clone all reset - test/files/real-export.fig
  // holds data from 12:38 and reported "exported 15 minutes ago" because cloning rewrote its mtime. So the two are
  // reported under different names, and only ours is dated as an export.
  const dated: Raw = source === "web" ? { exportedAt: doc.exportedAt.toISOString() } : { fileModifiedAt: doc.exportedAt.toISOString() };
  // A path is read as it is on disk; there is nothing to export it from. Saying so on the result is the only way a
  // caller that explicitly asked for live data learns that it did not get it.
  if (refresh && ref.path) dated.refreshIgnored = true;
  return { doc, dated, urlNodeId: ref.nodeId, source, key, path };
}

/** Arguments that name a file or directory the tool then writes, through writeOut: anywhere the caller says. */
const WRITES_PATH = ["out_file", "out_dir", "save_path"];
/**
 * Tools that write outside our caches without being given a path: figma_status records who an account's profile is
 * logged in as (account.json in the account's data directory, via verified()), and figma_login opens a
 * real browser window and signs the profile in. Exporting a snapshot into the cache is our own bookkeeping and stays
 * read-only; openWorldHint, published for every tool, is what says a call may reach figma.com.
 */
const WRITES_STATE = new Set(["figma_status", "figma_login"]);

function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (a: z.infer<z.ZodObject<S>>) => Promise<ToolResult>) {
  const readOnly = !WRITES_STATE.has(name) && !WRITES_PATH.some((k) => k in shape);
  tools.push({ name, description, shape, readOnly, run });
}

/** Which account this process serves and why; the account is fixed for the life of the process. */
const accountSummary = () => ({
  account: account.name,
  accountSource: account.source === "env" ? "FIGMA_ACCOUNT" : account.source === "project" ? account.config!.path : "default",
  ...(customProfile && !process.env.FIGMA_CDP_URL ? { profileOverride: "FIGMA_USER_DATA_DIR" } : {}),
});

/** Remember who an account's own profile is logged in as, for `figma-reader accounts`. */
function verified<T extends { email: string; handle: string } | null>(user: T): T {
  if (user && !customProfile) writeAccountInfo(account.name, user);
  return user;
}

tool(
  "figma_status",
  "Account, browser and login state. Does not launch anything: local .fig paths never need the browser.",
  {},
  async () => {
    const rec = browser.launchRecord();
    if (rec?.purpose === "login") {
      return json({ ...accountSummary(), mode: "managed", loginWindowOpen: true, loginCookieSeen: browser.loginCookiePresent(), pid: rec.pid, profile: browser.opts.userDataDir });
    }
    const base = {
      ...accountSummary(),
      mode: browser.managed ? "managed" : "attached",
      cdp: browser.managed ? undefined : browser.opts.cdpUrl,
      executable: browser.managed ? await browser.executable().catch((e) => String(e)) : undefined,
      profile: browser.managed ? browser.opts.userDataDir : undefined,
      running: rec ? { pid: rec.pid, headless: rec.headless, purpose: rec.purpose } : undefined,
      localDirs,
      cacheDir,
      // Named after the profile, not the cache: every process on this browser must agree on it (see above).
      downloadDir: web.downloadDir,
    };
    if (browser.managed && !rec) {
      return json({ ...base, loginCookieSeen: browser.loginCookiePresent(), browser: "not running (starts on first web call)" });
    }
    // whoami throws when Figma cannot be asked (network, 5xx, browser); status reports that instead of failing,
    // since "not logged in" would be a guess.
    try {
      const user = verified(await web.whoami());
      return json({ ...base, loggedIn: !!user, user });
    } catch (e) {
      return json({ ...base, loggedIn: "unknown", error: (e as Error).message });
    }
  },
);

tool(
  "figma_login",
  "Ensure this project's account is logged into figma.com. If not, opens a normal (not remote-controlled) browser window on the " +
    "login page; after the user logs in the window closes by itself and work continues headless. wait_seconds blocks until then.",
  { wait_seconds: z.number().int().min(0).max(1800).optional() },
  async ({ wait_seconds }) => {
    const who = `account "${account.name}"`;
    const user = browser.launchRecord()?.purpose === "login" ? null : verified(await web.whoami());
    if (user) return json({ ...accountSummary(), loggedIn: true, user });
    await web.openLogin();
    if (!wait_seconds) return text(`Login window opened for ${who}. Log into figma.com there; the next Figma call closes it and continues headless.`);
    const done = verified(await web.waitForLogin(wait_seconds));
    if (done) return json({ ...accountSummary(), loggedIn: true, user: done });
    return text(
      browser.launchRecord()?.purpose === "login"
        ? `${who} is not logged in after ${wait_seconds}s; the login window stays open.`
        : `${who} is still not logged in; a new login window was opened.`,
    );
  },
);

tool(
  "figma_list_files",
  "List Figma files. source=local (default): .fig files under FIGMA_FILES_DIRS, which the result names in searchedDirs. " +
    "source=web: recently viewed files of the account logged in the browser. With query, totalUnfiltered says how many " +
    "files there were before it.",
  {
    source: z.enum(["local", "web"]).optional(),
    query: z.string().optional().describe("Case-insensitive filter on file name"),
    limit: z.number().int().positive().optional().describe("Default 30"),
  },
  async ({ source, query, limit }) => {
    const all: Raw[] = source === "web" ? await web.recentFiles() : localFigFiles(localDirs);
    const files = query ? all.filter((f) => f.name.toLowerCase().includes(query.toLowerCase())) : all;
    const max = limit ?? 30;
    // An empty answer used to be an English sentence, which a client parsing this schema's JSON threw on. The two
    // things that sentence said are fields instead: where the files were looked for, and how many the query left out.
    return json({
      returned: Math.min(files.length, max),
      total: files.length,
      truncated: files.length > max,
      ...(query ? { totalUnfiltered: all.length } : {}),
      ...(source === "web" ? {} : { searchedDirs: localDirs }),
      files: files.slice(0, max),
    });
  },
);

tool(
  "figma_load_file",
  "Export (Save local copy) and decode a Figma file, returning a summary: pages, node counts, variable collections, styles, components. " +
    "Snapshots are cached; other tools reuse them. Export of large files can take a minute. " +
    EXPORTED_AT_NOTE,
  { file: fileArg, refresh: refreshArg },
  async ({ file, refresh }) => {
    const { doc, dated, source, key, path } = await open(file, refresh);
    const counts: Record<string, number> = {};
    for (const n of doc.nodes.values()) counts[displayType(n)] = (counts[displayType(n)] ?? 0) + 1;
    const collections = extractVariables(doc);
    const styles = extractStyles(doc);
    const styleCounts: Record<string, number> = {};
    for (const s of styles) styleCounts[s.type] = (styleCounts[s.type] ?? 0) + 1;
    return json({
      name: doc.meta.file_name ?? basename(doc.fileKey, ".fig"),
      key,
      source,
      path,
      ...dated,
      // Only for a snapshot we took: for a file the user supplied, the age of the copy is not the age of the design.
      ...(source === "web" ? { snapshotAgeMinutes: Math.round((Date.now() - doc.exportedAt.getTime()) / 60_000) } : {}),
      pages: doc.pages().map((p) => ({ id: p.id, name: p.name, topLevelNodes: p.childIds.length })),
      nodeCounts: counts,
      variableCollections: collections.map((c) => ({ name: c.name, modes: c.modes.map((m) => m.name), variables: c.variables.length, remote: c.remote })),
      styles: styleCounts,
      components: [...doc.nodes.values()].filter((n) => n.type === "SYMBOL").length,
      imageFills: doc.images.size,
    });
  },
);

tool(
  "figma_get_tree",
  "Compact outline of the layer tree (id, type, name, size, hints). Omit node_id for all pages.",
  {
    file: fileArg,
    node_id: z.string().optional().describe("Start node id like 12:34 (or 12-34)"),
    depth: z.number().int().min(0).optional().describe(
      "Levels of children below the start node (default 2). With no node_id the start is the document, whose pages are " +
        "level 0, so the default shows three: pages, their top-level layers, and one level under those",
    ),
    max_nodes: z.number().int().positive().optional().describe("Default 400"),
    refresh: refreshArg,
  },
  async ({ file, node_id, depth, max_nodes, refresh }) => {
    const { doc, urlNodeId } = await open(file, refresh);
    const id = node_id ?? urlNodeId;
    const start = id ? doc.require(id) : doc.get(doc.rootId)!;
    return text(outline(doc, start, depth ?? 2, max_nodes ?? 400));
  },
);

tool(
  "figma_get_node",
  "Detailed design data for a node and its subtree: geometry, fills/strokes/effects (hex), auto-layout, text styling and runs, " +
    "component/instance info, bound variables and style names. Instances are not expanded (see mainComponentId). " +
    EXPORTED_AT_NOTE,
  {
    file: fileArg,
    node_id: z.string().optional(),
    depth: z.number().int().min(0).optional().describe("Child levels to include (default 3)"),
    refresh: refreshArg,
  },
  async ({ file, node_id, depth, refresh }) => {
    const { doc, dated, urlNodeId } = await open(file, refresh);
    const id = node_id ?? urlNodeId;
    if (!id) throw new Error("node_id required");
    const n = doc.require(id);
    const parent = n.parentId ? doc.get(n.parentId) : undefined;
    const data = new Normalizer(doc).node(n, depth ?? 3, parent);
    const out = JSON.stringify({ ...dated, page: doc.pageOf(n)?.name, path: doc.path(n), ...data }, null, 1);
    if (out.length > 200_000) throw new Error(`result is ${Math.round(out.length / 1000)}KB; use a smaller depth or a deeper node_id`);
    return text(out);
  },
);

tool(
  "figma_search",
  "Find nodes by name (and optionally text content). The query is a literal substring, case-insensitive unless case_sensitive: " +
    "a name like Icons/Arrow/Left or /Card [v2]/ matches itself. Only regex=true reads it as a pattern, bare or /pattern/flags, " +
    "and an invalid pattern is an error. " +
    "With include_text, component instances are expanded, so strings that only exist as instance overrides or component " +
    "property values are matched too, each tagged with via (direct/instance) and, where they apply, component, variant and " +
    "frame. Name matching sees only real layers: layer names inside a collapsed instance live in its main component, so " +
    "search that component instead. " +
    "A hit's characters is a preview: longer text is cut to its first 120 characters followed by ... and flagged " +
    "charactersTruncated (truncated, next to it, is about the number of results); figma_get_text returns the strings whole. " +
    "When the text pass runs, unresolvedInstances counts the instances whose text could not be resolved and so was not " +
    "searched (figma_get_text names the components); it is absent when the pass did not run. " +
    EXPORTED_AT_NOTE,
  {
    file: fileArg,
    query: z.string().describe("Name or text to find. A literal substring unless regex is set, so slashes and characters like [ ] ( ) . * match themselves"),
    regex: z.boolean().optional().describe("Read the query as a regex, bare or /pattern/flags, and report an invalid one. Default false: the query is a literal substring however it is written"),
    case_sensitive: z.boolean().optional().describe("Match case (default false, for a regex too)"),
    types: z.array(z.string()).optional().describe(
      "Node types to match, e.g. FRAME, COMPONENT, INSTANCE, TEXT. A list without TEXT also turns include_text off, since " +
        "every text hit is a TEXT node; an empty list is no filter at all",
    ),
    include_text: z.boolean().optional().describe("Also match text content, including text rendered inside instances"),
    node_id: z.string().optional().describe("Search only this node and everything under it, like 12:34 (or 12-34); a node-id in the file URL is used when it is omitted"),
    page: z.string().optional().describe("Restrict to page name"),
    include_hidden: z.boolean().optional().describe("Include text on layers hidden in the design (default false)"),
    limit: z.number().int().positive().optional().describe("Default 50"),
    refresh: refreshArg,
  },
  async ({ file, query, regex, case_sensitive, types, include_text, node_id, page, include_hidden, limit, refresh }) => {
    const { doc, dated, urlNodeId } = await open(file, refresh);
    // fileArg promises a node-id in the URL is used when node_id is omitted; search used to ignore it, so pasting a
    // frame's URL searched the whole file and said nothing about it.
    const scopeId = node_id ?? urlNodeId;
    const scope = scopeId ? doc.require(scopeId) : undefined;
    const scopePage = scope && doc.pageOf(scope);
    const { re, as } = searchPattern(query, { regex, caseSensitive: case_sensitive });
    // An empty list means no filter: as a filter it would match nothing.
    const typeSet = types?.length ? new Set(types.map((t) => t.toUpperCase())) : undefined;
    if (page && !doc.pages().some((p) => p.name === page)) {
      throw new Error(`no page named ${JSON.stringify(page)}; pages: ${doc.pages().map((p) => JSON.stringify(p.name)).join(", ")}`);
    }
    const max = limit ?? 50;
    const results: Raw[] = [];
    const seen = new Map<string, Raw>();
    let total = 0;
    let unresolvedInstances = 0;
    /** Whether the text pass ran at all, which decides whether unresolvedInstances is a count or a guess. */
    let textScanned = false;
    const add = (id: string, r: Raw) => {
      const first = seen.get(id);
      // One node found twice is one hit, and each pass knows something the other does not: the name pass has the
      // node's own size, the text pass has where the text renders (via/component/variant/frame), which the
      // description promises for every include_text hit. Dropping the second made the same node come back in two
      // different shapes depending on whether its name happened to match too.
      if (first) {
        for (const [k, v] of Object.entries(r)) if (v !== undefined && first[k] === undefined) first[k] = v;
        return;
      }
      seen.set(id, r);
      total++;
      if (results.length < max) results.push(r);
    };
    for (const p of doc.pages()) {
      if (page && p.name !== page) continue;
      if (scope && p !== scopePage) continue;
      for (const n of doc.walk(scope ?? p)) {
        if (n === p) continue;
        if (typeSet && !typeSet.has(displayType(n))) continue;
        if (!re.test(n.name)) continue;
        add(n.id, {
          id: n.id, type: displayType(n), name: n.name, page: p.name,
          ...(n.type === "TEXT" ? preview(n.textData?.characters) : {}),
          ...(n.size ? { size: `${Math.round(n.size.x)}x${Math.round(n.size.y)}` } : {}),
        });
      }
      // Text content is matched on the resolved text, so instance overrides and component
      // property values are searchable and every hit carries where it renders.
      if (!include_text || (typeSet && !typeSet.has("TEXT"))) continue;
      textScanned = true;
      const scan = scanText(doc, [scope ?? p], include_hidden ?? false);
      unresolvedInstances += scan.unresolved.length;
      for (const t of scan.items) {
        if (!re.test(t.text)) continue;
        add(t.id, {
          id: t.id, type: "TEXT", name: t.name, page: p.name,
          ...preview(t.text),
          via: t.via, component: t.component, variant: t.variant, frame: t.frame,
        });
      }
    }
    return json({
      ...dated,
      queryAs: as,
      ...(scope ? { searchedNode: scope.id } : {}),
      returned: results.length,
      total,
      truncated: total > results.length,
      // Only when the text pass ran: types without TEXT skips it, and reporting 0 there was a positive claim that no
      // text was missing, made about text nobody looked at.
      ...(textScanned ? { unresolvedInstances } : {}),
      results,
    });
  },
);

tool(
  "figma_get_variables",
  "Design variables (tokens) with collections, modes, per-mode values and resolved aliases. Works on any plan (no Enterprise REST API). " +
    "Formats: json (default), css (custom properties, extra modes as [data-collection=mode]), dtcg (W3C design tokens). " +
    "A file that defines none answers empty in that format; figma_token_usage derives tokens from the raw values instead, " +
    "and figma_get_styles reads the styles.",
  {
    file: fileArg,
    format: z.enum(["json", "css", "dtcg"]).optional(),
    collection: z.string().optional().describe("Only this collection name; a name no collection in the file has is an error listing the ones it has"),
    include_remote: z.boolean().optional().describe("Include library variables copied into the file (default true)"),
    css_prefix: z.string().optional(),
    out_file: z.string().optional().describe("Also write the result to this path"),
    refresh: refreshArg,
  },
  async ({ file, format, collection, include_remote, css_prefix, out_file, refresh }) => {
    const { doc } = await open(file, refresh);
    // Filters pick what is written; names and alias references are still computed over every collection.
    const all = extractVariables(doc);
    // A collection name that matches nothing is a typo, not an answer. It used to be reported as "No variables found
    // in this file", which sent an agent away from a file full of them; figma_search names the pages the same way.
    if (collection && !all.some((c) => c.name === collection)) {
      throw new Error(
        all.length
          ? `no collection named ${JSON.stringify(collection)}; collections: ${all.map((c) => JSON.stringify(c.name)).join(", ")}`
          : `no collection named ${JSON.stringify(collection)}: this file defines no variables`,
      );
    }
    const include = (c: { name: string; remote: boolean }) => ((include_remote ?? true) || !c.remote) && (!collection || c.name === collection);
    const cols = all.filter(include);
    // A file with no variables answers in the format that was asked for (an empty list, object or stylesheet): the
    // English sentence that used to stand here threw a SyntaxError in any client that parsed the promised JSON.
    const body =
      format === "css" ? variablesToCss(all, css_prefix ?? "", include)
      : format === "dtcg" ? JSON.stringify(variablesToDtcg(all, include), null, 2)
      : JSON.stringify(cols, null, 1);
    const saved = out_file ? `\n\n(written to ${writeOut(out_file, body)})` : "";
    return text(body + saved);
  },
);

tool(
  "figma_get_styles",
  "Local (and imported library) styles with their values: FILL (color), STROKE, TEXT, EFFECT and GRID. " +
    "Formats: json (default) or css. A file with no styles, or none of the type asked for, answers empty in that format.",
  {
    file: fileArg,
    // STROKE was missing, so --type STROKE was a usage error for a kind of style this tool returns, counts in
    // figma_load_file and exports to CSS.
    type: z.enum(["FILL", "STROKE", "TEXT", "EFFECT", "GRID"]).optional().describe("Only styles of this type"),
    format: z.enum(["json", "css"]).optional(),
    css_prefix: z.string().optional(),
    out_file: z.string().optional().describe("Also write the result to this path"),
    refresh: refreshArg,
  },
  async ({ file, type, format, css_prefix, out_file, refresh }) => {
    const { doc } = await open(file, refresh);
    let styles = extractStyles(doc);
    if (type) styles = styles.filter((s) => s.type === type);
    // Empty in the format that was asked for, as in figma_get_variables: a sentence is not JSON and not CSS.
    const body = format === "css" ? stylesToCss(styles, css_prefix ?? "") : JSON.stringify(styles, null, 1);
    const saved = out_file ? `\n\n(written to ${writeOut(out_file, body)})` : "";
    return text(body + saved);
  },
);

tool(
  "figma_get_components",
  "The components this file defines, and the library components it uses. componentSets are the variant sets, with their " +
    "description, property definitions and one entry per variant carrying that variant's counts; components are the ones " +
    "outside a set, each with a size and its own counts. A count is instances placed directly, plus swapInstances where the " +
    "component is swapped into an instance (by an override or an instance-swap property). libraryComponentsUsed is a third " +
    "list: components defined in other files, by name, with the variants used and the same two counts. Internal-only pages " +
    "are left out of all three lists but not out of the counts: an instance placed on one still counts for the component it " +
    "is of, except for a library component, whose uses on such a page are skipped. " +
    EXPORTED_AT_NOTE,
  {
    file: fileArg,
    query: z.string().optional().describe("Case-insensitive filter on name; a component set matches when the set or any of its variants does"),
    refresh: refreshArg,
  },
  async ({ file, query, refresh }) => {
    const { doc, dated } = await open(file, refresh);
    const norm = new Normalizer(doc);
    const usage = componentUsage(doc);
    const counts = (id: string) => usage.get(id) ?? { instances: 0, swapInstances: 0 };
    const q = query?.toLowerCase();
    const sets: Raw[] = [];
    const singles: Raw[] = [];
    for (const n of doc.nodes.values()) {
      const page = doc.pageOf(n);
      if (!page || page.internalOnly) continue;
      if (n.isStateGroup) {
        const variants = doc.children(n).filter((c) => c.type === "SYMBOL");
        if (q && !n.name.toLowerCase().includes(q) && !variants.some((v) => v.name.toLowerCase().includes(q))) continue;
        sets.push({
          id: n.id, name: n.name, page: page.name, ...norm.component(n),
          variants: variants.map((v) => ({ id: v.id, name: v.name, ...counts(v.id) })),
        });
      } else if (n.type === "SYMBOL" && !(n.parentId && doc.get(n.parentId)?.isStateGroup)) {
        if (q && !n.name.toLowerCase().includes(q)) continue;
        singles.push({
          id: n.id, name: n.name, page: page.name, size: `${Math.round(n.size?.x ?? 0)}x${Math.round(n.size?.y ?? 0)}`,
          ...norm.component(n), ...counts(n.id),
        });
      }
    }
    const remote = new Map<string, Raw>();
    for (const { instance, component: main, swap } of componentUses(doc)) {
      if (!main.sourceLibraryKey || doc.pageOf(instance)?.internalOnly) continue;
      const set = main.parentId ? doc.get(main.parentId) : undefined;
      const name = set?.isStateGroup ? set.name : main.name;
      if (q && !name.toLowerCase().includes(q)) continue;
      const e = remote.get(name) ?? { name, componentKey: set?.isStateGroup ? set.key : main.componentKey, variantsUsed: new Set<string>(), instances: 0, swapInstances: 0 };
      if (set?.isStateGroup) e.variantsUsed.add(main.name);
      if (swap) e.swapInstances++;
      else e.instances++;
      remote.set(name, e);
    }
    const libraryComponentsUsed = [...remote.values()]
      .map((e): Raw => ({ ...e, variantsUsed: e.variantsUsed.size ? [...e.variantsUsed] : undefined }))
      .sort((a, b) => b.instances + b.swapInstances - (a.instances + a.swapInstances));
    return json({ ...dated, componentSets: sets, components: singles, libraryComponentsUsed });
  },
);

tool(
  "figma_token_usage",
  "Scan a subtree (or whole file) and aggregate the raw design values actually used: colors, typography combos, corner radii, " +
    "auto-layout gaps/paddings, stroke widths, effects, each with counts and the variable/style bound where present. " +
    "Useful to derive a token set from files that do not define variables or styles. A typography entry carries only the " +
    "properties the file records, and always at least one: text that records none of them is counted in " +
    "textWithoutTypography instead, so it is accounted for without standing in the list as an entry naming no value. " +
    EXPORTED_AT_NOTE,
  {
    file: fileArg,
    node_id: z.string().optional(),
    include_hidden: z.boolean().optional(),
    min_count: z.number().int().positive().optional().describe("Drop values used fewer times (default 1)"),
    refresh: refreshArg,
  },
  async ({ file, node_id, include_hidden, min_count, refresh }) => {
    const { doc, dated, urlNodeId } = await open(file, refresh);
    const id = node_id ?? urlNodeId;
    return json({ ...dated, ...tokenUsage(doc, id ? [doc.require(id)] : doc.pages(), { includeHidden: include_hidden, minCount: min_count }) });
  },
);

tool(
  "figma_get_text",
  "All text content under a node (or the whole file) in reading order, with node ids. Component instances are expanded, so " +
    "strings that only exist as instance overrides or component property values are included, each tagged with via " +
    "(direct/instance) and, where they apply, its component, variant and enclosing frame. A field that does not apply is " +
    "absent: text on the canvas has no component. Hidden layers are excluded unless include_hidden. " +
    "The result always reports total/truncated/unresolvedInstances: a non-zero unresolvedInstances means text is missing, " +
    "at that many places; unresolved lists each missing component once, with its count and some of those places, the most " +
    "common first, and unresolvedComponentsOmitted counts the components past that listing. " +
    EXPORTED_AT_NOTE,
  {
    file: fileArg,
    node_id: z.string().optional(),
    limit: z.number().int().positive().optional().describe("Default 500"),
    include_hidden: z.boolean().optional().describe("Include layers hidden in the design (default false)"),
    refresh: refreshArg,
  },
  async ({ file, node_id, limit, include_hidden, refresh }) => {
    const { doc, dated, urlNodeId } = await open(file, refresh);
    const id = node_id ?? urlNodeId;
    const roots = id ? [doc.require(id)] : doc.pages();
    const { items, unresolved } = scanText(doc, roots, include_hidden ?? false);
    const max = limit ?? 500;
    const groups = unresolved.length ? groupUnresolved(unresolved) : [];
    const shown = groups.slice(0, MAX_UNRESOLVED_GROUPS);
    return json({
      ...dated,
      returned: Math.min(items.length, max),
      total: items.length,
      truncated: items.length > max,
      unresolvedInstances: unresolved.length,
      unresolved: shown.length ? shown : undefined,
      // The listing is capped, and dropping the rest silently would contradict "each missing component once".
      unresolvedComponentsOmitted: groups.length > shown.length ? groups.length - shown.length : undefined,
      text: items.slice(0, max),
    });
  },
);

tool(
  "figma_screenshot",
  "Render a node to PNG using Figma's own 'Copy as PNG' in the browser (the system clipboard is not touched). " +
    "Uses the live file, not the snapshot. Returns the image, downscaled to max_dimension.",
  {
    file: screenshotFileArg,
    node_id: z.string().optional(),
    max_dimension: z.number().int().positive().optional().describe("Longest side in px of the returned image (default 1568)"),
    save_path: z.string().optional().describe("Also save the PNG (at returned size) to this path"),
  },
  async ({ file, node_id, max_dimension, save_path }) => {
    const ref = parseFileRef(file);
    if (ref.path && !ref.keyInName) {
      throw new Error(
        "Screenshots render the live file through the browser and need its key: pass the Figma URL/key, " +
          "or name the local file '<name> [<key>].fig'.",
      );
    }
    const id = node_id ?? ref.nodeId;
    if (!id) throw new Error("node_id required");
    const nodeId = id.replaceAll("-", ":");
    // Pages cannot be selected; copy everything on them instead. Known only from a local or cached snapshot.
    const localPath = ref.path ?? localFileForKey(ref.key);
    const snapshot = localPath ? await store.getLocal(localPath).catch(() => undefined) : store.peek(ref.key);
    const isPage = snapshot?.get(nodeId)?.type === "CANVAS";
    const png = await web.copyAsPng(ref.key, nodeId, max_dimension ?? 1568, isPage);
    const note = `${isPage ? "page (all top-level layers) " : "node "}${id}: ${png.width}x${png.height}` +
      (png.originalWidth !== png.width ? ` (downscaled from ${png.originalWidth}x${png.originalHeight})` : "") +
      (save_path ? `, saved to ${writeOut(save_path, Buffer.from(png.base64, "base64"))}` : "");
    return { content: [{ type: "image", data: png.base64, mimeType: "image/png" }, { type: "text", text: note }] };
  },
);

tool(
  "figma_export_image_fills",
  "Write the original image assets (photos, bitmaps) a node or the whole file uses, in a fill or a stroke paint, to a " +
    "directory. Answers with an array, one entry per distinct image: hash, the path written, its size in bytes, and up to " +
    "five of the layers using it (with usedByTotal when there are more). An image whose bytes this export does not carry " +
    "is reported as {hash, missing: true} and nothing is written for it.",
  {
    file: fileArg,
    out_dir: z.string().describe(
      "Directory to write the images into, created if it is missing. A relative path is resolved against this process's " +
        "working directory, which for an MCP server is wherever the client started it",
    ),
    node_id: z.string().optional(),
    refresh: refreshArg,
  },
  async ({ file, out_dir, node_id, refresh }) => {
    const { doc, urlNodeId } = await open(file, refresh);
    const id = node_id ?? urlNodeId;
    const used = new Map<string, string[]>();
    const roots = id ? [doc.require(id)] : doc.pages();
    for (const r of roots) {
      for (const n of doc.walk(r)) {
        for (const p of [...(n.fillPaints ?? []), ...(n.strokePaints ?? [])]) {
          const h = p.type === "IMAGE" ? bytesHex(p.image?.hash) : undefined;
          if (h) used.set(h, [...(used.get(h) ?? []), n.name]);
        }
      }
    }
    const written: Raw[] = [];
    // The layer list is sampled, and dropping the rest in silence would read as "this image is used five times".
    const usedBy = (names: string[]) => {
      const all = [...new Set(names)];
      return { usedBy: all.slice(0, 5), ...(all.length > 5 ? { usedByTotal: all.length } : {}) };
    };
    for (const [hash, names] of used) {
      const bytes = doc.images.get(hash);
      if (!bytes) {
        written.push({ hash, missing: true, ...usedBy(names) });
        continue;
      }
      const path = writeOut(join(out_dir, `${hash}.${imageExt(bytes)}`), bytes);
      written.push({ hash, path, bytes: bytes.length, ...usedBy(names) });
    }
    return json(written);
  },
);

/** Unregister from the shared browser, closing it when no other server or CLI process still uses it. */
export async function release() {
  await browser.release().catch(() => {});
}
