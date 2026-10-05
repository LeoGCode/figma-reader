// figma-reader batch: many tool calls in one process. Every CLI call is a process of its own that decodes its file
// again, which takes seconds on a large export: an agent reviewing a design ran some 130 of them, mostly in loops over
// node ids, and spent 805 s of an 18 minute run inside figma-reader. A batch runs its calls in one process, where the
// store keeps the decoded files used last for the next call (four, fewer large ones), and every web call shares one
// browser launch. Kept free of side effects, like cli-args.ts, so it can be tested on its own: the tools are passed in.
import { AccountNotChosen } from "./account.ts";
import { checkArgs, commandName, listArguments, wrap } from "./cli-args.ts";
import { outPath, writePrivateTemp } from "./local-files.ts";
import type { Tool } from "./tools.ts";

/** What one call answers, as the JSON line written for it. */
export type BatchAnswer = { i: number; ok: true; result: unknown; images?: string[] } | { i: number; ok: false; error: string };

/**
 * Tools a batch will not run. figma_login waits for a person to sign in at a window it opens: with wait_seconds it
 * holds every call after it for up to half an hour while the agent that sent the batch cannot tell anyone a window is
 * waiting, and without it the web calls after it find that window open and fail (on a managed browser, the usual
 * case). Run on its own, its answer says what to ask the user, and the batch follows once they have signed in.
 */
const REFUSED = new Map([
  ["figma_login", "login is not run in a batch: it waits for a person to sign in at the window it opens. Run it on its own, then the batch"],
]);

