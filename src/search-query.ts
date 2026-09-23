// How figma_search turns its query into a matcher. Kept apart from tools.ts, which starts a browser manager on import.

export interface SearchOptions {
  /** true: the query is a regex, bare or as /pattern/flags. false or unset: always a literal substring. */
  regex?: boolean;
  caseSensitive?: boolean;
}

// Only a regex query is unwrapped, and only when the wrapper spans the whole query: the trailing group is the flag set,
// and the greedy .+ leaves the last slash to it, so "/a/b/" is the pattern a/b and not a with "b/" left over.
const SLASHED = /^\/(.+)\/([dgimsuvy]*)$/s;

/**
 * Case-insensitive unless caseSensitive. Without regex the query is a literal substring whatever it looks like; with it
 * the query is a pattern, bare or "/pattern/flags", and an invalid one throws. Figma names groups with slashes
 * ("Icons/Arrow/Left") and designs are full of metacharacters ("Card [v2]"), so reading /…/ as a regex on sight kept a
 * layer out of a search for its own name while returning two others: wrong results that look right. A forgotten regex
 * flag now returns nothing instead, which the caller can see and recover from. The g and y flags are dropped: they make
 * test() resume from the last match, so reusing one RegExp across nodes would skip every other hit.
 */
export function searchPattern(query: string, opts: SearchOptions = {}): { re: RegExp; as: "regex" | "substring" } {
  const extra = opts.caseSensitive ? "" : "i";
  if (opts.regex) {
    const m = SLASHED.exec(query);
    const flags = [...new Set((m ? m[2] : "").replace(/[gy]/g, "") + extra)].join("");
    try {
      return { re: new RegExp(m ? m[1] : query, flags), as: "regex" };
    } catch (e) {
      // "Invalid regular expression: /[/" alone leaves a caller who set the option by mistake with nowhere to go.
      throw new SyntaxError(`${(e as Error).message} (read as a regex; without the regex option the query is a literal substring)`);
    }
  }
  return { re: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), extra), as: "substring" };
}
