// Concurrency probe: (a) two screenshots in parallel within one server, (b) two servers in parallel,
// (c) N servers in parallel, the condition under which Copy as PNG used to race the node selection.
// Usage: node scripts/concurrency.ts <fileKey> <nodeA> <nodeB> [same|multi|fan|export] [count]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";

const [fileKey, nodeA, nodeB, mode = "same", count = "4"] = process.argv.slice(2);
const server = join(import.meta.dirname, "..", "src", "mcp.ts");

async function connect(name: string) {
  const c = new Client({ name, version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: process.env as Record<string, string>, stderr: "inherit" }));
  return c;
}

async function shot(client: Client, label: string, node: string) {
  const t0 = Date.now();
  const r = (await client.callTool({ name: "figma_screenshot", arguments: { file: fileKey, node_id: node, max_dimension: 400 } }, undefined, { timeout: 600_000 })) as CallToolResult;
  const note = r.content.find((c) => c.type === "text")?.text;
  return `${label} node=${node} ${r.isError ? "ERROR" : "ok"} ${Date.now() - t0}ms :: ${note}`;
}

async function exportFile(client: Client, label: string, key: string) {
  const t0 = Date.now();
  const r = (await client.callTool({ name: "figma_load_file", arguments: { file: key, refresh: true } }, undefined, { timeout: 900_000 })) as CallToolResult;
  const first = r.content[0];
  const t = first?.type === "text" ? first.text : "";
  return `${label} key=${key} ${r.isError ? "ERROR " + t : "ok"} ${Date.now() - t0}ms`;
}

if (mode === "same") {
  const c = await connect("a");
  console.log((await Promise.all([shot(c, "A", nodeA), shot(c, "B", nodeB)])).join("\n"));
  await c.close();
} else if (mode === "multi") {
  const [c1, c2] = await Promise.all([connect("a"), connect("b")]);
  console.log((await Promise.all([shot(c1, "server1", nodeA), shot(c2, "server2", nodeB)])).join("\n"));
  await Promise.all([c1.close(), c2.close()]);
} else if (mode === "fan") {
  const n = Number(count);
  const clients = await Promise.all([...Array(n)].map((_, i) => connect(`c${i}`)));
  const lines = await Promise.all(clients.map((c, i) => shot(c, `server${i + 1}`, i % 2 ? nodeB : nodeA)));
  console.log(lines.join("\n"));
  console.log(`${lines.filter((l) => l.includes(" ERROR ")).length}/${n} failed`);
  await Promise.all(clients.map((c) => c.close()));
} else if (mode === "export") {
  // nodeA/nodeB are file keys here
  const [c1, c2] = await Promise.all([connect("a"), connect("b")]);
  console.log((await Promise.all([exportFile(c1, "server1", nodeA), exportFile(c2, "server2", nodeB)])).join("\n"));
  await Promise.all([c1.close(), c2.close()]);
}
