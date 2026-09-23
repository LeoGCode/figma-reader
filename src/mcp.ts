#!/usr/bin/env node
// figma-reader-mcp (the figma-reader MCP server): the read-only Figma tools (tools.ts) served over MCP stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { release, tools } from "./tools.ts";
import { version } from "./version.ts";

const server = new McpServer({ name: "figma-reader", version });

for (const t of tools) {
  // readOnlyHint is what a client checks before running a tool without asking the user, and it was published as true
  // for all of them: figma_get_variables, figma_get_styles, figma_screenshot and figma_export_image_fills write any
  // path the caller names, and figma_status/figma_login write account state. openWorldHint stays true throughout: any
  // of them may reach figma.com.
  const annotations = { readOnlyHint: t.readOnly, openWorldHint: true };
  // The SDK turns a raw shape into a plain z.object, which drops what it does not know: figma_get_tree called with
  // nodeId (the spelling Figma's REST API uses) answered for the whole document, and a misspelled node_id widened a
  // scan to the whole file, where the cut-off then hid the content asked for. A strict object rejects both, and says
  // additionalProperties: false in the published schema. The CLI has been strict since cli-args.ts.
  const inputSchema = z.object(t.shape).strict();
  server.registerTool(t.name, { description: t.description, inputSchema, annotations }, (async (args: any) => {
    try {
      return await t.run(args);
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
    }
  }) as any);
}

// Requests received and not yet answered, so a client that closes stdin right after its last request still gets the
// answer: process.exit() would drop it, or cut it off at the pipe buffer while it is being written.
const open = new Set<string | number>();
let idle: (() => void) | undefined;
const transport = new StdioServerTransport();
await server.connect(transport);
const receive = transport.onmessage!;
const answered = (id: unknown) => {
  if (open.delete(id as string | number) && !open.size) idle?.();
};
transport.onmessage = (m) => {
  if ("method" in m && "id" in m) open.add(m.id);
  // The SDK sends no response to a cancelled request.
  if ("method" in m && m.method === "notifications/cancelled") answered(m.params?.requestId);
  receive(m);
};
const send = transport.send.bind(transport);
transport.send = async (m) => {
  await send(m);
  if (!("method" in m) && "id" in m) answered(m.id);
};
process.stdout.on("error", () => {});
const flushed = () =>
  new Promise<void>((done) => (process.stdout.destroyed || process.stdout.writableEnded ? done() : process.stdout.write("", () => done())));

let released = false;
async function shutdown(answerOpen: boolean) {
  if (released) return;
  released = true;
  if (answerOpen && open.size) await new Promise<void>((r) => (idle = r));
  await flushed();
  await release();
  process.exit(0);
}
process.stdin.on("end", () => void shutdown(true));
process.on("SIGINT", () => void shutdown(false));
process.on("SIGTERM", () => void shutdown(false));
