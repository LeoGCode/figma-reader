// Usage: node scripts/call.ts <tool> '<json args>'   (spawns the MCP server from source over stdio)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [tool, rawArgs = "{}"] = process.argv.slice(2);
const client = new Client({ name: "call", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("../src/mcp.ts", import.meta.url).pathname], env: process.env as Record<string, string>, stderr: "inherit" }));
if (!tool) {
  const { tools } = await client.listTools();
  console.log(tools.map((t) => t.name).join("\n"));
} else {
  const t0 = Date.now();
  const r = (await client.callTool({ name: tool, arguments: JSON.parse(rawArgs) }, undefined, { timeout: 900_000 })) as CallToolResult;
  for (const c of r.content) {
    if (c.type === "text") console.log(c.text);
    else if (c.type === "image") { const p = join(tmpdir(), `call-${Date.now()}.png`); writeFileSync(p, Buffer.from(c.data, "base64")); console.log(`[image ${c.mimeType} -> ${p}]`); }
  }
  console.error(`${r.isError ? "ERROR " : ""}(${Date.now() - t0}ms)`);
}
await client.close();
