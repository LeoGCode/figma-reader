// skills/figma-reader/SKILL.md is what agents read instead of `help`, so a flag or command it names that the CLI does
// not have costs a failed call and a guess, and agents were seen guessing already. The parts of it a machine can check
// are checked here against the tools themselves: the frontmatter `npx skills add` parses, the version it pins, and
// every command and flag it names.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { commandName, parseArgs, positionals, UsageError } from "../src/cli-args.ts";

const root = mkdtempSync(join(tmpdir(), "figma-reader-skill-"));
mkdirSync(join(root, "home"));
// Importing the tools resolves an account and registers with the shared browser state: all of it goes into the temp
// dir, as in tools.test.ts, and no browser can be started.
process.env.HOME = join(root, "home");
process.env.USERPROFILE = join(root, "home");
process.env.APPDATA = join(root, "home", "AppData", "Roaming");
process.env.LOCALAPPDATA = join(root, "home", "AppData", "Local");
process.env.FIGMA_ACCOUNT = "skill-test";
process.env.FIGMA_READER_CACHE = join(root, "cache");
process.env.FIGMA_FILES_DIRS = root;
process.env.FIGMA_BROWSER_PATH = join(root, "no-such-browser");
for (const k of ["FIGMA_CDP_URL", "FIGMA_USER_DATA_DIR", "FIGMA_SNAPSHOT_MAX_AGE_MIN"]) delete process.env[k];
const { release, tools } = await import("../src/tools.ts");
after(async () => {
  await release();
  rmSync(root, { recursive: true, force: true });
});

