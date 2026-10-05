---
name: figma-reader
allowed-tools: Bash(figma-reader:*) Bash(npx:*)
description: Read Figma designs from the shell with the figma-reader CLI (layer tree, node specs, text, Dev Mode status, what changed, verify cited ids, variables/tokens, styles, components, screenshots) without a Figma plugin or API token. Use when the user shares a figma.com/design URL, a Figma file key, or a .fig file, or asks to implement, inspect, verify or extract tokens from a Figma design.
---

# figma-reader

Read-only CLI: `figma-reader <command> <file> [flags]`. `<file>` is a local `.fig` path, a file key, or a `figma.com/design/...` URL (its `?node-id=` stands in for a missing `--node-id`). Node ids look like `12:34` (`12-34` works).

**Setup, once:** `command -v figma-reader`, else `npx -y @leogcode/figma-reader@0.3.2` in its place. Run it from the project's directory, which picks its Figma account. Never send stderr to `/dev/null` on a call whose output you interpret: a hidden error reads as "no results".

## Which command

| To find out | Run |
| --- | --- |
| Pages and their top-level frames | `get-tree <file>`, then `get-tree <file> --node-id <id>` to open one |
| A frame or layer, by name | `search <file> "<name>"` (`--types FRAME`, `--page <p>`, `--exclude-page <p>`, `--regex 'a\|b'`) |
| Where some copy appears | `search <file> "<words>" --include-text --types TEXT` |
| All copy of a frame | `get-text <file> --node-id <id> --fields id,text` |
| Exact specs (size, fills, layout) | `get-node <file> --node-id <id> --depth 1` |
| Whether cited ids exist, and where | `locate <file> --node-ids 1:2,3:4` |
| Which frames are Ready for dev | `dev-status <file>` (`--page <p>`) |
| What was added, removed, moved, renamed | `diff <old.fig> <new.fig>`, or `diff previous <key>` (the export before the latest) |
| What was edited recently | `changes <file> --since 7d` (or a date) |
| What it looks like | `screenshot <key-or-url> --node-id <id>`: open the PNG path it prints (needs the key) |
| Tokens, styles, components, images | `get-variables <file> --format css`, `get-styles <file>`, `token-usage <file> --node-id <id>`, `get-components <file>`, `export-image-fills <file> <dir>` |
| Three or more calls | `batch` (below) |

`load-file <file>` summarises a file; rarely needed first.

## Output

JSON on stdout unless marked text; exit 0 ok, 1 failed (message on stderr), 2 bad usage or no account chosen. `D` is the date field (Rules). Where `path` does not split on ` / ` into its names, `pathIds` gives an id per name. Keys you need, not every key:

- `get-tree` (**text**: `grep`, not `jq`): line 1 `# {D}`, then `- <id> <TYPE> "<name>" <w>x<h> (<hints>)`, two spaces per level. Hints: `hidden`, `of "<component>"`, a text preview, `ready for dev`, `<n> children` (not opened), `<n> vectors`. A cut branch ends `- ... N more children`; a last `level N not shown` line names the `--max-nodes` that shows it.
- `get-node`: one flat object, no wrapper: `{D, page, path, id, name, type, width, height, fills, layout, component, devStatus?, children[] or childCount}`. On TEXT, `characters` is the string and `text` the **style**.
- `search`: `{D, total, truncated, excludedPages?, results[{id, type, name, page, characters?}]}`; a TEXT hit's string is `characters`, `name` the layer name. `--no-exclude-page` drops the project's default `excludedPages`.
- `get-text`: `{D, total, truncated, byPage?, unresolvedInstances, text[{id, text, frame?}]}`; `--fields id,text` keeps those keys. A whole file's `byPage` has each page's `returned`/`total`; `--page` reads one.
- `locate`: `{D, found, missing, invalid, results[{id, found, type?, name?, page?, path?}]}`.
- `dev-status`: `{D, total, neverMarked?, nodes[{id, name, page, status, raw, previous, changedAt}]}`; `neverMarked`: records left out, which `--status any` lists.
- `diff`: `{old{D}, new{D}, counts, byPage, layers{added, removed, renamed, moved}, removedNodes[{id, page, path, removedCount}], truncated}`; `changes`: `{D, total, byPage, layers[{id, name, page, lastEditedAt, created, editedNodes}]}`.
- Any other command, key or flag: read `references/output.md` (beside this file) first.

**batch**: one JSON call per stdin line, `{"tool": "locate", "args": {"file": "<file>", "node_ids": ["1:2", "3:4"]}}`: MCP argument names, JSON types (`figma-reader help batch` lists the arrays). One decode for all; one line back per call, `{"i": 0, "ok": true, "result": <its JSON, or text as a string>}` or `{"i": 1, "ok": false, "error": "…"}`; exit 1 if any failed, 2 if any was refused for want of an account. Pipe it through `jq`, or into a file you query: a long answer is cut before you see it.

## Rules

- **Verify every node id you cite** with one `locate` for all of them. `found: false` means absent from that snapshot; exit 1 means the check failed, so the ids are unverified, not gone. To say where a gone id was, `locate` it in the older file or read `diff`'s `removedNodes`. An id with a `/` is text inside an instance: look for it in `get-text --node-id <part before the first />`.
- **Few calls.** Each call decodes the whole file (3–5 s if large), and each turn re-reads your context: a call costs far more than its output. Scope with `--node-id`, `--page`, `--types`; put three or more calls in one `batch`; in a long conversation, have a subagent do the Figma reading with a checklist to return (ids, values, date).
- **Date what you report.** An exported snapshot carries `exportedAt` (when) and `account`: say "as of <time>", never "currently". Keep passing the key; if `exportedAt` changes between your calls, it was exported again: say which answers came from which. A file read from disk (a `.fig` path, or a key or URL that a local `<name> [<key>].fig` answers) carries `fileModifiedAt` and no account: the copy's file time, which copying resets, so quote it as the file's time.
- **Account.** If a call exits 2 with "no Figma account chosen", ask the user which account the project uses and pass only that with `--account`; never pick one yourself. If a file is not found or not accessible, say which account was used; never try another. If the browser is not logged in, run `figma-reader login`, ask the user to sign in in its window, and retry.
- **What writes.** A `.fig` path (not for `screenshot`) or a key with a fresh cached snapshot writes nothing. A browser call (export, `screenshot`, `status`, `login`) writes only figma-reader's own state, cache and data dirs, or the `FIGMA_USER_DATA_DIR` profile if set: never your working tree unless that profile is in it. A read-only one is named in the error. Images go to a private temp file or `--save-path`; `--out-file` and `export-image-fills` write where you say. So use it under "read-only" instructions; if they forbid creating any file, read by path or ask.
- **Dev status:** quote the raw value beside the name until the mapping is confirmed ("marked `BUILD`, read as Ready for dev, on <changedAt>"). `status: none` with `previous` other than `none` is a mark removed at `changedAt`. Never infer readiness from names or pages.
- **diff and changes** compare ids, names, parents and edit times only: an edited text, colour or size shows in neither. Read `byPage`, then pass `--page <p>` for the page you need or `--exclude-page` for one that churns.
- A non-zero `unresolvedInstances` means some text is missing from the result (`get-text` names the components in `unresolved`). `get-node` refuses results over 200 KB: lower `--depth`.
