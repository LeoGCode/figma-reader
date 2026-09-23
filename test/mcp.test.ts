// The MCP server over stdio as a child process, on a local .fig file (no browser), with HOME in a temp dir.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  // The documented spelling still works.
  assert.match(answers.get(5)!.result.content[0].text, /^- 1:1 FRAME "frame 0"/);
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
    "figma_get_components", "figma_get_node", "figma_get_text", "figma_get_tree",
    "figma_list_files", "figma_load_file", "figma_search", "figma_token_usage",
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

test("the published input schema says the unknown arguments are refused", async () => {
  const { answers } = await serve([{ id: 2, method: "tools/list" }]);
  const tree = answers.get(2)!.result.tools.find((t: { name: string }) => t.name === "figma_get_tree");
  assert.equal(tree.inputSchema.additionalProperties, false);
  assert.ok(tree.inputSchema.properties.node_id, "node_id is still published");
});