const repo = join(import.meta.dirname, "..");
const skill = readFileSync(join(repo, "skills", "figma-reader", "SKILL.md"), "utf8");
const byCommand = new Map(tools.map((t) => [commandName(t.name), t]));
/** The section under a "## " heading, up to the next one. */
const section = (title: string) => skill.split(/^## /m).find((s) => s.startsWith(`${title}\n`)) ?? "";

describe("the agent skill", () => {
  it("keeps its frontmatter to one-line `key: plain value` pairs of the keys a skill declares", () => {
    // Not a YAML parser: the frontmatter is held to the small subset of YAML it uses, which every parser reads alike.
    // Anything outside it - a flow sequence, a quoted or block scalar, a comment, a second line - fails here, where it
    // would otherwise first fail in someone's installer.
    const front = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    assert.ok(front, "SKILL.md starts with a --- block");
    const fields = new Map<string, string>();
    for (const line of front.split("\n")) {
      const m = line.match(/^([a-z-]+): (\S(?:.*\S)?)$/);
      assert.ok(m, `not a one-line key: value pair: ${JSON.stringify(line)}`);
      const [, key, value] = m;
      assert.ok(["name", "description", "allowed-tools"].includes(key) && !fields.has(key), `unexpected or repeated key ${key}`);
      // A plain scalar: opened by no indicator, holding nothing that would end it (": ") or comment it out (" #").
      assert.ok(!/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) && !/: | #|:$|\t/.test(value), `${key} is not a plain scalar: ${value}`);
      fields.set(key, value);
    }
    assert.equal(fields.get("name"), "figma-reader", "the name is the skill's directory name");
    // 1024 characters is the Agent Skills limit on a description.
    const description = fields.get("description") ?? "";
    assert.ok(description.length > 50 && description.length <= 1024, `description of ${description.length} characters`);
    // Claude Code's tool rules, space separated: Bash(<command>:*).
    const rules = fields.get("allowed-tools")?.split(" ") ?? [];
    assert.ok(rules.length);
    for (const rule of rules) assert.match(rule, /^Bash\([a-z][a-z-]*:\*\)$/);
  });

  it("pins the version it describes", () => {
    // A pin older than the package would run a CLI without the commands the skill documents; @latest can change
    // between two calls of one task.
    const { version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    const pins = [...skill.matchAll(/@leogcode\/figma-reader@([^\s`)]+)/g)].map((m) => m[1]);
    assert.ok(pins.length, "the skill names a pinned npx fallback");
    assert.deepEqual(new Set(pins), new Set([version]), "update the npx pin in SKILL.md to the package version");
  });

  it("names only commands the CLI has", () => {
    // Commands of the CLI that are not tools: help, the account commands, and batch, which runs tools.
    const others = new Set(["help", "accounts", "use", "batch"]);
    const named = [
      ...[...skill.matchAll(/`figma-reader ([a-z][a-z-]*)/g)].map((m) => m[1]),
      ...[...section("Output").matchAll(/^\| `([a-z-]+)`/gm)].map((m) => m[1]),
    ];
    assert.ok(named.length > 10);
    for (const c of named) assert.ok(byCommand.has(c) || others.has(c), `SKILL.md names "${c}", which is no command`);
  });

  // Every check below asks the CLI's own parser, so what passes here is what `figma-reader` accepts: a reading of the
  // schemas written for this test once let `--no-depth` through, which the parser refuses since depth is no switch.
  it("gives each command in its flags list only flags it takes, with values it takes", () => {
    // "- `get-tree`: `--node-id`, `--depth` (default 2); `get-node`: `--node-id`", one command per segment.
    let checked = 0;
    for (const line of section("Flags").split("\n").filter((l) => l.startsWith("- "))) {
      for (const segment of line.slice(2).split("; ")) {
        const m = segment.match(/^`([a-z-]+)[^`]*`: (.*)$/);
        assert.ok(m, `unreadable flags entry: ${segment}`);
        for (const [, flag, values] of m[2].matchAll(/`(--[a-z-]+)(?: ([^`]+))?`/g)) {
          assert.equal(flagError(m[1], flag, values), undefined, `${m[1]} ${flag}${values ? ` ${values}` : ""}`);
          checked++;
        }
      }
    }
    assert.ok(checked > 20, `only ${checked} flags found: did the Flags section change shape?`);
    // "Every <file> command but screenshot takes --refresh."
    for (const [name, t] of byCommand) {
      if ("file" in t.shape) assert.equal(flagError(name, "--refresh") === undefined, name !== "screenshot", name);
    }
  });

  it("writes every example call so that the CLI parses it", () => {
    // `get-node <file> --node-id <id> --depth 0` in a rule, and `search --include-text`, which leaves its positionals
    // out: a command word followed by a <file> or a flag. Placeholders become "1", which every argument takes.
    let checked = 0;
    for (const [, span] of skill.matchAll(/`([^`\n]+)`/g)) {
      const words = (span.match(/<[^>]*>|"[^"]*"|'[^']*'|\S+/g) ?? []).filter((w, i) => i || w !== "figma-reader");
      const [command, next] = words;
      if (!/^[a-z][a-z-]*$/.test(command) || !next || !(next.startsWith("--") || ["<file>", "<key-or-url>"].includes(next))) continue;
      const args = words.slice(1).map((w) => w.replace(/^(["'])(.*)\1$/, "$2")).map((w) => (/^<.*>$/.test(w) ? "1" : w));
      const argv = next.startsWith("--") && byCommand.has(command) ? [...stand(command), ...args] : args;
      assert.equal(usageError(command, argv), undefined, `\`${span}\``);
      checked++;
    }
    assert.ok(checked >= 10, `only ${checked} example calls found`);
  });

  it("names in prose only flags some command takes", () => {
    // "Scope with `--node-id`, `--page`, `--types`": not tied to one command, but each must be an option of one. The
    // value it would want does not matter here, only that the parser does not call it an unknown option.
    // --account is taken by every command before its own options are parsed (cli.ts), so no tool's schema has it.
    for (const [, flag] of skill.matchAll(/`(--[a-z-]+)/g)) {
      if (flag === "--account") continue;
      const known = (c: string) => !usageError(c, [...stand(c), flag])?.startsWith(`unknown option ${flag}`);
      assert.ok([...byCommand.keys()].some(known), `no command takes ${flag}`);
    }
  });
});

/** What the CLI's parser says to `figma-reader <command> <argv>`: undefined when it parses, else its complaint. */
function usageError(command: string, argv: string[]): string | undefined {
  const tool = byCommand.get(command);
  if (!tool) return `"${command}" is no command`;
  try {
    parseArgs(tool.shape, argv);
    return undefined;
  } catch (e) {
    if (e instanceof UsageError) return e.message;
    throw e;
  }
}

/**
 * Stand-ins for what a command requires, so a flag can be tried alone: its positionals (<file>, then <query> or
 * <out_dir>), and a required argument that is a flag rather than a positional, as locate's --node-ids is.
 */
function stand(command: string): string[] {
  const shape = byCommand.get(command)!.shape;
  const pos = positionals(shape);
  const required = (z.toJSONSchema(z.object(shape)) as { required?: string[] }).required ?? [];
  const flags = required.filter((k) => !pos.includes(k)).flatMap((k) => [`--${k.replaceAll("_", "-")}`, "1"]);
  return [...pos.map(() => "1"), ...flags];
}

/**
 * Whether `command` takes `flag`, as the parser says: each value the skill writes for it ("json|css|dtcg"), or else
 * as a switch or with "1", which every string, number and list option takes.
 */
function flagError(command: string, flag: string, values?: string): string | undefined {
  if (!byCommand.has(command)) return `"${command}" is no command`;
  if (values && !values.startsWith("<")) {
    for (const v of values.split("|")) {
      const error = usageError(command, [...stand(command), flag, v]);
      if (error) return error;
    }
    return undefined;
  }
  const alone = usageError(command, [...stand(command), flag]);
  return alone && usageError(command, [...stand(command), flag, "1"]) && alone;
}
