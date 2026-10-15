// End to end against real Figma, the way an agent uses figma-reader: login, export, reads, screenshots, the web file
// list and the MCP server, each as its own process. The unit tests drive a fake Figma that can only be as right as our
// beliefs about the real one: 0.4.0 passed all of them on a macOS runner while every export and screenshot failed on a
// Mac, because Figma there answers Cmd where the fake answered Ctrl. Nothing but a real run finds that, so run this on
// each platform before a release.
//
// Usage: node scripts/smoke.ts --key <file key> --node <frame id> [--account <name>] [--page <page id>] [--cli <cli.js>]
//   or npm run smoke -- <the same>.
//   By default the checkout is packed and installed into a temporary directory, so what runs is what npm would ship;
//   --cli runs an existing build instead, with the mcp.js beside it. --page names the page to capture whole (default:
//   the node's page, which on a large file can be slow to render). Calls run in the current directory, so its
//   .figma-reader.json picks the account unless --account does.
//   Run it from a terminal on the machine's desktop: over SSH a Mac's Keychain is out of reach (README, Accounts), and
//   a login window opened from there is not on anyone's screen.
// Prints design names and ids. Exit code 1 when a step fails; a step that needs a failed one is skipped and says so.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const key = flag("--key");
const node = flag("--node")?.replace("-", ":");
const account = flag("--account");
const pageArg = flag("--page")?.replace("-", ":");
let cli = flag("--cli");
if (!key || !node || args.length) {
  console.error("usage: node scripts/smoke.ts --key <file key> --node <frame id> [--account <name>] [--page <page id>] [--cli <cli.js>]");
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "figma-reader-smoke-"));
// Where the calls run: npm run moves into the package, and INIT_CWD is where it was started.
const here = process.env.INIT_CWD ?? process.cwd();
const repo = join(import.meta.dirname, "..");

/**
 * npm, which is npm.cmd on Windows: Node spawns a .cmd only through a shell, and since Node 24 warns (DEP0190) when
 * arguments are passed beside one. So the command goes as one string; none of these arguments holds a space.
 */
function npm(cwd: string, ...a: string[]): string {
  const r = spawnSync(["npm", ...a].join(" "), { cwd, encoding: "utf8", shell: true });
  if (r.status !== 0) throw new Error(`npm ${a.join(" ")} failed in ${cwd}:\n${r.stderr || r.stdout}`);
  return r.stdout;
}

if (!cli) {
  // Packed where npm puts it, the checkout, then moved out and installed by its relative name.
  const { version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const tgz = `leogcode-figma-reader-${version}.tgz`;
  npm(repo, "pack", "--silent");
  copyFileSync(join(repo, tgz), join(work, tgz));
  rmSync(join(repo, tgz));
  writeFileSync(join(work, "package.json"), '{ "private": true }\n');
  npm(work, "install", "--silent", "--no-audit", "--no-fund", `./${tgz}`);
  cli = join(work, "node_modules", "@leogcode", "figma-reader", "dist", "cli.js");
}
const mcp = join(dirname(cli), "mcp.js");

interface Run {
  code: number | null;
  out: string;
  err: string;
}

/** One CLI call as its own process, as an agent makes it. Node's SQLite warning is not the call's to report. */
function run(a: string[], timeoutMs: number, withAccount = true): Run {
  const r = spawnSync(process.execPath, [cli!, ...a, ...(account && withAccount ? ["--account", account] : [])], {
    cwd: here,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 256 << 20,
  });
  const err = (r.stderr ?? "")
    .split("\n")
    .filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l))
    .join("\n")
    .trim();
  return { code: r.status, out: r.stdout ?? "", err: r.error ? `${r.error.message} ${err}` : err };
}

/** The call's JSON, or a failure that quotes what it said instead. */
function json(r: Run, what: string): any {
  if (r.code !== 0) throw new Error(`${what} exited ${r.code}: ${r.err || r.out.slice(0, 500)}`);
  try {
    return JSON.parse(r.out);
  } catch {
    throw new Error(`${what} printed no JSON: ${r.out.slice(0, 500)}`);
  }
}

