// The MCP server over stdio as a child process, on a local .fig file (no browser), with HOME in a temp dir.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectConfig } from "../src/account.ts";
import { FigDocument } from "../src/fig-file.ts";
import { Normalizer } from "../src/normalize.ts";
import { figBytes, type TestNode } from "./fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "figma-reader-mcp-"));
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "home"));
const FRAMES = 20_000;
const fig = join(root, "big.fig");
writeFileSync(fig, figBytes([
  { id: "0:1", type: "CANVAS", parent: "0:0", name: "Page" },
  ...Array.from({ length: FRAMES }, (_, i): TestNode => ({ id: `1:${i + 1}`, type: "FRAME", parent: "0:1", name: `frame ${i}`, position: String(i).padStart(6, "0") })),
]));

interface Session {
  code: number | null;
  /** Responses by request id, as the client sees them: a result, or a JSON-RPC error. */
  answers: Map<number, { result?: any; error?: { code: number; message: string } }>;
}

/** Start the server, send these requests after the handshake, close stdin and collect the answers. */
function serve(requests: { id: number; method: string; params?: object }[], extraEnv: Record<string, string> = {}): Promise<Session> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"), FIGMA_FILES_DIRS: root };
  for (const k of ["FIGMA_ACCOUNT", "FIGMA_READER_CACHE", "FIGMA_CDP_URL", "FIGMA_USER_DATA_DIR"]) delete env[k];
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, ["--no-warnings", join(import.meta.dirname, "..", "src", "mcp.ts")], { cwd: root, env });
  const out: Buffer[] = [];
  child.stdout.on("data", (b) => out.push(b));
  const closed = new Promise<number | null>((r) => child.on("close", r));
  const send = (m: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ method: "notifications/initialized" });
  for (const r of requests) send(r);
  child.stdin.end();
  return closed.then((code) => {
    const answers = new Map<number, { result?: any; error?: { code: number; message: string } }>();
    for (const line of Buffer.concat(out).toString().split("\n").filter(Boolean)) {
      const m = JSON.parse(line);
      if (typeof m.id === "number") answers.set(m.id, m);
    }
    return { code, answers };
  });
}

const call = (id: number, name: string, args: object) => ({ id, method: "tools/call", params: { name, arguments: args } });

test("a client that closes stdin right after a request still gets the whole response", async () => {
  const { code, answers } = await serve([call(2, "figma_search", { file: fig, query: "frame", limit: FRAMES })]);
  assert.equal(code, 0);
  const res = JSON.parse(answers.get(2)!.result.content[0].text);
  assert.equal(res.results.length, FRAMES);
});

test("a server that only reads local files writes nothing, from start to shutdown", async () => {
  // It used to register with the shared browser as it started (a lease under the state directory) and make the
  // account's cache directory, so a read-only sandbox refused the server before a single local read. HOME is not
  // what Windows builds those roots from, so APPDATA and LOCALAPPDATA move with it.
  const home = join(root, "untouched");
  mkdirSync(home);
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") };
  const { code, answers } = await serve([
    call(2, "figma_load_file", { file: fig }),
    call(3, "figma_search", { file: fig, query: "frame 1", limit: 1 }),
    call(4, "figma_list_files", {}),
  ], env);
  assert.equal(code, 0);
  for (const id of [2, 3, 4]) assert.notEqual(answers.get(id)!.result.isError, true, answers.get(id)!.result.content[0].text);
  assert.deepEqual(readdirSync(home, { recursive: true }), []);
});

