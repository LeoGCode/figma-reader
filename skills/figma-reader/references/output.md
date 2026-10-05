# figma-reader: output shapes and flags

Read this before parsing a command the skill's Output list does not cover. Shapes name the keys you need; a key that does not apply is absent. `D` is `exportedAt` and `account` (`{name, source}`) for a snapshot this tool exported, or `fileModifiedAt` and no account for a file read from disk: a `.fig` path, or a key or URL that a local `<name> [<key>].fig` under `FIGMA_FILES_DIRS` answers (`--refresh` exports instead); `load-file`, `get-tree`, `get-node`, `locate`, `search`, `get-components`, `dev-status`, `token-usage`, `get-text` and `changes` carry it, `diff` on each side. `path` joins layer names with ` / `, and a name may itself contain ` / ` (component naming): tell structure by ids and `page`, never by splitting `path`.

## Shapes

| Command | Shape |
| --- | --- |
| `load-file` | `{name, key?, source: "local"\|"web", path? or snapshotPath?, D, snapshotAgeMinutes?, pages[{id, name, topLevelNodes}], nodeCounts{<TYPE>: n}, variableCollections[{name, modes[], variables: n, remote}], styles{<TYPE>: n}, components: n, imageFills: n}` |
| `get-tree` | **Text.** Line 1 `# ` and JSON holding `D`. Then one line per node, two spaces per level. The last line is `... truncated at <n> nodes; use a node_id or smaller depth` when a branch was cut, or `... level <n> not shown: <k> layers have children, <m> of <n> lines left; open one with node_id, or pass max_nodes <n>` when a whole level did not fit |
| `get-node` | `{D, page, path, id, name, type, x, y, width, height, fills[{type, color?, variable?}], strokes?, effects?, cornerRadius?, layout?{mode, gap, padding[t,r,b,l]}, component?, boundVariables?{<field>: <variable>}, devStatus?{status, raw, previous, previousRaw, changedAt, by?, note?}, annotations?[{label, category?, properties?}], measurements?[{from, fromSide, to, toSide, freeText?}], children[…] or childCount}`. An INSTANCE's `component` is `{mainComponent, mainComponentId?, overrides?, properties?}`; children carry no `D`/`page`/`path` |
| `search` | `{D, queryAs, searchedNode?, excludedPages?, excludedPagesFrom?, returned, total, truncated, unresolvedInstances?, results[{id, type, name, page, size?, characters?, charactersTruncated?, via?, component?, variant?, frame?}]}`; `characters` is the first 120 chars, then `...` when `charactersTruncated` |
| `get-text` | `{D, returned, total, truncated, unresolvedInstances, unresolved?[{name, reason, count, ids}], unresolvedComponentsOmitted?, text[{id, name, text, via, component?, variant?, frame?}]}` |
| `locate` | `{D, found, missing, invalid, results[{id, found: true, type, name, page, path} or {id, found: false} or {id, error}]}`, in the order given |
| `dev-status` | `{D, returned, total, truncated, neverMarked?, nodes[{id, type, name, page, path, status: ready_for_dev\|completed\|none\|unknown, raw, previous, previousRaw, changedAt, by?, note?}]}` |
| `diff` | `{old{key?, source, path?, D}, new{…}, excludedPages?, excludedPagesFrom?, limit, truncated, counts{pagesAdded, pagesRemoved, pagesRenamed, layersAdded, layersRemoved, layersRenamed, layersMoved, removedRoots, removedNodes}, byPage{<page>: {added?, removed?, renamed?, moved?, movedOut?, removedNodes?}}, pages{added[{id, name}], removed[…], renamed[{id, oldName, name}]}, layers{added[{id, type, name, page, path}], removed[…], renamed[{id, type, oldName, name, page, path}], moved[{id, type, name, from{page, parentId, path}, to{…}}]}, removedNodes[{id, type, name, page, path, removedCount}]}`. `removedCount` counts the nodes gone with that root, itself included; each list's limit is shared between pages |
| `changes` | `{D, excludedPages?, excludedPagesFrom?, since, returned, total, truncated, limit, editedNodes, undatedNodes, byPage{<page>: {layers, editedNodes}}, layers[{id, name, type, page, path, lastEditedAt, created, editedNodes}]}` |
| `get-components` | `{D, componentSets[{id, name, page, description?, variants[{id, name, instances, swapInstances}]}], components[{id, name, page, size, instances, swapInstances}], libraryComponentsUsed[{name, componentKey?, variantsUsed?, instances, swapInstances}]}` |
| `token-usage` | `{D, colors[{value, roles{fill\|text\|stroke: n}, count, variables?, styles?}], typography[{<font fields>, count, styles?}], cornerRadii, gaps, paddings, strokeWidths[{value, count}], effects[{type, color?, offset?, radius?, spread?, count}], textWithoutTypography?}` |
| `get-variables` | json: `[{id, name, remote, modes[{id, name}], defaultMode, variables[{id, name, type, scopes, values{<mode>: {value} or {alias, resolved?}}}]}]`; css: custom properties in `:root`, other modes in their own blocks; dtcg: `{<collection>: {<mode>: {…: {$type, $value}}}}` |
| `get-styles` | json: `[{name, type, value}]`, `value` by type `{paints}`, font fields, `{effects}` or `{grids}`; css: `:root` properties and a class per text style |
| `screenshot` | Text: `image written to <path>`, then `node <id>: <w>x<h>` (`page (all top-level layers) <id>: …` for a page), ending `; account "<name>" (source: …)`; with `--save-path`, one line ending `saved to <path>` and the account |
| `export-image-fills` | `[{hash, path, bytes, usedBy, usedByTotal?}]`, one per image; `{hash, missing: true, usedBy}` where the export lacks it |
| `list-files` | `{returned, total, truncated, totalUnfiltered?, searchedDirs?, account?, files[…]}`: local files are `{path, name, key?, sizeMB, modifiedAt}`; `--source web` lists the account's recently viewed files |
| `status` | `{account, webCallsRefused?, mode, profile?, running?, localDirs, cacheDir, downloadDir, loggedIn: true\|false\|"unknown", user?{email, handle}, error?}` |
| `login` | `{account, loggedIn: true, user}`, or a line of text saying a login window opened for the account |

