# figma-reader

[![CI](https://github.com/LeoGCode/figma-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/LeoGCode/figma-reader/actions/workflows/ci.yml)

Read-only Figma access for AI agents and people. **No Figma plugin, no API token, no Dev Mode seat, no Enterprise plan.**

It ships in two forms that share the same tools and code. Use whichever fits:

| | Command | Best for |
| --- | --- | --- |
| **MCP server** | `figma-reader-mcp` | MCP clients (Claude Code, Claude Desktop, Cursor, ...). One long-lived process keeps decoded files in memory and the browser and editor tab warm, so repeated calls are fast |
| **CLI** | `figma-reader` | Shells, scripts, CI, and agents that prefer running commands over loading MCP tools. Nothing to register; output is JSON/text on stdout. Each call decodes the file again, seconds on a large one |

Two ways to feed it:

- **Local `.fig` file** (File › Save local copy in Figma, then pass the path). Fully offline, no browser. Everything except screenshots.
- **Figma file key / URL**. It drives figma.com in a **headless** Chromium-family browser over the DevTools protocol, and shows a visible window only when you need to log in:

| Data | How |
| --- | --- |
| Document tree, variables, styles, components, text, image fills | **File › Save local copy** (triggered via Quick actions) → `.fig` → decoded locally (kiwi schema is embedded in the file, so it survives Figma format changes) |
| Screenshots | **Copy as PNG** on the node; the PNG is intercepted in the page, the system clipboard is never touched |
| Recent files, account | Figma's internal web API with the browser's session cookies |

Variables come straight out of the file, so modes, aliases and scopes are available on any plan (the REST variables endpoint is Enterprise-only).

## Install

Pick the line for how you want to use it. Everything below needs Node 22+, and a Chromium-family browser only for the calls that read figma.com.

| You want | Run |
| --- | --- |
| The CLI on your PATH | `npm install -g @leogcode/figma-reader` |
| To try it without installing | `npx -y @leogcode/figma-reader@latest help` |
| An agent that knows how to drive it | `npx skills add https://github.com/LeoGCode/figma-reader --skill figma-reader` |
| The MCP server in one project | `claude mcp add --scope project figma-reader -- npx -y @leogcode/figma-reader@latest figma-reader-mcp` |
| To work on it | `git clone https://github.com/LeoGCode/figma-reader && cd figma-reader && npm install && npm run build` |

The skill line writes `.agents/skills/figma-reader/` and registers it for Claude Code and the other agents that read that directory; it teaches the CLI, so it pairs with either of the first two lines. [`skills/figma-reader/SKILL.md`](skills/figma-reader/SKILL.md) is the file, if you would rather copy it in by hand or paste it into an `AGENTS.md`.

First run on a file key or URL will say it is not logged in and open a normal browser window on the Figma login page. Log in there; the window closes itself and everything after that is headless. `figma-reader login --wait-seconds 300` does the same deliberately and waits for you.

Working with more than one Figma login is the same two commands in each directory:

```sh
cd ~/work/acme && figma-reader use client-acme && figma-reader login
```

`use` writes `.figma-reader.json`, which binds that directory and everything below it to its own browser profile and snapshot cache, so accounts never see each other's sessions or files. Nothing is created on disk until you log in. See [Accounts](#accounts-one-figma-login-per-project).

## Tools

MCP tool names and CLI commands map one to one: `figma_get_tree` is `figma-reader get-tree`.

| Tool | Purpose |
| --- | --- |
| `figma_status` | Account, browser mode, running browser, logged-in user. `loggedIn` is `"unknown"`, not a boolean, when figma.com could not be asked — a network error, a 5xx or a dead browser is reported rather than guessed as "not logged in". `account` is `{ "name", "source" }`, and `webCallsRefused` says why calls through figma.com would be refused, when they would (see [Accounts](#accounts-one-figma-login-per-project)). **Changed after 0.3.2:** `account` used to be the name as a string, with the source in a separate `accountSource` field, which is gone |
| `figma_login` | Open the visible login window / wait for login. Its JSON answers carry `account` as `{ "name", "source" }`, a change after 0.3.2 like `figma_status`'s (previously a string, plus `accountSource`) |
| `figma_list_files` | Local `.fig` files or recently viewed files. Always an envelope: `returned` / `total` / `truncated` (default limit 30), `searchedDirs` for a local listing, `totalUnfiltered` when `query` left files out |
| `figma_load_file` | Export + decode, summary (pages, counts, collections, styles). For a snapshot exported through the browser, `snapshotPath` is its `.fig` in the cache, which the next export of the key replaces. Read by that path it is never exported again, but it is dated `fileModifiedAt` and names no account, like any local file: for one task's calls, keep passing the key and say so if `exportedAt` changes between them |
| `figma_get_tree` | Compact layer outline, under a one-line `# {...}` header that dates it (and names the account, for a key or URL). `max_nodes` (default 400) goes to one level before the next (pages, then top-level layers, then what is under them), shared evenly between the parents on a level, so a large first section cannot crowd out later pages; a branch cut short ends in `- ... N more children`, a layer with none of its children shown says `(N children)`, and the last line says it was truncated. A level that cannot give each of its layers a line is left out whole, and the last line says which and what would show it, e.g. `... level 2 not shown: 162 layers have children, 214 of 400 lines left; open one with node_id, or pass max_nodes 494`. A layer drawn only with vector shapes is one line counting them, `(27 vectors)`; its `node_id` lists them. A node's Dev Mode status is a hint (`ready for dev`, `completed`, `was ready for dev`) |
| `figma_get_node` | Normalized design data: geometry, fills/strokes/effects, auto-layout, text runs, instance props, bound variables, style names. Dev Mode handoff data where a node has it: `devStatus` (as `figma_dev_status` reports it; absent for a never-marked record, `none` and previously `none` with no user or note), `annotations` (label as markdown, category, pinned properties) and `measurements` (from/to node ids and sides) |
| `figma_locate` | Look up a list of `node_ids` in one call: per id, in order, `{id, found: true, type, name, page, path}`, `{id, found: false}`, or `{id, error}` for a string that is not a node id (`12-34` is read as `12:34`). `found` / `missing` / `invalid` count them. An id the file does not have is an answer, not a failed call |
| `figma_search` | Find nodes by name / text; with `include_text` the text rendered inside component instances is matched too, each hit tagged with `via` and whichever of `component` / `variant` / `frame` apply. The query is a case-insensitive literal substring: `Icons/Arrow/Left` and `/Card [v2]/` find the layers named that. `regex: true` reads it as a pattern instead, bare or `/pattern/flags`, and an invalid pattern is an error; `case_sensitive: true` matches case. The result's `queryAs` says which was used. A hit's `characters` is a preview, the first 120 characters followed by `...` and flagged `charactersTruncated` (`truncated` beside it counts results, not characters). A `types` list without TEXT turns `include_text` off, and `unresolvedInstances` is there only when the text pass ran. `node_id` (or a `node-id` in the URL) searches only that node's subtree and is echoed back as `searchedNode`. `exclude_pages` (CLI `--exclude-page`, repeatable) skips pages by name before the limit, so their hits neither fill it nor count in `total`; without it, and without `page` or `node_id`, the project's `excludePages` applies, and `exclude_pages: []` searches every page. The result names the pages skipped in `excludedPages`, and the project file in `excludedPagesFrom` when they came from it |
| `figma_get_variables` | Collections, modes, values, resolved aliases; `json`, `css`, `dtcg`. A file that defines none answers empty in the requested format; a `collection` no collection has is an error listing the ones it has |
| `figma_get_styles` | FILL, STROKE, TEXT, EFFECT and GRID styles; `json`, `css`. No styles, or none of the type asked for, answers empty in the requested format |
| `figma_get_components` | Local components, variant sets, and `libraryComponentsUsed` as a third list. Counts are per variant: `instances` (placed directly) and `swapInstances` (swapped into an instance by an override or instance-swap property). Internal-only pages are left out of the three lists but not out of the counts |
| `figma_dev_status` | Dev Mode status: nodes marked Ready for dev or Completed, and those unmarked since, newest change first, each with `page`, `path` and `status` / `raw` / `previous` / `previousRaw` / `changedAt` (and `by`, a Figma user id, and `note` when set). `raw` is the stored value: `BUILD` is read as Ready for dev, not yet confirmed against a re-export. `status: none` with a `previous` other than `none` is a mark that came off at `changedAt`. A record that is `none` and was `none`, with no `by` or `note`, is one Figma keeps on nodes nobody marked: `figma_get_node` and `figma_get_tree` do not show it, and only `status: none` or `any` lists it; without `status`, `neverMarked` counts the ones the answer left out. `status` filters (`ready_for_dev`, `completed`, `none`, `any`), `page` narrows; `returned` / `total` / `truncated` (default limit 100) |
| `figma_token_usage` | Aggregate raw values in use (colors, type, radii, spacing, effects) to derive tokens from files without variables |
| `figma_get_text` | All copy under a node, component instances expanded, with `total` / `truncated` / `unresolvedInstances`. `unresolved` names each missing component once, with its count and some of the places, most common first, and `unresolvedComponentsOmitted` counts the components past that listing |
| `figma_screenshot` | PNG of a node via Copy as PNG |
| `figma_export_image_fills` | Original bitmap assets, from fill and stroke paints; per image the `usedBy` layers (up to five, with `usedByTotal` beyond that), and `{hash, missing: true}` for one whose bytes the export does not carry |
| `figma_diff` | Two snapshots of one file compared by node id: pages and top-level layers (a page's children and what its sections hold) added, removed, renamed (same id, other name) or moved (same id, other parent), and `removedNodes`, the top of each subtree gone from the visible pages with the page and path it had and `removedCount`, how many nodes went with it (`figma_locate` on either file answers for any id under it). Only ids, names and parents are compared: an edit to text, fills, sizes or any other property is not reported. Both sides dated; `byPage` counts each page's `added`, `removed`, `renamed`, `moved`, `movedOut` and `removedNodes`, every page counted; `page` or `exclude_pages` (default: the project's `excludePages`, echoed as `excludedPages`) narrow the lists before the limit. Every list stops at `limit`, shared between pages so that one page with many changes cannot crowd out the rest, with `counts` and `truncated`. `old` may be `previous`: each export keeps the snapshot it replaces (one per key, `<key>.previous.fig` in the cache), so `diff previous <key> --refresh` compares the last export with the live file |
| `figma_changes` | Top-level layers created or edited since an ISO date or a duration (`7d`), from the edit times Figma records per node, each rolled up from everything under it: `lastEditedAt`, `created`, `editedNodes`, newest first. Edit metadata from one snapshot: no deletions (use `figma_diff`), not what changed, and text layers record no edit time (`undatedNodes`), so a copy edit shows only where its frame's time moved too. `byPage` counts each page's `layers` and `editedNodes`; `page` and `exclude_pages` (default: the project's `excludePages`) narrow it as they do `figma_diff`, and the limit is shared between pages the same way |

Every tool that reads a file takes one as a local `.fig` path, a file key, or a `figma.com/design/...` URL. A `node-id` in that URL is used by the seven tools that take a `node_id` — `figma_get_tree`, `figma_get_node`, `figma_search`, `figma_token_usage`, `figma_get_text`, `figma_screenshot`, `figma_export_image_fills` — when the argument is omitted. The seven that answer about the whole file (`figma_load_file`, `figma_get_variables`, `figma_get_styles`, `figma_get_components`, `figma_dev_status`, `figma_diff`, `figma_changes`) have no node to scope to and ignore it, and so does `figma_locate`, which takes its ids in `node_ids`. `figma_status`, `figma_login` and `figma_list_files` name no file at all; `figma_list_files` lists local `.fig` files by default (`source: "web"` for the account's recent files). `figma_screenshot` is the exception among the rest: the image always comes from the live file in the browser, so it takes a key or URL, and a local path only when its name carries the key. The MCP server says how `file` and `refresh` are read once, in its `instructions`, as `figma-reader help` does in its overview; each tool's `file` and `refresh` say in a line what they take and point there.

MCP inputs are strict: every tool's schema is `additionalProperties: false`, so an unknown argument is an error rather than a silently dropped one. Only the tools that cannot write are published with `readOnlyHint: true` — the ones taking `out_file`, `out_dir` or `save_path` are not, nor are `figma_status` and `figma_login`, which write account state.

MCP results are compact JSON, without the indentation the CLI prints: on a real export that was 17–41% of the bytes of `figma_search`, `figma_get_text`, `figma_dev_status`, `figma_diff` and `figma_get_node` answers, which an MCP client, unlike a shell with `jq`, cannot strip. A text answer (`figma_get_tree`'s outline, CSS, JSON followed by `out_file`'s note) is as the CLI prints it, and a call is refused alike on both: `figma_get_node`'s 200 KB limit is on the indented JSON.

### Linking local files to Figma URLs

Name saved copies `<anything> [<file key>].fig` (the key is the id after `/design/` in the URL) and put them under `FIGMA_FILES_DIRS`:

```
~/Downloads/My App [AbCdEf1234567890XyZ].fig
```

Then a pasted URL such as `https://www.figma.com/design/AbCdEf1234567890XyZ/My-App?node-id=8-77` is served from that file offline (newest match wins); node ids are identical. `refresh: true` ignores local copies and exports the live file, and is answered only by an export that begins after it was asked for, never by one already under way; on a path to a `.fig` there is nothing to export from, so it is ignored and the result says `refreshIgnored: true`.

A dated result names the date after what it dates, because the two are not the same claim. `exportedAt` is the ISO-8601 time this tool exported that snapshot through the browser: report what the design said then rather than as current, and `figma_load_file` adds `source` and `snapshotAgeMinutes` beside it. A `.fig` the user supplied carries `fileModifiedAt` instead, that copy's own file time, and no age: copying, syncing or re-downloading the file resets it, so the design data can be older than the field says and nothing here can date it. Beside `exportedAt` stands `account`, the Figma account the snapshot was read through (see [Accounts](#accounts-one-figma-login-per-project)); a local `.fig` carries none. Ten tools date their results — `figma_load_file`, `figma_get_node`, `figma_locate`, `figma_search`, `figma_get_components`, `figma_dev_status`, `figma_token_usage`, `figma_get_text`, `figma_changes`, and `figma_get_tree`, whose first line is `# ` followed by the same fields as JSON (`# {"exportedAt":"…","account":{…}}`), with the outline unchanged below it — and `figma_diff` dates each of its two sides, under `old` and `new`. `figma_get_variables`, `figma_get_styles` and `figma_export_image_fills` answer with neither date nor account, since their answer is the data itself (a token file, a stylesheet, the images written), so an answer built on them cannot be dated from the result, nor told apart by account. The one exception is the note `out_file` adds after the answer of `figma_get_variables` and `figma_get_styles`, which is not written to the file: `(written to <path>; exportedAt <time>, account "acme" (source: …))`, or `(written to <path>; fileModifiedAt <time>)` for a local `.fig`. The MCP server states this rule once, in its `instructions`, as `figma-reader help` does in its overview; each dated tool's description says only that it is dated and points there.

`figma_screenshot` always renders the live file and works from a local path only when its name carries the key.

## Setup

[Install](#install) has the one-liners. This section is what each form needs beyond them.

Node 22+ throughout. For web mode, a Chromium-family browser: on Linux and macOS the first of Brave, Chromium, Chrome found on `PATH`, on Windows `brave.exe`, `chrome.exe`, `chromium.exe` or `msedge.exe` on `PATH` or in the usual install directories, or whatever `FIGMA_BROWSER_PATH` names. A browser that cannot start is passed over for the next one, and a confined build (snap, flatpak) is tried only after an ordinary one, since it cannot reach a profile outside its own sandbox. Playwright's "Chrome for Testing" is a last resort because Google sign-in rejects it as insecure.

From a clone, `npm link` puts `figma-reader` and `figma-reader-mcp` on `PATH`; without it, run `node /path/to/figma-reader/dist/cli.js`.

### CLI

```sh
figma-reader help                      # all commands
figma-reader help get-node             # one command's arguments
figma-reader load-file ~/Downloads/app.fig
figma-reader get-tree "https://www.figma.com/design/<key>/App?node-id=8-77" --depth 1
figma-reader search <file> "sign in" --include-text --types TEXT
figma-reader get-variables <file> --format css > tokens.css
figma-reader screenshot <file> --node-id 8:77 --save-path out/login.png
figma-reader locate <file> --node-ids 8:77,8-78,9:12  # which of these ids the file has, and where
```

Arguments are the MCP tool arguments in kebab-case. Required strings are positional (`<file>`, then `<query>` or `<out_dir>`), booleans are bare flags (`--refresh`, `--no-refresh`) or take a value (`--refresh=false`), lists repeat or take commas (`--types FRAME,TEXT`) and are given empty with `--no-` in front (`--no-exclude-page`; an empty `--exclude-page=` is bad usage), and `--json '{"node_id":"8:77"}'` passes raw arguments. `--` ends the options, so a query such as `--help` can follow it. Results go to stdout (pipe JSON into `jq`), errors to stderr. Exit code 0 is success, 1 a failed call, 2 bad usage. Images go to `--save-path` or, without it, to a new file in a private per-user temp directory (`$TMPDIR/figma-reader-<uid>/`, mode 0700), whose path is printed.

Installed from a clone without `npm link`, run `node /path/to/figma-reader/dist/cli.js`. The CLI reads the same environment variables as the server (see below).

Each CLI call is its own process, and decodes the `.fig` (a local file or a cached snapshot) again. That cost grows with the file: a small one answers in a fraction of a second, but every call on a 67 MB export takes 3.4 to 4.7 s, almost all of it decoding, whatever the command asks. A call that needs figma.com also starts the headless browser and loads the editor, so it takes tens of seconds. The browser closes when the call ends, unless an MCP server on the same profile is still using it. The MCP server decodes a file once and keeps it in memory while the file is unchanged, and keeps the browser warm, so for many calls on a large file, or many web calls in a row, use the server rather than the CLI.

`figma-reader batch` runs many calls in one process instead, so a file is decoded once rather than for every call (each call decodes it again otherwise: about 4 s for a 67 MB export) and web calls share one browser. The process keeps the four files used last decoded, so that holds while at most four files are in play: group calls by file. It reads one call per line of stdin, `{"tool": "get-text", "args": {"file": "app.fig", "node_id": "1:2"}}`, with the tool as a command or MCP name and the arguments under their MCP names and as JSON values, a list as an array even of one id (`figma-reader help batch` names every list argument), checked as strictly as a single call's. It writes one JSON line per call, in order: `{"i": 0, "ok": true, "result": ...}`, where `result` is what the command alone prints (its JSON as a value, text such as `get-tree`'s outline as a string, and any image written to `save_path` or a private temp file and listed by path in `images`), or `{"i": 1, "ok": false, "error": "..."}`. A line that is not JSON, names no tool or has bad arguments fails alone and the rest still run; `login` is refused, since it waits for a person. Exit code 0 when every call succeeded, 1 when any failed, 2 for bad usage of `batch` itself or when any call was refused because no account was chosen (see [Accounts](#accounts-one-figma-login-per-project)): that line holds the refusal, nothing was tried on it, and running the batch again is refused the same way until the account is chosen. On that export, with the machine busy, ten `get-text` calls took 43–66 s as ten processes and 5–7 s as one batch.

```sh
printf '%s\n' \
  '{"tool":"locate","args":{"file":"app.fig","node_ids":["1:2","3:4"]}}' \
  '{"tool":"get-text","args":{"file":"app.fig","node_id":"1:2"}}' |
  figma-reader batch | jq -c .result
```

#### For agents

[`skills/figma-reader/SKILL.md`](skills/figma-reader/SKILL.md) is a ready-made agent skill that teaches the CLI. Install it into a project with

```sh
npx skills add https://github.com/LeoGCode/figma-reader --skill figma-reader
```

which writes `.agents/skills/figma-reader/` and registers it for Claude Code and the other agents that read that directory. Or copy the directory into `.claude/skills/` (project) or `~/.claude/skills/` (user) by hand, or paste `SKILL.md` into another agent's instructions (`AGENTS.md`, rules files). `SKILL.md` stays short, since an agent re-reads it on every turn; every output shape and flag is in [`references/output.md`](skills/figma-reader/references/output.md) beside it, which the skill tells the agent to read when it needs one. Agents without a skill can also run `figma-reader help`.

### MCP server, per project

Register it only in the projects that need it (writes `.mcp.json` in the project root, shareable in git):

```sh
cd /path/to/project
claude mcp add --scope project figma-reader -- npx -y @leogcode/figma-reader@latest figma-reader-mcp
```

Installed globally, `-- figma-reader-mcp` works instead; from a clone, `-- node /path/to/figma-reader/dist/mcp.js`.

or add to the project's `.mcp.json` by hand (Claude Code expands `${VAR}`):

```json
{
  "mcpServers": {
    "figma-reader": {
      "command": "npx",
      "args": ["-y", "@leogcode/figma-reader@latest", "figma-reader-mcp"],
      "env": { "FIGMA_FILES_DIRS": "${PWD}/design:${HOME}/Downloads" }
    }
  }
}
```

### Accounts: one Figma login per project

If different projects need different Figma accounts (a client's workspace, your personal one), give each its own **account**. An account is a name with its own browser profile, so its own Figma login, and its own cache of exported files. Projects on different accounts never share a session, and a file exported by one account is never served to a project using another.

A project picks its account with a `.figma-reader.json` in its root, found by walking up from the working directory:

```sh
cd ~/work/acme-app
figma-reader use acme      # writes .figma-reader.json: { "account": "acme" }
figma-reader login         # opens a browser window to sign "acme" into Figma, once
figma-reader accounts      # every account, its login and email, and which one this directory uses
```

The same file serves the CLI and the MCP server: Claude Code and most MCP clients start the server in the project directory, so no extra MCP configuration is needed. The account is fixed when the server starts; after changing it, restart the server (in Claude Code, `/mcp`). `figma_status` reports the account in use and where the choice came from.

An answer that came through figma.com or the account's snapshot cache says which account it was, as `"account": { "name": "acme", "source": "/home/me/work/acme-app/.figma-reader.json" }`, where `source` is `FIGMA_ACCOUNT` (which `--account` sets), the project file, or `default` when nothing chose one, plus `profileOverride` when `FIGMA_USER_DATA_DIR` or `FIGMA_CDP_URL` supplies the login. That field is in the JSON of `figma_load_file`, `figma_get_node`, `figma_locate`, `figma_search`, `figma_get_components`, `figma_dev_status`, `figma_token_usage`, `figma_get_text` and `figma_changes` given a key or URL, on each side of `figma_diff` read through the account (`previous` included), of `figma_list_files` with `source: "web"`, and of `figma_status` and `figma_login`; `figma_get_tree` carries it in its header line, and the text of `figma_screenshot`'s note and of `figma_login`'s messages ends with or names `account "acme" (source: …)`. `figma_get_variables`, `figma_get_styles` and `figma_export_image_fills` do not carry it: their answer is the artifact itself (a token file, a stylesheet, the list of images written) and stays exactly that, except in the `(written to …)` note `out_file` prints after it, which names the account and is not written to the file. The check below guards them all the same, so none of them reads through a default nothing chose. Once a call has passed that check, any error it ends in names the account too, as `[account "acme" (source: …)]` at the end, whether figma.com raised it or it came later (a node missing from a cached snapshot); `figma_status` reports its errors inside its answer instead. An answer read from a local `.fig`, by its path or by a key that a local `<name> [<key>].fig` serves, names no account, and neither does an error it ends in, since no account takes part in reading it.

Which account applies, first match wins:

1. `--account <name>` on any CLI command
2. `FIGMA_ACCOUNT`, e.g. in the MCP server's `env` for clients that do not start servers in the project directory
3. `account` in the nearest `.figma-reader.json`
4. `default`, unless other accounts exist (below)

`default` is only a fallback, and with other accounts in `<data>/accounts/` it is a guess: run from a directory outside the project, a call would read the project's files through whichever login was set up first. So when nothing chose an account and others exist, any call that needs figma.com or the snapshot cache (a file key or URL, either side of `diff` and `diff previous` included, `screenshot`, `login`, `list-files --source web`, and each such line of a `batch`) fails before touching either, and before reading any other file it was given, saying where no project file was found and which accounts exist; the CLI exits 2, as for bad usage. The call is refused the same way, naming the error, when `<data>/accounts/` is there but cannot be read (permissions, I/O): that proves nothing about whether other accounts exist. A chosen account never reads it. Run it from the project's directory, or pass `--account <name>` / set `FIGMA_ACCOUNT`; `--account default` (`FIGMA_ACCOUNT=default`) is the explicit way to use `default`. An MCP server resolves its account once, when it starts, so its tools say to set `FIGMA_ACCOUNT` in the server's `env` or start it in the project directory, then restart it. Local `.fig` files (by path, or by a key a local `<name> [<key>].fig` serves without `refresh`), `status` (which reports the refusal as `webCallsRefused`), `accounts`, `use` and `help` work from any directory. With `default` the only account, or a login named by `FIGMA_USER_DATA_DIR` or `FIGMA_CDP_URL`, nothing is refused.

`.figma-reader.json` can also set the project's `.fig` folders; relative paths resolve against the file's directory:

```json
{ "account": "acme", "filesDirs": ["design", "~/Downloads"] }
```

It can also name the pages `figma_search`, `figma_diff` and `figma_changes` skip by default, such as archives and templates whose hits or changes would otherwise fill the limit: `"excludePages": ["Archive", "Templates"]`. A name a file does not have is ignored for that file. A call that gives `exclude_pages`, `page` or (for search) `node_id` is not affected, `exclude_pages: []` (on the CLI, `--no-exclude-page`) covers every page, and an answer that skipped any names them in `excludedPages`. Only those three read it: `figma_get_text` and `figma_token_usage` on a whole file still cover every page.

Only the nearest file applies; files further up are not merged in. So `figma-reader use` in a subdirectory of a project that already has a `.figma-reader.json` writes a new file there that starts as a copy of the project's other settings (relative `filesDirs` rebased), so only the account changes for that subdirectory, and says which file it copied. Later edits to the project's file do not reach the subdirectory.

Commit it if your team uses the same account names, or add it to `.gitignore` (or `.git/info/exclude`) to keep it to yourself.

Account data lives in `<data>/accounts/<name>/` (profile, last verified email) and `<cache>/accounts/<name>/` (snapshots, under `$FIGMA_READER_CACHE/accounts/<name>/` when that is set). Delete those two directories to remove an account. The three roots are the ones the platform itself keeps such files in:

| | Linux, macOS | Windows |
| --- | --- | --- |
| `<data>` browser profiles, `account.json` | `~/.local/share/figma-reader` | `%APPDATA%\figma-reader` |
| `<cache>` exported `.fig` snapshots: each file's latest export and the one it replaced | `~/.cache/figma-reader` | `%LOCALAPPDATA%\figma-reader\Cache` |
| `<state>` browser records, leases, downloads in flight | `~/.local/state/figma-reader` | `%LOCALAPPDATA%\figma-reader\State` |

macOS keeps the Linux paths rather than `~/Library`: they work there, and moving them would leave every account logged in somewhere the tool no longer looks. Account names are compared the way the filesystem compares them, so `acme` and `Acme` are two accounts on Linux and one on Windows and macOS.

`help`, and reading a local `.fig` with any command but `screenshot`, write to none of them, and nowhere else but the files asked for (`--out-file`, the directory given to `export-image-fills`): `<state>` and `<cache>` are first written by a call that goes through the browser (an export, any `screenshot`, `list-files --source web`, `login`, `status`), so local reads work in a read-only sandbox, CI job or container.

### Browser and login

| Mode | Set | Behavior |
| --- | --- | --- |
| Managed (default) | nothing | Launches the detected browser headless on the account's profile, `<data>/accounts/<name>/profile-<browser>` |
| Managed, own browser/profile | `FIGMA_BROWSER_PATH=/usr/bin/brave`, `FIGMA_USER_DATA_DIR=~/.config/figma-profile` | Same, with that executable and profile (an existing logged-in profile skips the login step) |
| Attached | `FIGMA_CDP_URL=http://127.0.0.1:9222` | Uses a browser you started with `--remote-debugging-port`; never launched or closed by the server |

Login flow (managed): the first web call checks the session cookies. If the profile is not logged in, the headless browser is closed and the same profile opens in a **normal visible window on figma.com/login, with no DevTools port** (Google and others refuse sign-in in remotely controlled browsers). Log in and retry: once Figma's auth cookie shows up in the profile's cookie DB (read-only, no DevTools needed) the window is closed gracefully and the login is verified headless; if verification fails the login window reopens. `figma_login` with `wait_seconds` blocks until then. The login persists in the profile.

Tabs the profile would reopen are dropped before each launch (Brave restores the last session by default), so neither the work browser nor the login window comes up with Figma tabs left by earlier runs. The login is untouched: it lives in the cookies, not the session. A profile named by `FIGMA_USER_DATA_DIR` keeps its tabs, since it may be one you browse with.

Headless needs two workarounds, applied automatically: the user agent's `HeadlessChrome` is rewritten (CloudFront answers 403 otherwise) and focus is emulated (Figma ignores shortcuts without it).

A managed browser is shared by all servers and CLI calls using the same profile (found via Chromium's `DevToolsActivePort`) and closed when the last of them exits. A profile can be open in only one browser process: if you have it open normally (without a DevTools port) the server reports it instead of launching.

| Env | Default | |
| --- | --- | --- |
| `FIGMA_ACCOUNT` | from `.figma-reader.json`, else `default` (refused for figma.com while other accounts exist) | Account: which Figma login and snapshot cache to use |
| `FIGMA_FILES_DIRS` | `filesDirs` from `.figma-reader.json`, else `~/Downloads` | Dirs scanned (2 levels) for `.fig` files, separated like `PATH` (`:`, `;` on Windows) |
| `FIGMA_BROWSER_PATH` | Brave › Chromium › Chrome › Playwright | Browser executable |
| `FIGMA_USER_DATA_DIR` | `<data>/accounts/<account>/profile-<browser>` | Browser profile holding the Figma login (one per browser: cookie keys differ). Without an account set, a custom profile gets its own cache |
| `FIGMA_HEADLESS` | `1` | `0` keeps the work browser visible |
| `FIGMA_CDP_URL` | unset | Attach to a running browser instead of launching |
| `FIGMA_READER_CACHE` | `<cache>` (see [Accounts](#accounts-one-figma-login-per-project)) | Root of the snapshot cache (`.fig` files from web exports); each account keeps its own `accounts/<account>/` below it |
| `FIGMA_SNAPSHOT_MAX_AGE_MIN` | `30` | Re-export after this age (or pass `refresh: true`) |

### Concurrency

Each server process uses its own editor tab, marked with its pid; tabs of exited servers are reused. Calls within one server run one at a time on that tab; separate agents run in parallel on separate tabs, and concurrent exports share the browser-wide download setting safely (per-frame download matching plus lease files, in a directory named after the profile so that processes given different caches still agree on it). Processes sharing a cache also wait for each other's export of a file rather than each exporting it. Each editor tab costs hundreds of MB to over a GB of RAM. In a visible browser (attached or `FIGMA_HEADLESS=0`) keep the windows un-minimized: hidden tabs stop rendering and Copy as PNG never fires.

`node scripts/concurrency.ts <key> <nodeA> <nodeB> same|multi` and `node scripts/concurrency.ts x <keyA> <keyB> export` exercise the concurrent paths. `node scripts/call.ts` lists the MCP tools; `node scripts/call.ts <tool> '<json>'` calls one.

`npm test` typechecks `src/`, `test/` and `scripts/`, then runs the unit tests. Tests and scripts run straight from the TypeScript source with Node's built-in type stripping (Node 22.18+), so they need no build; `src/` sticks to erasable syntax (no enums or constructor parameter properties) to keep that working. `npm run build` compiles `src/` to `dist/` for the published commands.

Unit tests build their scene graphs in code (`test/fixtures.ts`), since real design files cannot be published, plus one real export (`test/files/real-export.fig`, 35 KB, made for this purpose and holding no design work) that pins what the format actually looks like: bindings recorded in `parameterConsumptionMap`, a property value an enclosing instance sets on a nested one, and an opacity variable of 50 driving a layer at 0.5. Coded fixtures encode what we believe the format is; that one fails when the belief is wrong. To check changes against real files you have, run `npm run corpus -- <file.fig | dir>...` (or set `FIGMA_CORPUS_DIR`): it decodes each file and runs it through `outline`, `instance-text`, `normalize`, `tokens` (variables, their CSS and DTCG, styles and their CSS), `component-usage`, `token-usage` and `dev-status` (with annotations and measurements). It checks that no step throws, and these invariants: no two text items share an id, and no unresolved id repeats for the same reason; every instance layer's text is as long as what Figma last rendered for it, and no layer an instance still renders is left neither answered nor reported as unresolved — `derivedSymbolData` is Figma's last layout and is never pruned, so entries for layers an instance has since stopped showing are excused; no property definition without a name; no duplicate CSS custom property in `:root`, no `var()` reference to a name nothing declares, and none in `:root` to a name declared only in a mode block; every collection with variables has a mode; no DTCG collections merged into another, every `{a.b.c}` reference naming a token with a value, no token dropped by a name collision or nested inside another; every component use naming a component the file holds, none recorded on a soft-deleted or superseded instance and none naming a superseded copy, one use per instance of a component, an instance's swaps at least the distinct (path, property) pairs it sets — two properties set to one component are two uses — and at most the swap records it holds, and the per-component totals adding up to the uses; every colour a hex value, every typography entry carrying typography and none reported twice, every count a positive whole number, every text node walked accounted for by a typography count or by `textWithoutTypography` with that counter holding exactly the text that records none, and no value counted more often with hidden layers skipped than with them included; every Dev Mode status a value this decoder has a name for, no node marked only through the bare `sectionStatus` field it does not read, no annotation label using markup the markdown conversion does not know, and every measurement naming a target. It prints counts only, never design content, among them `keyIdCollisions`, the guids one layer uses as an override key and another as a node id, and `instancesGone`/`supersededComponents`, which say whether the file has anything for the two skips above to decide about. Add `--save base.json` before a change and `--compare base.json` after it to see what moved. Snapshots exported through the browser are under the account's own `<cache>/accounts/<account>/` (see [Accounts](#accounts-one-figma-login-per-project)).

For behaviour on real files, keep private tests in `test/private/` (gitignored) and run them with `npm run test:private`, which fails when that directory holds no tests, since a green step that ran nothing proves nothing (`FIGMA_PRIVATE_OPTIONAL=1` skips it instead, and also skips the tests whose pinned file is missing). Check expectations against what Figma renders (a `figma-reader screenshot` of the frame), not against the tool's own output. Pin copies of the files there too rather than pointing at the export cache, which is overwritten on refresh. `node:test` snapshots (`t.assert.snapshot`, accepted with `npm run test:private:update`) can then catch any change in output, for you to review.

## Limits

- Relies on figma.com internals (Quick actions `data-testid="save-as"`, `_fullscreen_.isReady`, `/api/recent_files`). Breaks if Figma changes them.
  The Quick actions box itself is recognised by any of three signals — its placeholder or aria-label text, its CSS-module class name, or an
  ancestor `[data-testid*="quick-action"]` — none of which has been verified against the live product. If none match, `saveLocalCopy` fails
  closed with a diagnostic naming the focused element, rather than typing the query into whatever field happens to have focus.
- Files whose owner disabled copying/exporting cannot be saved locally.
- A collapsed instance's contents are not stored in the `.fig`; they are derived from its main component plus overrides.
  `figma_get_text` and `figma_search` do that derivation (text overrides and properties, boolean properties that show or hide layers,
  instance swaps, and properties set on nested instances), tagging each string with `via` (direct/instance), its component, variant and
  enclosing frame, and counting anything they could not resolve as `unresolvedInstances`. `figma_get_node` and `figma_get_tree` still do
  not expand instances: they report the main component, variant and property values instead.
- Layer *names* inside a collapsed instance are likewise not in the file, so `figma_search` cannot match them; search the main component.
- Library variables/styles/components appear only when the file uses them (Figma copies them in); they are flagged `remote` / `fromLibrary`.
- Dev Mode status is read from each node's own record. Each page also keeps an index of the statuses on it, which goes stale (entries
  for deleted nodes, previous statuses that disagree with the node) and is not used. `BUILD` is read as Ready for dev and `COMPLETED` as
  Completed; the names line up, but no frame has been marked and the file exported again to confirm it, so `raw` is always reported
  beside `status`. `by` is a Figma user id: the export carries no names. Annotation labels are stored as HTML and returned as markdown;
  a measurement stores its two nodes and sides, not the distance.
- Token export (`figma_get_variables`, `figma_get_styles`):
  - CSS numbers are `px`, except variables scoped to font weight or font axes (unitless) and opacity (Figma's 0-100 written as 0-1).
  - DTCG aliases reference the full token path `{Collection.Mode.path}`; an alias into another collection uses that collection's default mode, as Figma does. An alias to a library variable the file has no copy of becomes a CSS comment, or a DTCG node with `$extensions["com.figma"].aliasOf` and neither `$value` nor `$type`: a token is an object with a `$value` and a group is one without, so what has no value is left as the group it is rather than as a token consumers split between dropping and erroring on.
  - Names are unique: collections, modes and styles sharing a name are numbered (`colors-2`, `Colors 2`). With `collection` or `include_remote: false` the names stay those of the full export, and an alias into a collection left out is written as its resolved value.
  - Soft-deleted styles and older copies of an updated library variable or style are left out. Stacked fills are composited (or layered when they cannot be), and gradient angles are approximate on non-square layers.
- Selecting a different node for a screenshot reloads the editor tab (a few seconds).
