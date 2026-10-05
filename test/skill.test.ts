// skills/figma-reader/SKILL.md is what agents read instead of `help`, so a flag or command it names that the CLI does
// not have costs a failed call and a guess, and agents were seen guessing already. The parts of it a machine can check
// are checked here against the tools themselves: the frontmatter `npx skills add` parses, the version it pins, and
// every command and flag it names.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandName } from "../src/cli-args.ts";

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
  it("has the frontmatter a skill installer reads", () => {
    const front = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    assert.ok(front, "SKILL.md starts with a --- block");
    const fields = new Map(front.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
    assert.equal(fields.get("name"), "figma-reader");
    assert.ok(fields.get("allowed-tools"));
    // A plain YAML scalar ends at ": ", so one inside the description would cut it short or fail to parse.
    const description = fields.get("description") ?? "";
    assert.ok(description.length > 50 && !description.includes(": "), description);
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
    const others = new Set(["help", "accounts", "use"]);
    const named = [
      ...[...skill.matchAll(/`figma-reader ([a-z][a-z-]*)/g)].map((m) => m[1]),
      ...[...section("Output").matchAll(/^\| `([a-z-]+)`/gm)].map((m) => m[1]),
    ];
    assert.ok(named.length > 10);
    for (const c of named) assert.ok(byCommand.has(c) || others.has(c), `SKILL.md names "${c}", which is no command`);
  });

  it("gives each command only flags it takes", () => {
    let checked = 0;
    const takes = (command: string, flags: Iterable<RegExpMatchArray>) => {
      const tool = byCommand.get(command);
      assert.ok(tool, `SKILL.md gives flags to "${command}", which is no command`);
      for (const [flag] of flags) {
        const key = flag.slice(2).replaceAll("-", "_");
        const negated = key.startsWith("no_") && !(key in tool.shape) ? key.slice(3) : undefined;
        assert.ok(key in tool.shape || (negated && negated in tool.shape), `${command} takes no ${flag}`);
        checked++;
      }
    };
    // The Flags section: "- `get-tree`: `--node-id`, `--depth` (default 2); `get-node`: `--node-id`", one command per
    // segment.
    for (const line of section("Flags").split("\n").filter((l) => l.startsWith("- "))) {
      for (const segment of line.slice(2).split("; ")) {
        const m = segment.match(/^`([a-z-]+)[^`]*`: (.*)$/);
        assert.ok(m, `unreadable flags entry: ${segment}`);
        takes(m[1], m[2].matchAll(/--[a-z-]+/g));
      }
    }
    assert.ok(checked > 20, `only ${checked} flags found: did the Flags section change shape?`);
    // And every example call, such as `get-node <file> --node-id <id> --depth 0` in the workflow and the rules.
    for (const m of skill.matchAll(/`(?:figma-reader )?([a-z][a-z-]*) <(?:file|key-or-url)>([^`]*)`/g)) takes(m[1], m[2].matchAll(/--[a-z-]+/g));
    // "Every <file> command but screenshot takes --refresh."
    for (const [name, t] of byCommand) {
      if ("file" in t.shape) assert.equal("refresh" in t.shape, name !== "screenshot", name);
    }
  });
});
