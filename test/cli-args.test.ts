// The CLI derives its arguments from the MCP tool schemas; these pin the mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { checkArgs, commandName, commandUsage, parseArgs, positionals, UsageError, wantsHelp } from "../src/cli-args.ts";

const shape = {
  file: z.string(),
  query: z.string(),
  node_id: z.string().optional(),
  depth: z.number().int().min(0).optional(),
  types: z.array(z.string()).optional(),
  format: z.enum(["json", "css"]).optional(),
  refresh: z.boolean().optional(),
};

test("command names are the tool names in kebab-case without the figma_ prefix", () => {
  assert.equal(commandName("figma_get_tree"), "get-tree");
  assert.equal(commandName("figma_export_image_fills"), "export-image-fills");
});

test("required strings are positional in declaration order", () => {
  assert.deepEqual(positionals(shape), ["file", "query"]);
  assert.deepEqual(parseArgs(shape, ["a.fig", "button"]), { file: "a.fig", query: "button" });
});

test("flags map to snake_case arguments with typed values", () => {
  const a = parseArgs(shape, ["a.fig", "q", "--node-id", "1:2", "--depth=3", "--types", "FRAME,TEXT", "--types", "INSTANCE", "--format", "css", "--refresh"]);
  assert.deepEqual(a, { file: "a.fig", query: "q", node_id: "1:2", depth: 3, types: ["FRAME", "TEXT", "INSTANCE"], format: "css", refresh: true });
  assert.equal(parseArgs(shape, ["a", "q", "--no-refresh"]).refresh, false);
  for (const v of ["false", "no", "0", "off", "FALSE"]) assert.equal(parseArgs(shape, ["a", "q", `--refresh=${v}`]).refresh, false, v);
  for (const v of ["true", "yes", "1", "on", "True"]) assert.equal(parseArgs(shape, ["a", "q", `--refresh=${v}`]).refresh, true, v);
});

test("a list flag also answers to its singular, the way a repeated flag reads", () => {
  // search --exclude-page Archive --exclude-page Old fills exclude_pages, as --type does types here.
  assert.deepEqual(parseArgs(shape, ["a", "q", "--type", "FRAME", "--types", "TEXT", "--type=INSTANCE,GROUP"]).types, ["FRAME", "TEXT", "INSTANCE", "GROUP"]);
  // It takes a value like the list it stands for, so "--help" after it is that value.
  assert.equal(wantsHelp(shape, ["a.fig", "q", "--type", "--help"]), false);
  // Never in place of an argument that has the singular name itself, and only for a list.
  const both = { ...shape, page: z.string().optional(), pages: z.array(z.string()).optional() };
  assert.deepEqual(parseArgs(both, ["a", "q", "--page", "P"]), { file: "a", query: "q", page: "P" });
  assert.throws(() => parseArgs({ ...shape, names: z.string().optional() }, ["a", "q", "--name", "x"]), /unknown option --name/);
});

test("--json merges raw arguments and positionals fill only what is unset", () => {
  assert.deepEqual(parseArgs(shape, ["--json", '{"file":"x.fig","depth":1}', "q"]), { file: "x.fig", query: "q", depth: 1 });
});

test("a list adds up whichever side of --json its flags are written on", () => {
  // --types after --json accumulated, --types before it was silently dropped by Object.assign.
  const types = (argv: string[]) => parseArgs(shape, ["a", "q", ...argv]).types;
  assert.deepEqual(types(["--json", '{"types":["B"]}', "--types", "A"]), ["B", "A"]);
  assert.deepEqual(types(["--types", "A", "--json", '{"types":["B"]}']), ["A", "B"]);
  // A scalar still takes the last one written, as before.
  assert.equal(parseArgs(shape, ["a", "q", "--depth", "1", "--json", '{"depth":2}']).depth, 2);
  assert.equal(parseArgs(shape, ["a", "q", "--json", '{"depth":2}', "--depth", "1"]).depth, 1);
});

test("bad input is a UsageError naming the problem", () => {
  const bad = (argv: string[], re: RegExp) => assert.throws(() => parseArgs(shape, argv), (e) => e instanceof UsageError && re.test(e.message));
  bad(["a.fig"], /missing <query>/);
  bad(["a", "q", "extra"], /unexpected argument "extra"/);
  bad(["a", "q", "--nope"], /unknown option --nope/);
  bad(["a", "q", "--depth", "x"], /takes a number/);
  bad(["a", "q", "--depth"], /needs a value/);
  bad(["a", "q", "--depth", "-1"], /depth/);
  bad(["a", "q", "--format", "yaml"], /format/);
  bad(["a", "q", "--json", "[1]"], /JSON object/);
  // Booleans used to read any unrecognised value as true.
  bad(["a", "q", "--refresh=garbage"], /--refresh takes true\/false, got "garbage"/);
  bad(["a", "q", "--no-refresh=true"], /--no-refresh takes no value/);
  // An empty list used to filter out every node.
  bad(["a", "q", "--types="], /--types needs at least one value/);
  bad(["a", "q", "--types", " , "], /--types needs at least one value/);
  // A list flag added to what --json left there: a number threw a raw TypeError out of the CLI (exit 1, a stack with
  // source paths, and the browser never released), and a string was spread into its characters and searched for.
  bad(["a", "q", "--json", '{"types":5}', "--types", "FRAME"], /--types takes a list; --json set types to 5/);
  bad(["a", "q", "--json", '{"types":"FRAME"}', "--types", "TEXT"], /--types takes a list; --json set types to "FRAME"/);
});