test("an argument the tool does not have is refused, not dropped", async () => {
  // Both used to be accepted with the unknown key removed: figma_get_tree answered for the whole document, and for
  // the scanning tools a misspelled node_id widened the scan to the whole file, where the cut-off hid the content.
  const { answers } = await serve([
    call(2, "figma_get_tree", { file: fig, nodeId: "1:1", depth: 0 }),
    call(3, "figma_get_tree", { file: fig, depth: 0, bogus: true }),
    call(4, "figma_get_text", { file: fig, node_ids: "1:1" }),
    call(5, "figma_get_tree", { file: fig, node_id: "1:1", depth: 0 }),
  ]);
  for (const [id, tool, key] of [[2, "figma_get_tree", "nodeId"], [3, "figma_get_tree", "bogus"], [4, "figma_get_text", "node_ids"]] as const) {
    const res = answers.get(id)!.result;
    assert.equal(res.isError, true, `${key} was accepted: ${JSON.stringify(res)}`);
    // The message names the tool and the key, so the caller can fix the spelling instead of reading a wrong answer.
    assert.match(res.content[0].text, new RegExp(`Invalid arguments for tool ${tool}.*"${key}"`, "s"), key);
  }
  // The documented spelling still works: the outline starts under the header line that dates it.
  assert.match(answers.get(5)!.result.content[0].text, /^# \{"fileModifiedAt":"[^"]+"\}\n- 1:1 FRAME "frame 0"/);
});

test("only the tools that cannot write are published as read-only", async () => {
  // A client uses readOnlyHint to run a tool without asking the user. Every tool used to carry readOnlyHint: true,
  // including the four that write any path the caller names (a '..' in out_file escaped the working directory) and
  // the two that write account state. The exact split is asserted so it cannot drift back.
  const { answers } = await serve([{ id: 2, method: "tools/list" }]);
  const published = answers.get(2)!.result.tools as { name: string; annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean } }[];
  const writes = published.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort();
  assert.deepEqual(writes, [
    "figma_export_image_fills", // out_dir
    "figma_get_styles", // out_file
    "figma_get_variables", // out_file
    "figma_login", // opens a browser window and signs the profile in
    "figma_screenshot", // save_path
    "figma_status", // records the account's Figma login in the data directory
  ]);
  const readOnly = published.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort();
  assert.deepEqual(readOnly, [
    "figma_changes", "figma_dev_status", "figma_diff", "figma_get_components", "figma_get_node", "figma_get_text",
    "figma_get_tree", "figma_list_files", "figma_load_file", "figma_locate", "figma_search", "figma_token_usage",
  ]);
  // Any of them may reach figma.com, so none of them is a closed-world tool.
  assert.ok(published.every((t) => t.annotations?.openWorldHint === true), "openWorldHint");
});

test("two spellings of one browser share one download directory", async () => {
  // The download directory and the leases beside it are browser-wide. A second key for the same browser is a second
  // lease directory the first cannot see: its holder hands the download behaviour back mid-export, and the .fig then
  // lands in the browser's default directory and is waited for until the 600 s timeout.
  const dirOf = async (env: Record<string, string>) => {
    const { answers } = await serve([call(2, "figma_status", {})], env);
    return JSON.parse(answers.get(2)!.result.content[0].text).downloadDir as string;
  };
  // Port 1 so that nothing is listening: status reports the endpoint it would use without starting anything.
  const [localhost, ip, otherPort] = await Promise.all([
    dirOf({ FIGMA_CDP_URL: "http://localhost:1" }),
    dirOf({ FIGMA_CDP_URL: "http://127.0.0.1:1/" }),
    dirOf({ FIGMA_CDP_URL: "http://127.0.0.1:2" }),
  ]);
  assert.equal(localhost, ip, "localhost and 127.0.0.1 are the same browser");
  assert.notEqual(localhost, otherPort, "another port is another browser");

  // A profile reached through a symlink is the same profile; expandHome already handled ~ and a relative path.
  const real = join(root, "profile");
  mkdirSync(real, { recursive: true });
  symlinkSync(real, join(root, "link-to-profile"));
  const [through, direct] = await Promise.all([
    dirOf({ FIGMA_USER_DATA_DIR: join(root, "link-to-profile") }),
    dirOf({ FIGMA_USER_DATA_DIR: real }),
  ]);
  assert.equal(through, direct);
});

