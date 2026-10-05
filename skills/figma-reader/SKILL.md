---
name: figma-reader
allowed-tools: Bash(figma-reader:*) Bash(npx:*)
description: Read Figma designs from the shell with the figma-reader CLI (layer tree, node specs, text, Dev Mode status, what changed, verify cited ids, variables/tokens, styles, components, screenshots) without a Figma plugin or API token. Use when the user shares a figma.com/design URL, a Figma file key, or a .fig file, or asks to implement, inspect, verify or extract tokens from a Figma design.
---

# figma-reader

Read-only CLI: `figma-reader <command> <file> [flags]`. `<file>` is a local `.fig` path, a file key, or a `figma.com/design/...` URL (its `?node-id=` stands in for a missing `--node-id`). Node ids look like `12:34` (`12-34` works).

**Setup, once:** `command -v figma-reader`, else `npx -y @leogcode/figma-reader@0.3.2` in its place. Run it from the project's directory: that picks the project's Figma account. Never send stderr to `/dev/null` on a call whose output you interpret: a hidden error reads as "no results".

## Which command

| To find out | Run |
| --- | --- |
| Pages and their top-level frames | `get-tree <file>`, then `get-tree <file> --node-id <id>` to open one |
| A frame or layer, by name | `search <file> "<name>"` (`--types FRAME`, `--page <p>`, `--exclude-page <p>`, `--regex 'a\|b'`) |
| Where some copy appears | `search <file> "<words>" --include-text --types TEXT` |
| All copy of a frame | `get-text <file> --node-id <id>` |
| Exact specs (size, fills, layout, type) | `get-node <file> --node-id <id> --depth 1` |
| Whether cited ids exist, and where | `locate <file> --node-ids 1:2,3:4` |
| Which frames are Ready for dev | `dev-status <file>` (`--page <p>`) |
| What was added, removed, moved, renamed | `diff <old.fig> <new.fig>`, or `diff previous <key>` (the export before the latest) |
| What was edited recently | `changes <file> --since 7d` (or a date) |
| What it looks like | `screenshot <key-or-url> --node-id <id>` prints a PNG path; open it (needs the key, not a bare path) |
| Tokens, styles, components, images | `get-variables <file> --format css`, `get-styles <file>`, `token-usage <file> --node-id <id>`, `get-components <file>`, `export-image-fills <file> <dir>` |
| Three or more calls | `batch` (below) |

`load-file <file>` summarises a file (pages, counts, collections); rarely needed first.

## Output

JSON on stdout unless marked text; exit 0 ok, 1 failed (message on stderr), 2 bad usage or no account chosen. `D` is the date field (Rules). Keys you need, not every key:

- `get-tree` (**text**: `grep`, not `jq`): line 1 `# {D}`, then `- <id> <TYPE> "<name>" <w>x<h> (<hints>)`, two spaces per level. Hints: `hidden`, `of "<component>"`, a text preview, `ready for dev`, `<n> children` (not opened), `<n> vectors`. A cut branch ends `- ... N more children`; a last line `level N not shown` names the `--max-nodes` that shows it.
- `get-node`: one flat object, no wrapper: `{D, page, path, id, name, type, width, height, fills, layout, component, devStatus?, children[] or childCount}`. On TEXT, `characters` is the string and `text` the **style**.
- `search`: `{D, total, truncated, excludedPages?, results[{id, type, name, page, characters?}]}`; a TEXT hit's string is `characters`, `name` the layer name.
- `get-text`: `{D, total, truncated, unresolvedInstances, text[{id, text, frame?}]}`: `jq -r '.text[] | "\(.id) \(.text)"'`.
- `locate`: `{D, found, missing, invalid, results[{id, found, type?, name?, page?, path?}]}`.
- `dev-status`: `{D, total, neverMarked?, nodes[{id, name, page, status, raw, previous, changedAt}]}`; `neverMarked`: records left out, which `--status any` lists.
- `diff`: `{old{D}, new{D}, counts, byPage, layers{added, removed, renamed, moved}, removedNodes[{id, page, path, removedCount}], truncated}`; `changes`: `{D, total, byPage, layers[{id, name, page, lastEditedAt, created, editedNodes}]}`.
- Any other command, every key and every flag: read `references/output.md` (beside this file) before you parse it.

**batch**: one JSON call per stdin line, `{"tool": "locate", "args": {"file": "<file>", "node_ids": ["1:2", "3:4"]}}`: MCP argument names and types (`node_ids` and `exclude_pages` are arrays, `include_text` a boolean). One decode for all; one line back per call, `{"i": 0, "ok": true, "result": <its JSON, or text as a string>}` or `{"i": 1, "ok": false, "error": "…"}`; exit 1 if any failed, 2 if any was refused for want of an account. Pipe it through `jq` for the fields you need, or into a file you then query: a long answer is cut before you see it.

## Rules

- **Verify every node id you cite** with one `locate` for all of them. `found: false` means absent from that snapshot; exit 1 means the check failed, so the ids are unverified, not gone. To say where a gone id was, `locate` it in the older file or read `diff`'s `removedNodes`. An id with a `/` is text inside an instance: look for it in `get-text --node-id <part before the first />`.
- **Few calls.** Each call decodes the whole file (3–5 s on a large one) and each of your turns re-reads your context, so a call costs far more than its output. Scope with `--node-id`, `--page`, `--types`; put three or more calls in one `batch`; in a long conversation, hand the Figma reading to a subagent with a checklist of what to return (ids, values, date).
- **Date what you report.** A snapshot this tool exported carries `exportedAt`, when it exported it, and `account`: say "as of <time>", never "currently". Keep passing the key; if `exportedAt` changes between your calls, it was exported again in between: say which answers came from which. A file read from disk (a `.fig` path, or a key or URL that a local `<name> [<key>].fig` answers) carries `fileModifiedAt` and no account: the copy's file time, which copying resets, so quote it as the file's time.
- **Account.** If a call exits 2 with "no Figma account chosen", ask the user which account the project uses and pass only that with `--account`; never pick one yourself. If a file is not found or not accessible, say which account was used rather than trying another. If the browser is not logged in, run `figma-reader login`, ask the user to sign in in the window it opens, and retry.
- **What writes.** A `.fig` path (but for `screenshot`) or a key whose cached snapshot is fresh writes nothing. A browser call (export, `screenshot`, `status`, `login`) writes only figma-reader's state, cache and data dirs (browser profile, `account.json`; or the `FIGMA_USER_DATA_DIR` profile), never your working tree; if state or cache is read-only, its error says which. Images go to a private temp file or `--save-path`; `--out-file` and `export-image-fills` write where you say. So use it under "read-only" instructions; if they forbid creating any file, read by path or ask.
- **Dev status:** quote the raw value beside the name until the mapping is confirmed ("marked `BUILD`, read as Ready for dev, on <changedAt>"). `status: none` with `previous` other than `none` is a mark removed at `changedAt`. Never infer readiness from names or pages.
- **diff and changes** compare ids, names, parents and edit times only: an edited text, colour or size shows in neither. Read `byPage` first, then pass `--page <p>` for the page you need, or `--exclude-page` for one that churns.
- A non-zero `unresolvedInstances` means some text is missing from the result (`get-text` names the components in `unresolved`). `get-node` refuses results over 200 KB: lower `--depth`.