function must(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

/** Width and height of a PNG written to path, read from its IHDR; throws when it is not one. */
function png(path: string): string {
  must(existsSync(path), `no image at ${path}`);
  const b = readFileSync(path);
  must(b.length > 33 && b.readUInt32BE(0) === 0x89504e47, `${path} is not a PNG`);
  const [w, h] = [b.readUInt32BE(16), b.readUInt32BE(20)];
  must(w > 0 && h > 0, `${path} is ${w}x${h}`);
  return `${w}x${h}, ${(b.length / 1024).toFixed(0)} KB`;
}

/** The MCP server over stdio: initialize, list the tools, then one call; resolves with the answers by id. */
function mcpSession(call: { name: string; arguments: object }, timeoutMs: number): Promise<Map<number, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", mcp], {
      cwd: here,
      env: { ...process.env, ...(account ? { FIGMA_ACCOUNT: account } : {}) },
    });
    const answers = new Map<number, any>();
    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no answer to ${call.name} within ${timeoutMs / 1000}s; stderr: ${stderr.slice(-500)}`));
    }, timeoutMs);
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => (clearTimeout(timer), reject(e)));
    child.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.id !== undefined) answers.set(m.id, m);
        if (answers.has(3)) {
          clearTimeout(timer);
          child.kill();
          resolve(answers);
        }
      }
    });
    const send = (m: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    send({ id: 3, method: "tools/call", params: call });
  });
}

const minutes = 60_000;
let pages: { id: string; name: string }[] = [];
let nodePage: string | undefined;

const steps: { name: string; needs?: string[]; run: () => string | Promise<string> }[] = [
  {
    name: "status",
    run: () => {
      const s = json(run(["status"], 2 * minutes), "status");
      return `${s.mode}${s.executable ? `, ${s.executable}` : ""}, account ${s.account?.name}`;
    },
  },
  {
    name: "login",
    run: () => {
      const r = run(["login"], 5 * minutes);
      // Logged in answers JSON; otherwise a sentence, and a login window opened for someone to sign in.
      must(r.code === 0 && r.out.trimStart().startsWith("{"), `not logged in: ${(r.out || r.err).trim()} Sign in there, then run this again.`);
      const j = JSON.parse(r.out);
      must(j.loggedIn === true, `loggedIn is ${j.loggedIn}`);
      return `as ${j.user?.email ?? j.user?.handle}`;
    },
  },
  {
    name: "export",
    needs: ["login"],
    run: () => {
      const j = json(run(["load-file", key, "--refresh"], 15 * minutes), "load-file --refresh");
      must(j.source === "web", `source is ${j.source}, not web`);
      // A refresh that quietly served the old snapshot would pass every read below.
      must(Date.now() - Date.parse(j.exportedAt) < 15 * minutes, `exportedAt ${j.exportedAt} is not this run's`);
      pages = j.pages ?? [];
      const mb = statSync(j.snapshotPath).size / 1e6;
      return `"${j.name}", ${pages.length} pages, ${mb.toFixed(1)} MB, exported ${j.exportedAt}`;
    },
  },
  {
    name: "locate",
    needs: ["export"],
    run: () => {
      const j = json(run(["locate", key, "--node-ids", node], 2 * minutes), "locate");
      const hit = j.results?.[0];
      must(hit?.found === true, `node ${node} not found: ${JSON.stringify(hit)}`);
      nodePage = hit.page;
      return `${hit.type} "${hit.name}" on page "${hit.page}"`;
    },
  },
  {
    name: "get-tree",
    needs: ["export"],
    run: () => {
      const r = run(["get-tree", key, "--node-id", node], 2 * minutes);
      must(r.code === 0, `get-tree exited ${r.code}: ${r.err}`);
      const lines = r.out.split("\n");
      must(lines[0]?.startsWith("# {"), `no date line: ${lines[0]}`);
      must(lines.some((l) => l.trimStart().startsWith(`- ${node} `)), `${node} is not in the tree`);
      return `${lines.filter((l) => l.trimStart().startsWith("- ")).length} lines`;
    },
  },
  {
    // Copy as PNG with the node selected: the shortcut that took Ctrl where a Mac wants Cmd.
    name: "screenshot node",
    needs: ["login"],
    run: () => {
      const path = join(work, "node.png");
      const r = run(["screenshot", key, "--node-id", node, "--save-path", path], 5 * minutes);
      must(r.code === 0, `screenshot exited ${r.code}: ${r.err}`);
      return png(path);
    },
  },
  {
    // A page cannot be selected, so this one goes through select-all: a second shortcut, and a second path.
    name: "screenshot page",
    needs: pageArg ? ["login"] : ["locate"],
    run: () => {
      const id = pageArg ?? pages.find((p) => p.name === nodePage)?.id;
      must(id, `no page id for "${nodePage}" among ${pages.map((p) => p.name).join(", ")}`);
      const path = join(work, "page.png");
      const r = run(["screenshot", key, "--node-id", id, "--max-dimension", "800", "--save-path", path], 5 * minutes);
      must(r.code === 0, `screenshot of page ${id} exited ${r.code}: ${r.err}`);
      return `page ${id}: ${png(path)}`;
    },
  },
  {
    name: "list-files web",
    needs: ["login"],
    run: () => {
      const j = json(run(["list-files", "--source", "web", "--limit", "50"], 2 * minutes), "list-files --source web");
      must(Array.isArray(j.files), "no files array");
      return `${j.total} recent files${j.files.some((f: any) => f.key === key) ? ", this one among them" : ""}`;
    },
  },
  {
    name: "mcp server",
    needs: ["export"],
    run: async () => {
      const answers = await mcpSession({ name: "figma_get_tree", arguments: { file: key, node_id: node } }, 3 * minutes);
      const tools = answers.get(2)?.result?.tools ?? [];
      must(tools.length > 10, `tools/list gave ${tools.length} tools`);
      const res = answers.get(3);
      const text = res?.result?.content?.[0]?.text ?? "";
      must(!res?.error && !res?.result?.isError, `figma_get_tree failed: ${JSON.stringify(res?.error ?? text).slice(0, 500)}`);
      must(text.includes(node), `${node} is not in figma_get_tree's answer`);
      return `${tools.length} tools; figma_get_tree answered`;
    },
  },
];

const version = run(["--version"], minutes, false).out.trim();
console.log(`figma-reader ${version} (${cli})`);
console.log(`${process.platform} ${release()} ${arch()}, node ${process.version}, file ${key}, node ${node}\n`);

const outcome = new Map<string, boolean>();
for (const step of steps) {
  const missing = step.needs?.find((n) => outcome.get(n) !== true);
  if (missing) {
    outcome.set(step.name, false);
    console.log(`- ${step.name.padEnd(16)} skipped: needs ${missing}`);
    continue;
  }
  const started = Date.now();
  try {
    const detail = await step.run();
    outcome.set(step.name, true);
    console.log(`✔ ${step.name.padEnd(16)} ${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s  ${detail}`);
  } catch (e) {
    outcome.set(step.name, false);
    console.log(`✖ ${step.name.padEnd(16)} ${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s  ${(e as Error).message}`);
  }
}
const failed = [...outcome.values()].filter((ok) => !ok).length;
console.log(`\n${steps.length - failed} of ${steps.length} passed; images and the installed build are in ${work}`);
process.exit(failed ? 1 : 0);