test("a call refused for want of an account tells the client to fix the server, not to pass a flag", async (t) => {
  // The server resolved its account when it started, and a tool call has no --account: what fixes it is the server's
  // env or the directory it is started in, and a restart. Telling an MCP client to pass --account sends it nowhere.
  const stray = findProjectConfig(root)?.path;
  if (stray) return t.skip(`${stray} is above the temp dir`);
  const home = join(root, "two-accounts");
  const env = {
    HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    FIGMA_READER_CACHE: join(home, "cache"), FIGMA_BROWSER_PATH: join(home, "no-such-browser"),
  };
  const data = process.platform === "win32" ? join(env.APPDATA, "figma-reader") : join(home, ".local", "share", "figma-reader");
  for (const a of ["acme", "default"]) mkdirSync(join(data, "accounts", a), { recursive: true });
  const { answers } = await serve([
    call(2, "figma_get_tree", { file: "SOMEFILEKEY1", depth: 0 }),
    call(3, "figma_get_tree", { file: fig, depth: 0 }),
  ], env);
  const refused = answers.get(2)!.result;
  assert.equal(refused.isError, true);
  const message: string = refused.content[0].text;
  assert.ok(message.startsWith(`no Figma account chosen: no .figma-reader.json was found in or above ${realpathSync(root)}, the directory this server was started in`), message);
  assert.match(message, /other accounts exist \(acme\)/);
  assert.match(message, /set FIGMA_ACCOUNT=<name> in its env \(FIGMA_ACCOUNT=default to use "default" on purpose\), or start it in the project's directory, then restart it/);
  assert.doesNotMatch(message, /--account/);
  // The same server reads a local file all the same.
  assert.match(answers.get(3)!.result.content[0].text, /^# \{"fileModifiedAt":"[^"]+"\}\n- 0:1 PAGE "Page"/);
});

test("the dating rule is the server's instructions, said once, and each dated tool points to it", async () => {
  // Written out in each of the ten dated tools' descriptions it was some 8.6 KB of every session's tool list.
  const { answers } = await serve([{ id: 2, method: "tools/list" }]);
  const instructions: string = answers.get(1)!.result.instructions;
  for (const part of ["exportedAt is the ISO-8601 time this tool exported", "account, {name, source}", "fileModifiedAt, that copy's own file time", "pass refresh", "figma_get_tree carries the same fields", "figma_diff dates each of its two sides"]) {
    assert.ok(instructions.includes(part), part);
  }
  const tools = answers.get(2)!.result.tools as { name: string; description: string }[];
  // The rule is in no description; the dated tools say they are dated, in one sentence, and where the rule is.
  assert.ok(tools.every((t) => !t.description.includes("copying, syncing or re-downloading")), "the rule itself is said once");
  const pointing = tools.filter((t) => t.description.includes("Dated by exportedAt and account, or fileModifiedAt for a file read from disk, as the server's instructions say")).map((t) => t.name).sort();
  assert.deepEqual(pointing, [
    "figma_changes", "figma_dev_status", "figma_get_components", "figma_get_node", "figma_get_text", "figma_get_tree",
    "figma_load_file", "figma_locate", "figma_search", "figma_token_usage",
  ]);
  assert.match(tools.find((t) => t.name === "figma_diff")!.description, /old and new are each dated, as the server's instructions say/);
});

test("what file and refresh take is the server's instructions, said once, and each tool's two point to it", async () => {
  // Written out in every tool that reads a file, the two descriptions were 7.4 KB of the 35 KB tool list.
  const { answers } = await serve([{ id: 2, method: "tools/list" }]);
  const instructions: string = answers.get(1)!.result.instructions;
  assert.ok(instructions.startsWith("How file and refresh work: file is a local .fig path, a Figma file key, or a figma.com/design/... URL."), instructions);
  for (const part of ["A node-id in the URL is used by a tool that takes node_id", "from a local '<name> [<key>].fig' under FIGMA_FILES_DIRS", "refresh skips both", "the result carries refreshIgnored"]) {
    assert.ok(instructions.includes(part), part);
  }
  assert.ok(instructions.includes("\n\nHow results are dated: "), "the dating rule follows");
  const props = (answers.get(2)!.result.tools as { name: string; inputSchema: { properties: Record<string, { description?: string }> } }[])
    .flatMap((t) => Object.entries(t.inputSchema.properties).map(([k, p]) => ({ tool: t.name, k, d: p.description ?? "" })));
  const see = "(see the server's instructions, or figma-reader help)";
  // Every file and refresh says what it takes in a line and points there, but screenshot's file and diff's refresh,
  // which are not the shared ones; none repeats the rule.
  const own = (tool: string, k: string) => (tool === "figma_screenshot" && k === "file") || (tool === "figma_diff" && k === "refresh");
  const shared = props.filter((p) => ["file", "refresh"].includes(p.k) && !own(p.tool, p.k));
  assert.ok(shared.length >= 25, `${shared.length}`);
  for (const p of shared) {
    assert.ok(p.d.endsWith(see) && p.d.length < 130, `${p.tool} ${p.k}: ${p.d}`);
    assert.ok(!p.d.includes("FIGMA_FILES_DIRS") && !p.d.includes("refreshIgnored"), `${p.tool} ${p.k} repeats the rule`);
  }
  assert.equal(new Set(shared.filter((p) => p.k === "file").map((p) => p.d)).size, 1);
});

test("results are compact JSON, and text stays as the tool wrote it", async () => {
  // The CLI's one-space indentation was 17-41% of the bytes of a real export's answers, and an MCP client cannot
  // pipe them through jq: the model reads every byte of it.
  const { answers } = await serve([
    call(2, "figma_search", { file: fig, query: "frame 1", limit: 3 }),
    call(3, "figma_get_node", { file: fig, node_id: "0:1", depth: 0 }),
    call(4, "figma_load_file", { file: fig }),
    call(5, "figma_get_tree", { file: fig, depth: 0 }),
  ]);
  for (const id of [2, 3, 4]) {
    const text: string = answers.get(id)!.result.content[0].text;
    assert.equal(text, JSON.stringify(JSON.parse(text)), `answer ${id} is indented`);
  }
  assert.equal(JSON.parse(answers.get(2)!.result.content[0].text).results.length, 3);
  // get-tree's outline is text: its lines and their indentation are the answer.
  assert.match(answers.get(5)!.result.content[0].text, /^# \{"fileModifiedAt":"[^"]+"\}\n- 0:1 PAGE "Page"/);
});

test("get-node refuses over MCP the node the CLI refuses, though its compact JSON would fit", async () => {
  // The 200 KB limit is on the JSON as the CLI prints it, so one call answers or is refused alike on both surfaces.
  const page: TestNode = { id: "0:1", type: "CANVAS", parent: "0:0", name: "Page" };
  const frames = Array.from({ length: 3600 }, (_, i): TestNode => ({ id: `1:${i + 1}`, type: "FRAME", parent: "0:1", name: `f${i}`, position: String(i).padStart(5, "0") }));
  const bytes = figBytes([page, ...frames]);
  // What the tool answers with, as get-node builds it, to show the fixture is between the two sizes.
  const doc = FigDocument.fromBytes("k", new Date(), bytes);
  const body = { fileModifiedAt: new Date().toISOString(), page: "Page", path: "Page", ...new Normalizer(doc).node(doc.get("0:1")!, 1, doc.get(doc.rootId)) };
  const [indented, compact] = [JSON.stringify(body, null, 1).length, JSON.stringify(body).length];
  assert.ok(indented > 200_000 && compact < 200_000, `the fixture is between the two: ${indented} and ${compact}`);
  const file = join(root, "between.fig");
  writeFileSync(file, bytes);
  const { answers } = await serve([call(2, "figma_get_node", { file, node_id: "0:1", depth: 1 })]);
  const res = answers.get(2)!.result;
  assert.equal(res.isError, true, "answered over MCP");
  assert.match(res.content[0].text, /^result is \d+KB; use a smaller depth or a deeper node_id/);
});

test("the published input schema says the unknown arguments are refused", async () => {
  const { answers } = await serve([{ id: 2, method: "tools/list" }]);
  const tree = answers.get(2)!.result.tools.find((t: { name: string }) => t.name === "figma_get_tree");
  assert.equal(tree.inputSchema.additionalProperties, false);
  assert.ok(tree.inputSchema.properties.node_id, "node_id is still published");
});
