// Command-line parsing for the CLI, derived from each tool's zod shape so the CLI and the MCP server never drift apart.
// Kept free of side effects (no browser, no cache) so it can be tested on its own.
import { z } from "zod";

export class UsageError extends Error {}

interface Prop {
  type?: string;
  enum?: string[];
  description?: string;
  items?: { type?: string };
}

/** figma_get_tree -> get-tree */
export const commandName = (tool: string) => tool.replace(/^figma_/, "").replaceAll("_", "-");
const flagName = (key: string) => `--${key.replaceAll("_", "-")}`;
// Values accepted by --flag=value on booleans; anything else is a usage error rather than a guess.
const TRUE = /^(1|true|yes|on)$/i;
const FALSE = /^(0|false|no|off)$/i;

function schemaOf(shape: z.ZodRawShape) {
  const js = z.toJSONSchema(z.object(shape)) as { properties?: Record<string, Prop>; required?: string[] };
  return { props: js.properties ?? {}, required: js.required ?? [] };
}

/** Required string arguments are positional, in declaration order: <file>, then <query> or <out_dir>. */
export function positionals(shape: z.ZodRawShape): string[] {
  const { props, required } = schemaOf(shape);
  return required.filter((k) => props[k]?.type === "string");
}

/**
 * Whether argv asks for usage rather than a run: --help or -h as an option of its own. Not after a "--" (there they
 * are values, e.g. a search for "--help"), and not where a flag that takes a value expects one: `--page --help` used
 * to print usage instead of looking for the page.
 */
export function wantsHelp(shape: z.ZodRawShape, argv: string[]): boolean {
  const { props } = schemaOf(shape);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") return false;
    if (a === "--help" || a === "-h") return true;
    if (!a.startsWith("--") || a.includes("=")) continue;
    const p = props[a.slice(2).replaceAll("-", "_")];
    if (p && p.type !== "boolean") i++;
  }
  return false;
}

/**
 * Parse argv into tool arguments. Flags are the argument names in kebab-case (--node-id 1:2 or --node-id=1:2),
 * booleans take no value (--refresh, --no-refresh) or an explicit --refresh=true|false (also 1/0, yes/no, on/off),
 * arrays repeat or take commas (--types FRAME,TEXT), and --json '{...}' merges raw arguments: a list adds to the one
 * the flags build, whichever side of --json they are written on, and everything else replaces what came before it.
 * The result is validated against the tool's schema.
 */
export function parseArgs(shape: z.ZodRawShape, argv: string[]): Record<string, unknown> {
  const { props } = schemaOf(shape);
  const pos = positionals(shape);
  const out: Record<string, unknown> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const flag = eq < 0 ? a : a.slice(0, eq);
    const inline = eq < 0 ? undefined : a.slice(eq + 1);
    let key = flag.slice(2).replaceAll("-", "_");
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    if (key === "json") {
      let raw: unknown;
      try {
        raw = JSON.parse(value());
      } catch (e) {
        throw new UsageError(`--json: ${(e as Error).message}`);
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UsageError("--json takes a JSON object");
      for (const [k, v] of Object.entries(raw)) {
        // Object.assign dropped what --types had already collected, while the other order accumulated: a list adds
        // up whichever side of --json its flags are on.
        const prev = out[k];
        out[k] = props[k]?.type === "array" && Array.isArray(prev) && Array.isArray(v) ? [...prev, ...v] : v;
      }
      continue;
    }
    let negate = false;
    if (!props[key] && key.startsWith("no_") && props[key.slice(3)]?.type === "boolean") {
      key = key.slice(3);
      negate = true;
    }
    const p = props[key];
    if (!p) throw new UsageError(`unknown option ${flag}`);
    if (p.type === "boolean") {
      if (negate && inline !== undefined) throw new UsageError(`${flag} takes no value`);
      const on = inline === undefined || TRUE.test(inline);
      if (!on && !FALSE.test(inline!)) throw new UsageError(`${flag} takes true/false, got ${JSON.stringify(inline)}`);
      out[key] = negate ? false : on;
    } else if (p.type === "integer" || p.type === "number") {
      const v = value();
      const n = Number(v);
      if (v.trim() === "" || !Number.isFinite(n)) throw new UsageError(`${flag} takes a number, got ${JSON.stringify(v)}`);
      out[key] = n;
    } else if (p.type === "array") {
      const items = value().split(",").map((s) => s.trim()).filter(Boolean);
      // An empty list would filter out everything (--types= matched nothing) rather than mean "any".
      if (!items.length) throw new UsageError(`${flag} needs at least one value`);
      // Whatever --json seeded is added to, so it has to be a list: a number threw a raw TypeError out of the CLI,
      // and a string was spread into its characters and then searched for as ["F","R","A","M","E"].
      const prior = out[key] as unknown[] | undefined;
      if (prior !== undefined && !Array.isArray(prior)) throw new UsageError(`${flag} takes a list; --json set ${key} to ${JSON.stringify(prior)}`);
      out[key] = [...(prior ?? []), ...items];
    } else {
      out[key] = value();
    }
  }
  // Positionals fill the slots no flag or --json already set, in order.
  const open = pos.filter((k) => out[k] === undefined);
  if (rest.length > open.length) throw new UsageError(`unexpected argument ${JSON.stringify(rest[open.length])}`);
  rest.forEach((v, i) => {
    out[open[i]] = v;
  });
  const missing = pos.filter((k) => out[k] === undefined);
  if (missing.length) throw new UsageError(`missing ${missing.map((k) => `<${k}>`).join(" ")}`);
  const parsed = z.object(shape).strict().safeParse(out);
  if (!parsed.success) throw new UsageError(z.prettifyError(parsed.error));
  return parsed.data;
}

const wrap = (s: string, width: number, indent: string) => {
  const lines: string[] = [];
  let line = "";
  for (const word of s.split(/\s+/).filter(Boolean)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
};

export function commandUsage(bin: string, tool: { name: string; description: string; shape: z.ZodRawShape }): string {
  const { props } = schemaOf(tool.shape);
  const pos = positionals(tool.shape);
  const opts = Object.entries(props)
    .filter(([k]) => !pos.includes(k))
    .map(([k, p]) => {
      const kind = p.type === "boolean" ? "" : p.enum ? ` <${p.enum.join("|")}>` : p.type === "array" ? ` <${p.items?.type ?? "value"},...>` : ` <${p.type === "integer" ? "n" : p.type}>`;
      return [`${flagName(k)}${kind}`, p.description ?? ""];
    });
  // --json is always there, so a command without options of its own still gets a header and an aligned column.
  opts.push(["--json <object>", "Raw arguments as JSON (names as in the MCP tool)"]);
  const col = Math.min(32, Math.max(...opts.map(([f]) => f.length)) + 2);
  const lines = [
    `Usage: ${bin} ${commandName(tool.name)}${pos.map((k) => ` <${k}>`).join("")} [options]`,
    "",
    wrap(tool.description, 100, ""),
  ];
  for (const k of pos) if (props[k]?.description) lines.push("", `<${k}>  ${wrap(props[k].description!, 94, "  ")}`);
  lines.push("", "Options:");
  for (const [f, d] of opts) lines.push(`  ${f.padEnd(col)}${f.length >= col ? `\n  ${" ".repeat(col)}` : ""}${wrap(d, 96 - col, " ".repeat(col + 2))}`.trimEnd());
  return lines.join("\n");
}
