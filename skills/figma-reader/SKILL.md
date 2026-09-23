---
name: figma-reader
allowed-tools: Bash(figma-reader:*) Bash(npx:*)
description: Read Figma designs from the shell with the figma-reader CLI (layer tree, node specs, text, variables/tokens, styles, components, screenshots) without a Figma plugin or API token. Use when the user shares a figma.com/design URL, a Figma file key, or a .fig file, or asks to implement, inspect, or extract tokens from a Figma design.
---

# figma-reader CLI

Read-only access to Figma files. `<file>` is a local `.fig` path, a Figma file key, or a `figma.com/design/...` URL. When a URL carries `?node-id=`, the commands that take `--node-id` use that node unless `--node-id` is given: `get-tree`, `get-node`, `search`, `token-usage`, `get-text`, `screenshot`, `export-image-fills`. A scoped `search` covers that node's subtree and echoes `searchedNode`; `--page` narrows by page instead. `load-file`, `get-variables`, `get-styles` and `get-components` answer about the whole file and ignore a node-id.

Run `figma-reader help` for all commands and `figma-reader help <command>` for a command's options. If it is not on PATH, `npx -y @leogcode/figma-reader@latest <command>` works the same and needs no install; from a clone, `node <repo>/dist/cli.js`. Node 22+, and a Chromium-family browser for anything that reads figma.com.

## Workflow

1. Get an overview: `figma-reader load-file <file>` lists pages, node counts, variable collections, styles and components.
2. Find the frame: `figma-reader get-tree <file> --depth 1`, or `figma-reader search <file> "<name>"` (add `--include-text` to match visible copy too).
3. Read it: `figma-reader get-node <file> --node-id <id> --depth 2` for exact specs (geometry, fills as hex, auto-layout, text styles, bound variables).
4. Look at it: `figma-reader screenshot <key-or-url> --node-id <id>` writes a PNG and prints its path. Open that image to see the design. The image is rendered from the live file in the browser, not from a snapshot, so this is the one command a plain local `.fig` path does not answer: it needs the file key, either in the URL/key you pass or in the file's name (`<name> [<key>].fig`), and fails with exit 1 otherwise.
5. Tokens: `figma-reader get-variables <file> --format css` (or `dtcg`, `json`), `figma-reader get-styles <file>`. If the file defines no variables or styles, use `figma-reader token-usage <file> --node-id <id>`.
6. Copy: `figma-reader get-text <file> --node-id <id>` returns every string in reading order, including text inside component instances.

## Rules

- Output is JSON or text on stdout; pipe JSON into `jq` to keep it short. Exit code 1 means the call failed (message on stderr), 2 means bad usage.
- Keep `get-node` depth low (1 or 2) on large frames; it refuses results over 200 KB.
- Node ids look like `12:34`; `12-34` from URLs works too.
- `search` queries are case-insensitive literal substrings, so a name with slashes or brackets (`Icons/Arrow/Left`, `/Card [v2]/`) finds itself. Add `--regex` to read the query as a pattern instead, bare or `/pattern/flags` for per-query flags, where an invalid pattern is an error, and `--case-sensitive` to match case. `queryAs` in the result says how the query was read.
- Calls that need figma.com (a key or URL with no local `.fig`) start a headless browser and take tens of seconds. Exported snapshots are cached for 30 minutes, so later calls on the same file are fast. `--refresh` forces a new export, one that begins after you ask for it; on a path to a `.fig` there is nothing to export from, so it is ignored and the result says `refreshIgnored: true`.
- A result that carries a date names it after what it dates. `exportedAt` is when this tool exported that snapshot through the browser: say when the design was read ("as of 14:03") rather than calling what you report current, since after the user edits the file that time is how they tell a cached snapshot from an answer you invented. A `.fig` the user supplied carries `fileModifiedAt` instead — that copy's file time, which copying, syncing or re-downloading resets, so the design can be older than it says. Quote it as the file's time, never as when the design was read.
- Only `load-file`, `get-node`, `search`, `get-components`, `token-usage` and `get-text` carry either field. `get-tree`, `get-variables`, `get-styles` and `export-image-fills` carry none, so do not date what they tell you: take the time from a `load-file` on the same file, or say it is unknown.
- Each project uses one Figma account, set in `.figma-reader.json` (see `figma-reader accounts`). Do not pass `--account` or edit that file unless the user asks: it switches whose login and files you see.
- If a call reports that the browser is not logged in, run `figma-reader login` and ask the user to sign in in the window it opens, then retry. If a file is not found or not accessible, the project's account may lack access: tell the user which account is in use rather than trying another.
- `get-text` always reports `unresolvedInstances`, and `search --include-text` reports it when the text pass actually ran — a `--types` list without TEXT turns the pass off, and then the field is absent rather than 0. A non-zero value means some text is missing from the result; `get-text` names the components it is missing in `unresolved`.
