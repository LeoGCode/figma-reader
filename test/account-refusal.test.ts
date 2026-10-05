// The refusal of a "default" nothing chose, from inside the process: a refused call must not have reached the snapshot
// cache or the browser first. The CLI tests cannot tell: a screenshot that read default's cache and was refused after
// exits 2 with the very same message. So every method of the cache, the Figma web client and the browser manager is
// counted here, and a refused call has to leave the count at zero. The manager is made only by the first call that
// needs the browser (useBrowser in tools.ts), and making it takes this process's client lease without calling any
// method the count sees, so what a call left under the state and cache roots is compared too: a refused call leaves
// both as they were. tools.ts resolves the account when it is imported,
// which is why this is a file of its own: here nothing chooses one, and another account exists.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { appRoot, findProjectConfig } from "../src/account.ts";
import { BrowserManager } from "../src/browser.ts";
import { FigmaWeb } from "../src/figma-web.ts";
import { SnapshotStore } from "../src/store.ts";
import { figBytes, type TestNode } from "./fixtures.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "figma-reader-refusal-")));
const home = join(root, "home");
// A directory with no .figma-reader.json in or above it, as an agent's scratch directory has none.
const work = join(root, "work");
const local = join(root, "local");
const elsewhere = join(root, "elsewhere");
for (const d of [home, work, local, elsewhere]) mkdirSync(d, { recursive: true });
// Everything tools.ts reads at import points into the temp dir (see tools.test.ts for why HOME alone is not enough).
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.APPDATA = join(home, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(home, "AppData", "Local");
process.env.FIGMA_READER_CACHE = join(root, "cache");
process.env.FIGMA_FILES_DIRS = local;
process.env.FIGMA_BROWSER_PATH = join(root, "no-such-browser");
for (const k of ["FIGMA_ACCOUNT", "FIGMA_CDP_URL", "FIGMA_USER_DATA_DIR", "FIGMA_SNAPSHOT_MAX_AGE_MIN"]) delete process.env[k];

const accounts = process.platform === "win32"
  ? join(home, "AppData", "Roaming", "figma-reader", "accounts")
  : join(home, ".local", "share", "figma-reader", "accounts");
for (const a of ["acme", "default"]) mkdirSync(join(accounts, a), { recursive: true });

const KEY = "CACHEDKEY123";
const nodes: TestNode[] = [{ id: "0:1", type: "CANVAS", parent: "0:0", name: "Page" }, { id: "1:1", type: "FRAME", parent: "0:1", name: "Card" }];
// A fresh snapshot of KEY in default's cache: a call that reached the cache would be answered from it.
mkdirSync(join(root, "cache", "accounts", "default"), { recursive: true });
writeFileSync(join(root, "cache", "accounts", "default", `${KEY}.fig`), figBytes(nodes));
// A local file read by path, and one whose name carries a key, which a screenshot takes for that key.
const plain = join(local, "plain.fig");
writeFileSync(plain, figBytes(nodes));
const keyed = join(elsewhere, "Keyed [PATHKEY12345].fig");
writeFileSync(keyed, figBytes(nodes));

/** Every call into these three, as "store.get", "web.copyAsPng", "browser.managed"..., getters included. */
const touched: string[] = [];
for (const [cls, label] of [[SnapshotStore, "store"], [FigmaWeb, "web"], [BrowserManager, "browser"]] as const) {
  const proto = cls.prototype as unknown as Record<string, unknown>;
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
    if (key === "constructor") continue;
    if (typeof d.value === "function") {
      const fn = d.value as (...a: unknown[]) => unknown;
      Object.defineProperty(proto, key, { ...d, value(this: unknown, ...a: unknown[]) { touched.push(`${label}.${key}`); return fn.apply(this, a); } });
    } else if (d.get) {
      const get = d.get;
      Object.defineProperty(proto, key, { ...d, get(this: unknown) { touched.push(`${label}.${key}`); return get.call(this); } });
    }
  }
}

