#!/usr/bin/env node
// figma-reader: the same read-only Figma tools as the MCP server, as shell commands.
// Text and JSON go to stdout, errors to stderr; images are written to files and their paths printed.
import { writeSync } from "node:fs";
import {
  accountProfileDir, checkAccountName, CONFIG_FILE, DEFAULT_ACCOUNT, expandHome, listAccounts, readAccountInfo,
  resolveAccount, writeProjectAccount,
} from "./account.ts";
import { defaultExecutable, profileHasLoginCookie } from "./browser.ts";
import { commandName, commandUsage, parseArgs, UsageError, wantsHelp } from "./cli-args.ts";
import { writePrivateTemp } from "./local-files.ts";
import { version } from "./version.ts";

const BIN = "figma-reader";
// fatal() is called from places that cannot await quit()'s flush, and process.exit() drops what console.error has
// only queued (stderr is asynchronous on a pipe on macOS): a blocking write leaves nothing queued to lose.
const fatal = (message: string, code = 2): never => {
  const line = `${BIN}: ${message}\n`;
  try {
    writeSync(2, line);
  } catch {
    process.stderr.write(line);
  }
  process.exit(code);
};

// process.exit() drops whatever is still queued for a pipe, cutting output at the pipe buffer (64 KiB or so) while
// reporting success. Wait until stdout and stderr have handed everything to the OS; exit explicitly anyway, since after
// a web call a socket or timer may still hold the event loop open.
const flushed = (s: NodeJS.WriteStream) =>
  new Promise<void>((done) => (s.destroyed || s.writableEnded ? done() : s.write("", () => done())));
// A reader that stops early (| head) is not an error of ours; without a listener EPIPE would crash the process.
for (const s of [process.stdout, process.stderr]) s.on("error", () => {});
async function quit(code: number): Promise<never> {
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code);
}

// --account <name> is global: it may appear anywhere before a "--" and selects the account the way FIGMA_ACCOUNT does.
const rawArgv = process.argv.slice(2);
for (let i = 0; i < rawArgv.length; i++) {
  const a = rawArgv[i];
  if (a === "--") break;
  if (a !== "--account" && !a.startsWith("--account=")) continue;
  const name = a === "--account" ? rawArgv[i + 1] : a.slice("--account=".length);
  if (!name) fatal("--account needs a name");
  try {
    process.env.FIGMA_ACCOUNT = checkAccountName(name);
  } catch (e) {
    fatal((e as Error).message);
  }
  rawArgv.splice(i, a === "--account" ? 2 : 1);
  i--;
}
const [cmd, ...argv] = rawArgv;

if (cmd === "--version" || cmd === "-v") {
  console.log(version);
  process.exit(0);
}

const ACCOUNT_COMMANDS = new Map([
  ["accounts", { usage: "accounts", description: "List accounts, their Figma login, and which one this directory uses." }],
  ["use", {
    usage: "use <account>",
    description: `Bind this directory (and everything below it) to an account by writing ${CONFIG_FILE}.`,
    details: `Only the nearest ${CONFIG_FILE} applies, so a new one below a project's copies that file's other settings ` +
      "(filesDirs rebased) and only the account changes here.",
  }],
]);
const accountUsage = (name: string) => {
  const c: { usage: string; description: string; details?: string } = ACCOUNT_COMMANDS.get(name)!;
  return `Usage: ${BIN} ${c.usage}\n\n${c.description}${c.details ? `\n${c.details}` : ""}`;
};

