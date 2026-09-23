# figma-reader

[![CI](https://github.com/LeoGCode/figma-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/LeoGCode/figma-reader/actions/workflows/ci.yml)

Read-only Figma access for AI agents and people. **No Figma plugin, no API token, no Dev Mode seat, no Enterprise plan.**

It ships in two forms that share the same tools and code. Use whichever fits:

| | Command | Best for |
| --- | --- | --- |
| **MCP server** | `figma-reader-mcp` | MCP clients (Claude Code, Claude Desktop, Cursor, ...). One long-lived process keeps the browser and editor tab warm, so repeated web calls are fast |
| **CLI** | `figma-reader` | Shells, scripts, CI, and agents that prefer running commands over loading MCP tools. Nothing to register; output is JSON/text on stdout |

Two ways to feed it:

- **Local `.fig` file** (File › Save local copy in Figma, then pass the path). Fully offline, no browser. Everything except screenshots.
- **Figma file key / URL**. It drives figma.com in a **headless** Chromium-family browser over the DevTools protocol, and shows a visible window only when you need to log in:

| Data | How |
| --- | --- |
| Document tree, variables, styles, components, text, image fills | **File › Save local copy** (triggered via Quick actions) → `.fig` → decoded locally (kiwi schema is embedded in the file, so it survives Figma format changes) |
| Screenshots | **Copy as PNG** on the node; the PNG is intercepted in the page, the system clipboard is never touched |
| Recent files, account | Figma's internal web API with the browser's session cookies |

Variables come straight out of the file, so modes, aliases and scopes are available on any plan (the REST variables endpoint is Enterprise-only).

## Tools

MCP tool names and CLI commands map one to one: `figma_get_tree` is `figma-reader get-tree`.

| Tool | Purpose |
| --- | --- |
| `figma_status` | Account, browser mode, running browser, logged-in user. `loggedIn` is `"unknown"`, not a boolean, when figma.com could not be asked — a network error, a 5xx or a dead browser is reported rather than guessed as "not logged in" |
| `figma_login` | Open the visible login window / wait for login |
| `figma_list_files` | Local `.fig` files or recently viewed files. Always an envelope: `returned` / `total` / `truncated` (default limit 30), `searchedDirs` for a local listing, `totalUnfiltered` when `query` left files out |
| `figma_load_file` | Export + decode, summary (pages, counts, collections, styles) |
| `figma_get_tree` | Compact layer outline |
| `figma_get_node` | Normalized design data: geometry, fills/strokes/effects, auto-layout, text runs, instance props, bound variables, style names |
| `figma_search` | Find nodes by name / text; with `include_text` the text rendered inside component instances is matched too, each hit tagged with `via` and whichever of `component` / `variant` / `frame` apply. The query is a case-insensitive literal substring: `Icons/Arrow/Left` and `/Card [v2]/` find the layers named that. `regex: true` reads it as a pattern instead, bare or `/pattern/flags`, and an invalid pattern is an error; `case_sensitive: true` matches case. The result's `queryAs` says which was used. A hit's `characters` is a preview, the first 120 characters followed by `...` and flagged `charactersTruncated` (`truncated` beside it counts results, not characters). A `types` list without TEXT turns `include_text` off, and `unresolvedInstances` is there only when the text pass ran. `node_id` (or a `node-id` in the URL) searches only that node's subtree and is echoed back as `searchedNode` |
| `figma_get_variables` | Collections, modes, values, resolved aliases; `json`, `css`, `dtcg`. A file that defines none answers empty in the requested format; a `collection` no collection has is an error listing the ones it has |
| `figma_get_styles` | FILL, STROKE, TEXT, EFFECT and GRID styles; `json`, `css`. No styles, or none of the type asked for, answers empty in the requested format |
| `figma_get_components` | Local components, variant sets, and `libraryComponentsUsed` as a third list. Counts are per variant: `instances` (placed directly) and `swapInstances` (swapped into an instance by an override or instance-swap property). Internal-only pages are left out of the three lists but not out of the counts |
| `figma_token_usage` | Aggregate raw values in use (colors, type, radii, spacing, effects) to derive tokens from files without variables |
| `figma_get_text` | All copy under a node, component instances expanded, with `total` / `truncated` / `unresolvedInstances`. `unresolved` names each missing component once, with its count and some of the places, most common first, and `unresolvedComponentsOmitted` counts the components past that listing |
| `figma_screenshot` | PNG of a node via Copy as PNG |
| `figma_export_image_fills` | Original bitmap assets, from fill and stroke paints; per image the `usedBy` layers (up to five, with `usedByTotal` beyond that), and `{hash, missing: true}` for one whose bytes the export does not carry |

Every tool that reads a file takes one as a local `.fig` path, a file key, or a `figma.com/design/...` URL. A `node-id` in that URL is used by the seven tools that take a `node_id` — `figma_get_tree`, `figma_get_node`, `figma_search`, `figma_token_usage`, `figma_get_text`, `figma_screenshot`, `figma_export_image_fills` — when the argument is omitted. The four that answer about the whole file (`figma_load_file`, `figma_get_variables`, `figma_get_styles`, `figma_get_components`) have no node to scope to and ignore it. `figma_status`, `figma_login` and `figma_list_files` name no file at all; `figma_list_files` lists local `.fig` files by default (`source: "web"` for the account's recent files). `figma_screenshot` is the exception among the rest: the image always comes from the live file in the browser, so it takes a key or URL, and a local path only when its name carries the key.

MCP inputs are strict: every tool's schema is `additionalProperties: false`, so an unknown argument is an error rather than a silently dropped one. Only the tools that cannot write are published with `readOnlyHint: true` — the ones taking `out_file`, `out_dir` or `save_path` are not, nor are `figma_status` and `figma_login`, which write account state.

### Linking local files to Figma URLs

Name saved copies `<anything> [<file key>].fig` (the key is the id after `/design/` in the URL) and put them under `FIGMA_FILES_DIRS`:

```
~/Downloads/My App [AbCdEf1234567890XyZ].fig
```

Then a pasted URL such as `https://www.figma.com/design/AbCdEf1234567890XyZ/My-App?node-id=8-77` is served from that file offline (newest match wins); node ids are identical. `refresh: true` ignores local copies and exports the live file, and is answered only by an export that begins after it was asked for, never by one already under way; on a path to a `.fig` there is nothing to export from, so it is ignored and the result says `refreshIgnored: true`.

A dated result names the date after what it dates, because the two are not the same claim. `exportedAt` is the ISO-8601 time this tool exported that snapshot through the browser: report what the design said then rather than as current, and `figma_load_file` adds `source` and `snapshotAgeMinutes` beside it. A `.fig` the user supplied carries `fileModifiedAt` instead, that copy's own file time, and no age: copying, syncing or re-downloading the file resets it, so the design data can be older than the field says and nothing here can date it. Six tools date their results — `figma_load_file`, `figma_get_node`, `figma_search`, `figma_get_components`, `figma_token_usage`, `figma_get_text`. `figma_get_tree`, `figma_get_variables`, `figma_get_styles` and `figma_export_image_fills` answer with no date at all, so an answer built on them cannot be dated from the result.

`figma_screenshot` always renders the live file and works from a local path only when its name carries the key.

## Setup

Node 22+. For web mode, a Chromium-family browser: the first of Brave, Chromium, Chrome found on `PATH`, or `FIGMA_BROWSER_PATH`. Playwright's "Chrome for Testing" is only a last resort because Google sign-in rejects it as insecure.

```sh
npm install -g @leogcode/figma-reader     # puts figma-reader and figma-reader-mcp on PATH
```

Or without installing, for a one-off: `npx -y @leogcode/figma-reader@latest help`. To work on it instead:

```sh
git clone https://github.com/LeoGCode/figma-reader && cd figma-reader
npm install && npm run build
npm link    # optional: puts figma-reader and figma-reader-mcp on PATH
```

### CLI

```sh
figma-reader help                      # all commands
figma-reader help get-node             # one command's arguments
figma-reader load-file ~/Downloads/app.fig
figma-reader get-tree "https://www.figma.com/design/<key>/App?node-id=8-77" --depth 1
figma-reader search <file> "sign in" --include-text --types TEXT
figma-reader get-variables <file> --format css > tokens.css
figma-reader screenshot <file> --node-id 8:77 --save-path out/login.png
```

Arguments are the MCP tool arguments in kebab-case. Required strings are positional (`<file>`, then `<query>` or `<out_dir>`), booleans are bare flags (`--refresh`, `--no-refresh`) or take a value (`--refresh=false`), lists repeat or take commas (`--types FRAME,TEXT`), and `--json '{"node_id":"8:77"}'` passes raw arguments. `--` ends the options, so a query such as `--help` can follow it. Results go to stdout (pipe JSON into `jq`), errors to stderr. Exit code 0 is success, 1 a failed call, 2 bad usage. Images go to `--save-path` or, without it, to a new file in a private per-user temp directory (`$TMPDIR/figma-reader-<uid>/`, mode 0700), whose path is printed.

Installed from a clone without `npm link`, run `node /path/to/figma-reader/dist/cli.js`. The CLI reads the same environment variables as the server (see below).

Each CLI call is its own process. Local `.fig` files and cached snapshots answer in well under a second, but a call that needs figma.com starts the headless browser and loads the editor, so it takes tens of seconds. The browser closes when the call ends, unless an MCP server on the same profile is still using it. For many web calls in a row, the MCP server is faster.

#### For agents

[`skills/figma-reader/SKILL.md`](skills/figma-reader/SKILL.md) is a ready-made agent skill that teaches the CLI. Install it into a project with

```sh
npx skills add https://github.com/LeoGCode/figma-reader --skill figma-reader
```

which writes `.agents/skills/figma-reader/` and registers it for Claude Code and the other agents that read that directory. Or copy the file into `.claude/skills/` (project) or `~/.claude/skills/` (user) by hand, or paste its body into another agent's instructions (`AGENTS.md`, rules files). Agents without a skill can also run `figma-reader help`.

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

Which account applies, first match wins:

1. `--account <name>` on any CLI command
2. `FIGMA_ACCOUNT`, e.g. in the MCP server's `env` for clients that do not start servers in the project directory
3. `account` in the nearest `.figma-reader.json`
4. `default`

`.figma-reader.json` can also set the project's `.fig` folders; relative paths resolve against the file's directory:

```json
{ "account": "acme", "filesDirs": ["design", "~/Downloads"] }
```

Only the nearest file applies; files further up are not merged in. So `figma-reader use` in a subdirectory of a project that already has a `.figma-reader.json` writes a new file there that starts as a copy of the project's other settings (relative `filesDirs` rebased), so only the account changes for that subdirectory, and says which file it copied. Later edits to the project's file do not reach the subdirectory.

Commit it if your team uses the same account names, or add it to `.gitignore` (or `.git/info/exclude`) to keep it to yourself.

Account data lives in `<data>/accounts/<name>/` (profile, last verified email) and `<cache>/accounts/<name>/` (snapshots, under `$FIGMA_READER_CACHE/accounts/<name>/` when that is set). Delete those two directories to remove an account. The three roots are the ones the platform itself keeps such files in:

| | Linux, macOS | Windows |
| --- | --- | --- |
| `<data>` browser profiles, `account.json` | `~/.local/share/figma-reader` | `%APPDATA%\figma-reader` |
| `<cache>` exported `.fig` snapshots | `~/.cache/figma-reader` | `%LOCALAPPDATA%\figma-reader\Cache` |
| `<state>` browser records, leases, downloads in flight | `~/.local/state/figma-reader` | `%LOCALAPPDATA%\figma-reader\State` |

macOS keeps the Linux paths rather than `~/Library`: they work there, and moving them would leave every account logged in somewhere the tool no longer looks. Account names are compared the way the filesystem compares them, so `acme` and `Acme` are two accounts on Linux and one on Windows and macOS.

### Browser and login

| Mode | Set | Behavior |
| --- | --- | --- |
| Managed (default) | nothing | Launches the detected browser headless on the account's profile, `<data>/accounts/<name>/profile-<browser>` |
| Managed, own browser/profile | `FIGMA_BROWSER_PATH=/usr/bin/brave`, `FIGMA_USER_DATA_DIR=~/.config/figma-profile` | Same, with that executable and profile (an existing logged-in profile skips the login step) |
| Attached | `FIGMA_CDP_URL=http://127.0.0.1:9222` | Uses a browser you started with `--remote-debugging-port`; never launched or closed by the server |

Login flow (managed): the first web call checks the session cookies. If the profile is not logged in, the headless browser is closed and the same profile opens in a **normal visible window on figma.com/login, with no DevTools port** (Google and others refuse sign-in in remotely controlled browsers). Log in and retry: once Figma's auth cookie shows up in the profile's cookie DB (read-only, no DevTools needed) the window is closed gracefully and the login is verified headless; if verification fails the login window reopens. `figma_login` with `wait_seconds` blocks until then. The login persists in the profile.

Headless needs two workarounds, applied automatically: the user agent's `HeadlessChrome` is rewritten (CloudFront answers 403 otherwise) and focus is emulated (Figma ignores shortcuts without it).

A managed browser is shared by all servers and CLI calls using the same profile (found via Chromium's `DevToolsActivePort`) and closed when the last of them exits. A profile can be open in only one browser process: if you have it open normally (without a DevTools port) the server reports it instead of launching.

| Env | Default | |
| --- | --- | --- |
| `FIGMA_ACCOUNT` | from `.figma-reader.json`, else `default` | Account: which Figma login and snapshot cache to use |
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

Unit tests build their scene graphs in code (`test/fixtures.ts`), since real design files cannot be published, plus one real export (`test/files/real-export.fig`, 35 KB, made for this purpose and holding no design work) that pins what the format actually looks like: bindings recorded in `parameterConsumptionMap`, a property value an enclosing instance sets on a nested one, and an opacity variable of 50 driving a layer at 0.5. Coded fixtures encode what we believe the format is; that one fails when the belief is wrong. To check changes against real files you have, run `npm run corpus -- <file.fig | dir>...` (or set `FIGMA_CORPUS_DIR`): it decodes each file and runs it through `outline`, `instance-text`, `normalize`, `tokens` (variables, their CSS and DTCG, styles and their CSS), `component-usage` and `token-usage`. It checks that no step throws, and these invariants: no two text items share an id, and no unresolved id repeats for the same reason; every instance layer's text is as long as what Figma last rendered for it, and no layer an instance still renders is left neither answered nor reported as unresolved — `derivedSymbolData` is Figma's last layout and is never pruned, so entries for layers an instance has since stopped showing are excused; no property definition without a name; no duplicate CSS custom property in `:root`, no `var()` reference to a name nothing declares, and none in `:root` to a name declared only in a mode block; every collection with variables has a mode; no DTCG collections merged into another, every `{a.b.c}` reference naming a token with a value, no token dropped by a name collision or nested inside another; every component use naming a component the file holds, none recorded on a soft-deleted or superseded instance and none naming a superseded copy, one use per instance of a component, an instance's swaps at least the distinct (path, property) pairs it sets — two properties set to one component are two uses — and at most the swap records it holds, and the per-component totals adding up to the uses; every colour a hex value, every typography entry carrying typography and none reported twice, every count a positive whole number, every text node walked accounted for by a typography count or by `textWithoutTypography` with that counter holding exactly the text that records none, and no value counted more often with hidden layers skipped than with them included. It prints counts only, never design content, among them `keyIdCollisions`, the guids one layer uses as an override key and another as a node id, and `instancesGone`/`supersededComponents`, which say whether the file has anything for the two skips above to decide about. Add `--save base.json` before a change and `--compare base.json` after it to see what moved. Snapshots exported through the browser are under the account's own `<cache>/accounts/<account>/` (see [Accounts](#accounts-one-figma-login-per-project)).

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
- Token export (`figma_get_variables`, `figma_get_styles`):
  - CSS numbers are `px`, except variables scoped to font weight or font axes (unitless) and opacity (Figma's 0-100 written as 0-1).
  - DTCG aliases reference the full token path `{Collection.Mode.path}`; an alias into another collection uses that collection's default mode, as Figma does. An alias to a library variable the file has no copy of becomes a CSS comment, or a DTCG node with `$extensions["com.figma"].aliasOf` and neither `$value` nor `$type`: a token is an object with a `$value` and a group is one without, so what has no value is left as the group it is rather than as a token consumers split between dropping and erroring on.
  - Names are unique: collections, modes and styles sharing a name are numbered (`colors-2`, `Colors 2`). With `collection` or `include_remote: false` the names stay those of the full export, and an alias into a collection left out is written as its resolved value.
  - Soft-deleted styles and older copies of an updated library variable or style are left out. Stacked fills are composited (or layered when they cannot be), and gradient angles are approximate on non-square layers.
- Selecting a different node for a screenshot reloads the editor tab (a few seconds).