const stray = findProjectConfig(work)?.path;
const startedIn = process.cwd();
process.chdir(work);
const { AccountNotChosen, release, tools } = await import("../src/tools.ts");
const { runBatch } = await import("../src/batch.ts");
after(async () => {
  process.chdir(startedIn);
  await release();
  rmSync(root, { recursive: true, force: true });
});
const byName = new Map(tools.map((t) => [t.name, t]));
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content[0].text!;

/**
 * The arguments of a tool that name a file it reads: file, and figma_diff's old and new. Told apart by what they say
 * they take (a .fig path, a key or a URL), so a tool added later with a file argument of another name is held to the
 * same rule without this list being remembered.
 */
const fileArgs = (t: (typeof tools)[number]) =>
  Object.entries((z.toJSONSchema(z.object(t.shape)) as { properties: Record<string, { type?: string; description?: string }> }).properties)
    .filter(([, p]) => p.type === "string" && /\.fig\b/.test(p.description ?? "") && /\bkey\b/.test(p.description ?? ""))
    .map(([k]) => k);

/** Everything under the roots a call through the account writes: state (the client lease, downloads) and the cache. */
const onDisk = () =>
  [appRoot("state"), join(root, "cache")]
    .flatMap((d) => {
      try {
        return readdirSync(d, { recursive: true }).map((p) => join(d, String(p)));
      } catch {
        return [];
      }
    })
    .sort();

/** Run a call and return what it touched, and what it wrote or removed; it must be refused for want of an account. */
async function refused(name: string, args: Record<string, unknown>, why: RegExp) {
  touched.length = 0;
  const before = onDisk();
  await assert.rejects(byName.get(name)!.run(args), (e: Error) => e instanceof AccountNotChosen && why.test(e.message), `${name} ${JSON.stringify(args)}`);
  const after = onDisk();
  return [
    ...touched,
    ...after.filter((p) => !before.includes(p)).map((p) => `wrote ${p}`),
    ...before.filter((p) => !after.includes(p)).map((p) => `removed ${p}`),
  ];
}