/** Account commands only read and write small files: they never start a browser or touch the shared browser state. */
function accountCommand(): boolean {
  if (ACCOUNT_COMMANDS.has(cmd) && wantsHelp({}, argv)) {
    console.log(accountUsage(cmd));
    return true;
  }
  if (cmd === "accounts") {
    if (argv.length) fatal("accounts takes no arguments");
    const current = resolveAccount();
    let exe: string | undefined = process.env.FIGMA_BROWSER_PATH ? expandHome(process.env.FIGMA_BROWSER_PATH) : undefined;
    try {
      exe ??= defaultExecutable();
    } catch {}
    const names = [...new Set([DEFAULT_ACCOUNT, ...listAccounts(), current.name])].sort();
    const accounts = names.map((name) => {
      const profile = exe ? accountProfileDir(name, exe) : undefined;
      return {
        name,
        current: name === current.name,
        loggedIn: profile ? profileHasLoginCookie(profile) : undefined,
        ...readAccountInfo(name),
        profile,
      };
    });
    const source = current.source === "env" ? "FIGMA_ACCOUNT or --account" : current.source === "project" ? current.config!.path : "default";
    console.log(JSON.stringify({ current: current.name, source, accounts }, null, 1));
    return true;
  }
  if (cmd === "use") {
    const names = argv[0] === "--" ? argv.slice(1) : argv;
    if (names.length !== 1) fatal(`usage: ${BIN} use <account>`);
    const name = names[0];
    try {
      checkAccountName(name);
    } catch (e) {
      fatal((e as Error).message);
    }
    const { path, inheritedFrom } = writeProjectAccount(process.cwd(), name);
    const info = readAccountInfo(name);
    console.log(
      `${path}: account "${name}"` +
        (info.email ? ` (${info.email})` : `. Run '${BIN} login' here to sign it in`) +
        ". MCP servers started in this directory pick it up on their next start." +
        (inheritedFrom ? `\nIts other settings (filesDirs...) were copied from ${inheritedFrom}, which it now shadows here.` : ""),
    );
    return true;
  }
  return false;
}

let handled = false;
try {
  handled = accountCommand();
} catch (e) {
  fatal((e as Error).message, 1);
}
if (handled) await quit(0);

// Loading the tools resolves the account and registers this process with the shared browser state, so from here on
// always release before exiting.
const { account, release, tools } = await import("./tools.ts").catch((e) => fatal((e as Error).message, 1));
const byCommand = new Map(tools.map((t) => [commandName(t.name), t]));

function overview() {
  const width = Math.max(...[...byCommand.keys()].map((c) => c.length)) + 2;
  return [
    `${BIN} ${version}: read-only Figma access without plugin or API token.`,
    "",
    `Usage: ${BIN} <command> [args] [options]`,
    `       ${BIN} help <command>`,
    "",
    "Commands:",
    ...[...byCommand].map(([c, t]) => `  ${c.padEnd(width)}${t.description.split(/(?<=\.)\s/)[0]}`),
    "",
    "Accounts:",
    ...[...ACCOUNT_COMMANDS.values()].map((c) => `  ${c.usage.padEnd(width)}${c.description}`),
    "",
    `Every command takes --account <name> to override the account; this directory uses "${account.name}".`,
    "<file> is a local .fig path, a Figma file key, or a figma.com/design/... URL (its node-id is used when --node-id is omitted).",
    "Output is JSON or text on stdout. Images are written to --save-path, or to a temp file, and the path is printed.",
  ].join("\n");
}

async function exit(code: number): Promise<never> {
  await release();
  return quit(code);
}
process.on("SIGINT", () => void exit(130));
process.on("SIGTERM", () => void exit(143));

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  const t = argv[0] ? byCommand.get(argv[0]) : undefined;
  if (argv[0] && !t && !ACCOUNT_COMMANDS.has(argv[0])) {
    console.error(`${BIN}: unknown command ${JSON.stringify(argv[0])}\n\n${overview()}`);
    await exit(2);
  }
  console.log(t ? commandUsage(BIN, t) : argv[0] ? accountUsage(argv[0]) : overview());
  await exit(0);
}

const tool = byCommand.get(cmd);
if (!tool) {
  console.error(`${BIN}: unknown command ${JSON.stringify(cmd)}. Run '${BIN} help' for the list.`);
  await exit(2);
}
if (wantsHelp(tool!.shape, argv)) {
  console.log(commandUsage(BIN, tool!));
  await exit(0);
}

let args: Record<string, unknown>;
try {
  args = parseArgs(tool!.shape, argv);
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(`${BIN} ${cmd}: ${e.message}\nRun '${BIN} help ${cmd}' for usage.`);
  await exit(2);
}

try {
  const result = await tool!.run(args!);
  for (const c of result.content) {
    if (c.type === "text") console.log(c.text);
    else if (!args!.save_path) {
      // The tool already wrote the image when a save path was given; otherwise keep it out of the working directory.
      const path = writePrivateTemp(cmd, c.mimeType.split("/")[1] ?? "bin", Buffer.from(c.data, "base64"));
      console.log(`image written to ${path}`);
    }
  }
  await exit(result.isError ? 1 : 0);
} catch (e) {
  console.error(`${BIN} ${cmd}: ${e instanceof Error ? e.message : String(e)}`);
  await exit(1);
}