/** The text a command prints, as the value it stands for: parsed when it is JSON, the text itself otherwise. */
function value(text: string): unknown {
  // Only an object or array: every JSON answer is one, and nothing else gets the chance to read as a number or a word.
  if (!/^\s*[[{]/.test(text)) return text;
  try {
    return JSON.parse(text);
  } catch {
    // JSON followed by a note, as get-variables answers with out_file ("(written to ...)"): what it printed, as is.
    return text;
  }
}

/** refused marks a call turned away because no account was chosen; it is not part of the line written for it. */
type Outcome = { ok: true; result: unknown; images?: string[] } | { ok: false; error: string; refused?: true };
const fail = (error: string): Outcome => ({ ok: false, error });

async function answer(line: string, byName: Map<string, Tool>): Promise<Outcome> {
  let call: unknown;
  try {
    call = JSON.parse(line);
  } catch (e) {
    return fail(`not a JSON line: ${(e as Error).message}`);
  }
  if (!call || typeof call !== "object" || Array.isArray(call)) return fail('a line is a JSON object: {"tool": "<command>", "args": {...}}');
  const { tool: name, args = {}, ...extra } = call as Record<string, unknown>;
  // Strict like the arguments: a misspelled "arg" would otherwise run the call with none.
  const stray = Object.keys(extra);
  if (stray.length) return fail(`unknown key ${JSON.stringify(stray[0])}: a line has "tool" and "args" only`);
  if (typeof name !== "string") return fail('"tool" names the call, as a command ("get-tree") or an MCP tool ("figma_get_tree")');
  const tool = byName.get(name);
  if (!tool) return fail(`unknown tool ${JSON.stringify(name)}. Run 'figma-reader help' for the list.`);
  const refused = REFUSED.get(tool.name);
  if (refused) return fail(refused);
  let checked: Record<string, unknown>;
  try {
    checked = checkArgs(tool.shape, args);
  } catch (e) {
    return fail(`invalid arguments for ${commandName(tool.name)}: ${(e as Error).message}`);
  }
  try {
    const res = await tool.run(checked);
    const text = res.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
    if (res.isError) return fail(text);
    // Written to a file as the command alone writes it, and named by path: an image inline would be megabytes of
    // base64 in one line of the caller's context, and no shell tool reads a picture out of a JSON string.
    const images = res.content.flatMap((c) => {
      if (c.type !== "image") return [];
      // The tool has already written it there, so this only says where that was. An empty one is no path, as the
      // tool and the command alone read it: reporting it resolved to the working directory, where nothing was saved.
      const saved = typeof checked.save_path === "string" ? checked.save_path : "";
      if (saved) return [outPath(saved)];
      return [writePrivateTemp(commandName(tool.name), c.mimeType.split("/")[1] ?? "bin", Buffer.from(c.data, "base64"))];
    });
    return { ok: true, result: value(text), ...(images.length ? { images } : {}) };
  } catch (e) {
    // Its line says what a single call would on stderr; whether it was refused is the batch's exit code to say.
    const error = e instanceof Error ? e.message : String(e);
    return e instanceof AccountNotChosen ? { ok: false, error, refused: true } : fail(error);
  }
}

export interface BatchSummary {
  /** Calls answered: every line but the blank ones, up to where the batch stopped. */
  answered: number;
  /** The i of each call that failed, in order, the refused ones included. */
  failed: number[];
  /**
   * The i of each call refused because nothing chose an account (see AccountNotChosen): nothing was tried on that
   * line, and the same line is refused every time until the account or the working directory changes.
   */
  refused: number[];
}

/**
 * Run each line as a call, in order, and write one JSON line per call as soon as it is answered. A line that is not a
 * call fails alone and the rest still run. `write` resolves false once nobody reads the answers any more (`| head`),
 * which ends the batch rather than running calls whose answers have nowhere to go.
 */
export async function runBatch(lines: AsyncIterable<string> | Iterable<string>, tools: Tool[], write: (line: string) => Promise<boolean>): Promise<BatchSummary> {
  const byName = new Map<string, Tool>();
  for (const t of tools) byName.set(t.name, t).set(commandName(t.name), t);
  const summary: BatchSummary = { answered: 0, failed: [], refused: [] };
  for await (const line of lines) {
    if (!line.trim()) continue;
    const i = summary.answered++;
    const got = await answer(line, byName);
    const out: BatchAnswer = got.ok ? { i, ...got } : { i, ok: false, error: got.error };
    if (!got.ok) summary.failed.push(i);
    if (!got.ok && got.refused) summary.refused.push(i);
    if (!(await write(JSON.stringify(out)))) break;
  }
  return summary;
}

export const BATCH_SUMMARY = "Run tool calls given as JSON lines on stdin in one process, which keeps files decoded between calls.";

/**
 * Every argument that takes a list, with the commands that take it, read off the schemas so that a list a tool gains
 * is named here too: an agent wrote "node_ids": "1:2,3:4", the way the flag takes it, and lost the call.
 */
function lists(tools: Tool[]): string {
  const takers = new Map<string, string[]>();
  for (const t of tools) for (const k of listArguments(t.shape)) takers.set(k, [...(takers.get(k) ?? []), commandName(t.name)]);
  return [...takers].map(([k, commands]) => `${k} (${commands.join(", ")})`).join(", ");
}

export function batchUsage(bin: string, tools: Tool[]): string {
  return [
    `Usage: ${bin} batch < calls.jsonl`,
    "",
    "Run many tool calls in one process, so a file is not decoded again for every call (seconds for a large file),",
    "and web calls share one browser. The process keeps the four files used last decoded, fewer when they are large",
    "(FIGMA_DECODED_MAX_MB, half of Node's heap limit by default: about two 67 MB exports with 16 GB of RAM), and",
    "always the one in use, so group calls by file. Each line of stdin is one call, run in order:",
    "",
    '  {"tool": "get-text", "args": {"file": "app.fig", "node_id": "1:2"}}',
    "",
    "tool is a command (get-text) or an MCP tool name (figma_get_text). args are the MCP argument names, as --json takes",
    "them, checked as strictly as a single call's. Blank lines are skipped. Each call with refresh exports the file",
    "again, as it would on its own, so pass it only on the first call that needs it.",
    "",
    wrap(
      'args take JSON values: a number or a switch as a JSON number or boolean ("limit": 20, "include_text": true), and ' +
        `a list as a JSON array, even of one value, never as a comma-separated string. The lists are ${lists(tools)}:`,
      116,
      "",
    ),
    "",
    '  {"tool": "search", "args": {"file": "app.fig", "query": "Button", "types": ["FRAME"], "exclude_pages": []}}',
    "",
    "Each call is answered by one JSON line on stdout, in the same order:",
    "",
    '  {"i": 0, "ok": true, "result": {...}}',
    '  {"i": 1, "ok": false, "error": "node 9:9 not found in file /work/app.fig"}',
    "",
    "i counts the calls from 0. result is what the command prints on its own: its JSON parsed, or a string when it",
    "answers with text (get-tree's outline, CSS, a screenshot's note). An image is written to save_path, or without one",
    'to a private temp file, and its path listed in "images". A line that is not JSON, names no tool or has bad',
    "arguments fails alone; the rest still run. login is refused: it waits for a person, so run it on its own first.",
    `Every call uses the account the batch runs as (${bin} --account <name> batch).`,
    "",
    "Exit code 0 when every call succeeded, 1 when any failed (stderr says which), 2 for bad usage of batch itself or",
    "when any call was refused because no Figma account was chosen: its line holds the refusal, nothing was tried on",
    "it, and running the batch again is refused the same way until the account is chosen.",
    "",
    "Example:",
    "  printf '%s\\n' \\",
    `    '{"tool":"locate","args":{"file":"app.fig","node_ids":["1:2","3:4"]}}' \\`,
    `    '{"tool":"get-text","args":{"file":"app.fig","node_id":"1:2"}}' |`,
    `    ${bin} batch | jq -c .result`,
  ].join("\n");
}
