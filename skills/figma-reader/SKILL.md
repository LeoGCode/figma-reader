---
name: figma-reader
allowed-tools: Bash(figma-reader:*) Bash(npx:*)
description: Read Figma designs from the shell with the figma-reader CLI (layer tree, node specs, text, variables/tokens, styles, components, screenshots) without a Figma plugin or API token. Use when the user shares a figma.com/design URL, a Figma file key, or a .fig file, or asks to implement, inspect, or extract tokens from a Figma design.
---

# figma-reader CLI

Read-only access to Figma files: `figma-reader <command> <file> [flags]`. `<file>` is a local `.fig` path, a Figma file key, or a `figma.com/design/...` URL, whose `?node-id=` stands in for a missing `--node-id`. Node 22+, and a Chromium-family browser for anything that reads figma.com.

**Setup, once:** `command -v figma-reader`. If it is missing, use `npx -y @leogcode/figma-reader@0.3.2` (the version this skill describes) or a clone's `node <repo>/dist/cli.js` in its place. Never send stderr to `/dev/null` on a call whose output you will interpret: a hidden "command not found" reads as zero results.

## Workflow

1. `load-file <file>`: pages with ids, node counts, variable collections, styles, components.
2. Find the frame: `get-tree <file> --depth 1`, or `search <file> "<name>"` (`--include-text` matches copy too).
3. Specs: `get-node <file> --node-id <id> --depth 2`.
4. Look: `screenshot <key-or-url> --node-id <id>` prints a PNG's path; open it. It renders the live file, so it needs the key, in what you pass or in the file's name (`<name> [<key>].fig`); a plain `.fig` path exits 1.
5. Tokens: `get-variables <file> --format css` (or `dtcg`, `json`), `get-styles <file>`; for a file with neither, `token-usage <file> --node-id <id>`.
6. Copy: `get-text <file> --node-id <id>`, in reading order, instance text included.

## Output

JSON on stdout unless marked text. Shapes name the keys you need, not every key; one that does not apply is absent. `D` is `exportedAt` or `fileModifiedAt` (see Rules). Exit 0 is success, 1 a failed call (`figma-reader <command>: <message>` on stderr), 2 bad usage.

| Command | Shape |
| --- | --- |
| `load-file` | `{name, key?, source: "local"\|"web", path? or snapshotPath?, D, pages[{id, name, topLevelNodes}], nodeCounts, variableCollections, styles, components}` |
| `get-tree` | **Text**: `- <id> <TYPE> "<name>" <w>x<h> (<hints>)`, two spaces of indent per level; hints include `<n> children` where depth stopped. Past `--max-nodes` the last line is `... truncated at <n> nodes`. Use `grep`, not `jq`. |
| `get-node` | One flat object, no wrapper: `{D, page, path: "Page / Frame / Layer", id, name, type, x, y, width, height, fills[{type, color, variable?}], layout{mode, gap, padding[t,r,b,l]}, component{mainComponent, mainComponentId, properties}, boundVariables, children[…] or childCount}`. On TEXT, `characters` is the string and `text` the **style** (`fontFamily`, `fontSize`, …). |
| `search` | `{D, queryAs, returned, total, truncated, unresolvedInstances?, results[{id, type, name, page, characters?, charactersTruncated?, via?, component?, frame?}]}`. The string is `characters` (cut at 120 chars when `charactersTruncated`); `name` is the layer name. |
| `get-text` | `{D, returned, total, truncated, unresolvedInstances, unresolved?, text[{id, name, text, via, component?, frame?}]}`: `jq -r '.text[].text'` |
| `get-variables` | json: `[{name, modes, defaultMode, variables[{name, type, values{<mode>: {value} or {alias, resolved}}}]}]`; css: a `:root` stylesheet; dtcg: `{<collection>: {<mode>: {…: {$type, $value}}}}` |
| `get-styles` | json: `[{name, type, value}]`; css: a stylesheet |
| `get-components` | `{D, componentSets[{id, name, variants[{id, name, instances, swapInstances}]}], components[{id, name, instances, swapInstances}], libraryComponentsUsed[{name, instances, swapInstances}]}` |
| `token-usage` | `{D, colors, typography, cornerRadii, gaps, paddings, strokeWidths, effects}`, lists of `{value (typography: font fields), count, variables?, styles?}` |
| `screenshot` | Text: `image written to <path>`, then `node <id>: <w>x<h>`; with `--save-path`, one line ending `saved to <path>` |
| `export-image-fills` | `[{hash, path, bytes, usedBy}]`; `{hash, missing: true, usedBy}` where the export lacks the image |