`get-variables`, `get-styles` and `export-image-fills` carry no `D`: date them by another call on the same file. With `--out-file`, `get-variables` and `get-styles` print `(written to <path>; exportedAt <time>, account "<name>" (source: …))` after the body (`fileModifiedAt <time>` for a local `.fig`); the file holds the body only.

**batch** lines: blank ones are skipped and not counted in `i`; `login` is refused (run it alone first); an image is written to `save_path` or a private temp file and listed by path in `images`. Four decoded files are kept at once: group the calls by file. Exit 0 all ok, 1 any failed (stderr lists the `i`), 2 bad usage of batch or any line refused for want of an account.

## Flags

Lists take commas (`--types FRAME,TEXT`) or repeat (`--exclude-page A --exclude-page B`); booleans are bare. Every `<file>` command but `screenshot` takes `--refresh` (export again; ignored on a `.fig` path). `--json '<object>'` passes MCP argument names directly, e.g. `--json '{"exclude_pages":[]}'` to turn off the project's `excludePages` (which `search`, `diff` and `changes` apply when you give no `--page`). `figma-reader help <command>` has the rest.

- `get-tree`: `--node-id`, `--depth` (2, pages being level 0), `--max-nodes` (400)
- `get-node`: `--node-id`, `--depth` (3)
- `search <file> <query>`: `--include-text`, `--types`, `--page`, `--exclude-page`, `--node-id`, `--regex`, `--case-sensitive`, `--include-hidden`, `--limit` (50)
- `get-text`: `--node-id`, `--include-hidden`, `--limit` (500)
- `locate`: `--node-ids` (required)
- `dev-status`: `--page`, `--status ready_for_dev|completed|none|any` (default: marked now or before), `--limit` (100)
- `diff <old> <new>`: `--page` and `--exclude-page` (a renamed page answers to either name), `--limit` (100 per list), and old may be `previous`
- `changes <file> <since>`: `--page`, `--exclude-page`, `--limit` (50), since being an ISO date or 30m, 12h, 7d, 2w, given as a positional or after --since
- `token-usage`: `--node-id`, `--include-hidden`, `--min-count`
- `get-variables`: `--format json|css|dtcg`, `--collection`, `--no-include-remote`, `--out-file`; `get-styles`: `--type FILL|STROKE|TEXT|EFFECT|GRID`, `--format json|css`, `--out-file`; `get-components`: `--query`
- `screenshot`: `--node-id`, `--save-path`, `--max-dimension` (1568); `export-image-fills <file> <out_dir>`: `--node-id`