describe("a call nothing chose an account for, with another account on this machine", { skip: stray && `${stray} is above the temp dir` }, () => {
  it("is refused before it reaches the cache or the browser, for every tool that takes a file", async () => {
    // Every file argument of every tool, so that one added later is held to the same rule. node_id is given because
    // figma_screenshot asks for it before anything else, and since because figma_changes reads it before the file (a
    // typo is reported without an export); the other tools reach the refusal before they look at either. Any other
    // file argument is a local .fig, which needs no account: the refusal has to come before that one is read too, so
    // figma_diff given a key as old is refused before it decodes the path given as new.
    const fileTools = tools.filter((t) => fileArgs(t).length);
    assert.ok(fileTools.length >= 15, fileTools.map((t) => t.name).join(", "));
    assert.deepEqual(fileArgs(byName.get("figma_diff")!), ["old", "new"]);
    // A path the tool writes is no file it reads, though its description may mention a .fig.
    assert.deepEqual(fileArgs(byName.get("figma_get_variables")!), ["file"]);
    for (const t of fileTools) {
      for (const arg of fileArgs(t)) {
        const others = Object.fromEntries(fileArgs(t).filter((k) => k !== arg).map((k) => [k, plain]));
        for (const file of [KEY, `https://www.figma.com/design/${KEY}/App?node-id=1-1`]) {
          const args = { node_id: "1:1", since: "7d", ...others, [arg]: file };
          assert.deepEqual(await refused(t.name, args, /other accounts exist \(acme\)/), [], `${t.name} with ${arg} ${file}`);
        }
      }
    }
    // previous names a snapshot in this account's cache as surely as a key does.
    assert.deepEqual(await refused("figma_diff", { old: "previous", new: KEY }, /acme/), []);
    // A refresh asks for the live file however the key would otherwise be served.
    assert.deepEqual(await refused("figma_get_tree", { file: KEY, refresh: true }, /acme/), []);
    // A screenshot from a local path whose name carries the key is a screenshot of that key: the browser renders it,
    // and the page check would read the file first.
    assert.deepEqual(await refused("figma_screenshot", { file: keyed, node_id: "0:1" }, /acme/), []);
    assert.deepEqual(await refused("figma_list_files", { source: "web" }, /acme/), []);
    assert.deepEqual(await refused("figma_login", {}, /acme/), []);
  });

  it("refuses a batch line the way it refuses the call, and answers the lines that need no account", async () => {
    // The batch goes on past a refused line, as past any failed one, and says which were refused: those exit 2.
    const lines = [
      JSON.stringify({ tool: "get-tree", args: { file: KEY } }),
      JSON.stringify({ tool: "get-tree", args: { file: plain } }),
      JSON.stringify({ tool: "diff", args: { old: KEY, new: plain } }),
      JSON.stringify({ tool: "dev-status", args: { file: `https://www.figma.com/design/${KEY}/App` } }),
    ];
    const out: { i: number; ok: boolean; error?: string }[] = [];
    touched.length = 0;
    const before = onDisk();
    const summary = await runBatch([lines[0], lines[2], lines[3]], tools, async (l) => (out.push(JSON.parse(l)), true));
    assert.deepEqual([touched, onDisk()], [[], before], "a refused line reaches neither the cache nor the browser");
    assert.deepEqual(summary, { answered: 3, failed: [0, 1, 2], refused: [0, 1, 2] });
    for (const o of out) assert.match(o.error!, /^no Figma account chosen: .*other accounts exist \(acme\)/);
    out.length = 0;
    const mixed = await runBatch(lines, tools, async (l) => (out.push(JSON.parse(l)), true));
    assert.deepEqual([mixed.failed, mixed.refused, out.map((o) => o.ok)], [[0, 2, 3], [0, 2, 3], [false, true, false, false]]);
  });

  it("reads a local .fig all the same, through the store the count watches", async () => {
    // Without this the zeros above could be a count that never counts anything.
    touched.length = 0;
    const tree = textOf(await byName.get("figma_get_tree")!.run({ file: plain }));
    assert.match(tree, /^# \{"fileModifiedAt":"[^"]+"\}\n- 0:1 PAGE "Page"/);
    assert.ok(touched.includes("store.getLocal"), touched.join(", "));
  });

  it("is answered from the cache once default is the only account, naming it", async () => {
    renameSync(join(accounts, "acme"), join(root, "acme.away"));
    try {
      touched.length = 0;
      const [header] = textOf(await byName.get("figma_get_tree")!.run({ file: KEY })).split("\n");
      assert.deepEqual(JSON.parse(header.slice(2)).account, { name: "default", source: "default" });
      assert.ok(touched.includes("store.get"), touched.join(", "));
      // A fresh snapshot answers without the browser, so the manager was never made and no client lease taken: the
      // refusal has to stand ahead of the cache read itself, since no browser call follows it to stand ahead of.
      assert.deepEqual(onDisk().filter((p) => p.startsWith(appRoot("state"))), [], "nothing under the state root");
    } finally {
      renameSync(join(root, "acme.away"), join(accounts, "acme"));
    }
  });

  it("is refused when the accounts there are cannot be listed, saying why", async () => {
    // A file where the accounts directory belongs fails the listing on every platform (ENOTDIR), standing for the
    // EACCES or EIO of a real machine. listAccounts read that as "no accounts", which let the fallback through.
    renameSync(accounts, `${accounts}.away`);
    writeFileSync(accounts, "");
    try {
      const why = /the accounts that exist could not be listed \(ENOTDIR: [^)]+\), so it may not be the only one/;
      assert.deepEqual(await refused("figma_get_tree", { file: KEY }, why), []);
      assert.deepEqual(await refused("figma_screenshot", { file: KEY, node_id: "1:1" }, why), []);
      assert.match(JSON.parse(textOf(await byName.get("figma_status")!.run({}))).webCallsRefused, why);
    } finally {
      rmSync(accounts);
      renameSync(`${accounts}.away`, accounts);
    }
  });

});