With `--out-file`, `get-variables` and `get-styles` print `(written to <path>)` after the body: read the file.

## Flags

Lists take commas (`--types FRAME,TEXT`), booleans are bare; `figma-reader help <command>` has the rest. Every `<file>` command but `screenshot` takes `--refresh`.

- `get-tree`: `--node-id`, `--depth` (default 2), `--max-nodes` (400); `get-node`: `--node-id`, `--depth` (3)
- `search <file> <query>`: `--include-text`, `--types`, `--page <name>`, `--node-id` (that subtree), `--regex`, `--case-sensitive`, `--include-hidden`, `--limit` (50)
- `get-text`: `--node-id`, `--include-hidden`, `--limit` (500); `token-usage`: `--node-id`, `--include-hidden`, `--min-count`
- `get-variables`: `--format json|css|dtcg`, `--collection`, `--no-include-remote`, `--out-file`; `get-styles`: `--type FILL|STROKE|TEXT|EFFECT|GRID`, `--format json|css`, `--out-file`; `get-components`: `--query`
- `screenshot`: `--node-id`, `--save-path`, `--max-dimension` (1568); `export-image-fills <file> <out_dir>`: `--node-id`

## Rules

- **Verify every node id you cite**, each one: `get-node <file> --node-id <id> --depth 0` gives its `page` and `path`. Exit 1 with `node <id> not found` on stderr means absent; any other failure means the check failed, so report the id as unverified, not gone. An id with a `/` (`get-text`, `search` text hits) is text inside an instance: verify the part before the first `/`.
- **Few calls, tight filters.** Each CLI call decodes the file again, 3-5 s on a 67 MB file. Scope with `--node-id`, `--page`, `--types`; find several names at once with `--regex 'Login|Sign up'`. For many reads prefer the `figma_*` MCP tools if loaded: the server decodes once. In a long conversation, delegate the Figma reading to a subagent with a checklist of what to return (ids, values, date): each call there re-reads the whole context.
- **One snapshot per task.** A key or URL reads a snapshot cached for 30 minutes; the first call after that exports again, and you can end up quoting two versions as one. After `load-file`, pass its `snapshotPath` (`path` for a local copy) instead of the key: a path is never exported again, and is dated `fileModifiedAt`, the time `exportedAt` gave. Another export of the key (after 30 minutes, or `--refresh`) replaces the file; a changed `fileModifiedAt` shows it.
- An export starts a headless browser on figma.com and takes tens of seconds. `--refresh` forces one begun after you ask; on a `.fig` path it is ignored (dated results say `refreshIgnored: true`).
- Keep `get-node` depth low (1 or 2) on large frames; it refuses results over 200 KB. Node ids look like `12:34`; `12-34` works too.
- `search` matches a case-insensitive literal substring, so `Icons/Arrow/Left` and `/Card [v2]/` find themselves. `--regex` reads a pattern, bare or `/pattern/flags` (invalid is an error); `--case-sensitive` matches case; `queryAs` says which.
- `exportedAt` is when this tool exported the snapshot: say when the design was read ("as of 14:03"), not that it is current; after the user edits the file, that time is how they tell a cached snapshot from an invention. A `.fig` the user supplied carries `fileModifiedAt`, the copy's file time, which copying or syncing resets: quote it as the file's time, never as when the design was read. Only `load-file`, `get-node`, `search`, `get-components`, `token-usage` and `get-text` are dated; date the rest by a `load-file` on the same file, or say the time is unknown.
- Each project uses one Figma account, set in `.figma-reader.json` (see `figma-reader accounts`). Do not pass `--account` or edit that file unless the user asks: it switches whose login and files you see.
- If a call says the browser is not logged in, run `figma-reader login`, ask the user to sign in in the window it opens, and retry. If a file is not found or not accessible, the project's account may lack access: tell the user which account is in use rather than trying another.
- A non-zero `unresolvedInstances` means text is missing; `get-text` names the components in `unresolved`. `get-text` always reports it, `search --include-text` only when its text pass ran (a `--types` list without TEXT turns it off).