test("--help is help only where a flag is expected, not where a value is", () => {
  assert.equal(wantsHelp(shape, ["a.fig", "q", "--help"]), true);
  assert.equal(wantsHelp(shape, ["-h"]), true);
  assert.equal(wantsHelp(shape, ["a.fig", "--", "--help"]), false);
  // --node-id takes a value, so "--help" is that value: this used to print usage instead of running the command.
  assert.equal(wantsHelp(shape, ["a.fig", "q", "--node-id", "--help"]), false);
  assert.equal(wantsHelp(shape, ["a.fig", "q", "--node-id=1:2", "--help"]), true);
  // A boolean takes no value, so what follows it is read as usual.
  assert.equal(wantsHelp(shape, ["a.fig", "q", "--refresh", "--help"]), true);
  // Account commands have no options of their own.
  assert.equal(wantsHelp({}, ["--help"]), true);
});

test("usage lists --json under Options, aligned, also for a command without options", () => {
  // Without options of its own, --json used to be glued to its description with no Options: header.
  const bare = commandUsage("fr", { name: "figma_status", description: "State.", shape: {} });
  assert.equal(bare, "Usage: fr status [options]\n\nState.\n\nOptions:\n  --json <object>  Raw arguments as JSON (names as in the MCP tool)");
  const described = { file: z.string(), depth: z.number().optional().describe("Levels"), refresh: z.boolean().optional().describe("Re-export") };
  const lines = commandUsage("fr", { name: "figma_get_tree", description: "Tree.", shape: described }).split("\n");
  const column = (flag: string) => {
    const l = lines.find((x) => x.startsWith(`  ${flag}`))!;
    return l.length - l.replace(/^ {2}\S+(?: <[^>]+>)? +/, "").length;
  };
  assert.deepEqual(["--depth", "--refresh", "--json"].map(column), [20, 20, 20]);
});

test("a required list is a flag the command cannot run without, and says so", () => {
  // locate is the first tool to require something that is not a string, which positionals() never takes: it was
  // listed under [options] like any other flag, and leaving it out failed with zod's "expected array, received
  // undefined".
  const locate = { file: z.string(), node_ids: z.array(z.string()).min(1), refresh: z.boolean().optional() };
  assert.deepEqual(positionals(locate), ["file"]);
  assert.deepEqual(parseArgs(locate, ["a.fig", "--node-ids", "1:2,3-4"]), { file: "a.fig", node_ids: ["1:2", "3-4"] });
  assert.deepEqual(parseArgs(locate, ["a.fig", "--json", '{"node_ids":["1:2"]}']).node_ids, ["1:2"]);
  assert.throws(() => parseArgs(locate, ["a.fig"]), (e) => e instanceof UsageError && e.message === "missing --node-ids");
  assert.throws(() => parseArgs(locate, []), (e) => e instanceof UsageError && e.message === "missing <file> --node-ids");
  const usage = commandUsage("fr", { name: "figma_locate", description: "Locate.", shape: locate });
  assert.equal(usage.split("\n")[0], "Usage: fr locate <file> --node-ids <string,...> [options]");
});

test("a required list answers to its singular as a flag, and only to its own name in --json and a batch line", () => {
  // The singular is the CLI's way of writing a repeated flag (--node-id 1:2 --node-id 3:4, as --exclude-page reads),
  // so it counts as the required list it stands for. --json and a batch line take MCP argument names, where node_id
  // is no argument of locate's: that is the error to name, not that --node-ids is missing.
  const locate = { file: z.string(), node_ids: z.array(z.string()).min(1), refresh: z.boolean().optional() };
  assert.deepEqual(parseArgs(locate, ["a.fig", "--node-id", "1:2", "--node-id=3-4"]), { file: "a.fig", node_ids: ["1:2", "3-4"] });
  assert.equal(wantsHelp(locate, ["a.fig", "--node-id", "--help"]), false, "--help is the value it takes");
  assert.throws(() => parseArgs(locate, ["a.fig", "--node-id="]), /--node-id needs at least one value/);
  assert.throws(() => parseArgs(locate, ["a.fig", "--json", '{"node_id":["1:2"]}']), (e) => e instanceof UsageError && /Unrecognized key: "node_id"/.test(e.message));
  assert.throws(() => checkArgs(locate, { file: "a.fig", node_id: ["1:2"] }), (e) => e instanceof UsageError && /Unrecognized key: "node_id"/.test(e.message));
  // A missing positional is still said first, whatever --json carried.
  assert.throws(() => parseArgs(locate, ["--json", '{"node_id":["1:2"]}']), (e) => e instanceof UsageError && e.message === "missing <file> --node-ids");
});
