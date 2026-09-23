// figma_search reuses one matcher for every node, so it must give the same answer each time it is asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchPattern } from "../src/search-query.ts";

const re = (q: string, opts?: Parameters<typeof searchPattern>[1]) => searchPattern(q, opts).re;

test("a plain query is a case-insensitive substring with regex characters taken literally", () => {
  assert.ok(re("Button (primary)").test("big button (Primary) hover"));
  assert.ok(!re("Button (primary)").test("Button primary"));
  assert.ok(re("a.b").test("a.b") && !re("a.b").test("axb"));
  assert.equal(searchPattern("a.b").as, "substring");
  // Figma separates component groups with slashes, so this is an ordinary name.
  assert.ok(re("Icons/Arrow/Left").test("ICONS/ARROW/LEFT 24"));
  assert.equal(searchPattern("Icons/Arrow/Left").as, "substring");
});

test("every regex metacharacter in a layer name is escaped", () => {
  // [query, a name it must find, what the unescaped pattern would have matched instead]
  const cases: [string, string, string][] = [
    ["Card [v2]", "Card [v2] copy", "Card v"],
    ["50% width*", "50% width* fix", "50% width"],
    ["Logo+Mark", "Logo+Mark", "LogoooMark"],
    ["Avatar?", "Avatar? 32", "Avata"],
    ["^Btn", "x^Btn", "Btn"],
    ["Btn$", "Btn$ x", "Btn"],
    ["Grid{2}", "Grid{2} col", "Gridd"],
    ["(Primary)", "(Primary) button", "Primary"],
    ["Yes|No", "Yes|No toggle", "Yes"],
    ["C:\\d", "C:\\d path", "C:5"],
  ];
  for (const [query, hit, miss] of cases) {
    assert.equal(searchPattern(query).as, "substring", query);
    assert.ok(re(query).test(hit), `${query} must find ${hit}`);
    assert.ok(!re(query).test(miss), `${query} must not match ${miss}`);
  }
});

test("a slash-wrapped query is a layer name, not a pattern", () => {
  // Each of these used to be read as a regex, so the layer actually called that was missing from its own results while
  // unrelated ones matched. [query, what the regex reading would have found]
  const cases: [string, string][] = [
    ["/^btn$/", "btn"],
    ["/Icon/s", "Icon"],
    ["/Card [v2]/", "Card v"],
    ["/Users/me/design/", "Users/me/design"],
    ["/v/s", "v"],
    ["/src/d", "src"],
    ["/x//", "x/"],
  ];
  for (const [query, asRegex] of cases) {
    const m = searchPattern(query);
    assert.equal(m.as, "substring", query);
    assert.ok(m.re.test(`Assets ${query.toUpperCase()}`), query);
    assert.ok(!m.re.test(asRegex), `${query} must not match ${asRegex}`);
  }
});

test("a slashed name that never compiled stays literal as before", () => {
  // "down" was read as flags ("Invalid flags") and "/[/" as an unterminated class; both already fell back to a literal.
  for (const name of ["/Icon/down", "/[/", "//", "/", "/icons/24/arrow", "/[draft]/v2"]) {
    const m = searchPattern(name);
    assert.equal(m.as, "substring", name);
    assert.ok(m.re.test(`Assets ${name.toUpperCase()}`), name);
  }
  assert.ok(!re("/Icon/down").test("Icon"));
  assert.ok(re("/[/").test("a/[/b"));
});

test("regex: false and no regex option are the one same rule", () => {
  for (const q of ["/^btn$/", "^Btn", "Icons/Arrow/Left"]) {
    const off = searchPattern(q, { regex: false });
    const unset = searchPattern(q);
    assert.deepEqual([off.as, off.re.source, off.re.flags], [unset.as, unset.re.source, unset.re.flags], q);
  }
  const lit = searchPattern("/^btn$/", { regex: false });
  assert.equal(lit.as, "substring");
  assert.ok(lit.re.test("x/^BTN$/y") && !lit.re.test("btn"));
});

test("regex: true reads the query as a pattern, bare or /pattern/flags", () => {
  assert.equal(searchPattern("^btn-\\d$", { regex: true }).as, "regex");
  assert.ok(re("^btn-\\d$", { regex: true }).test("Btn-1"));
  assert.ok(!re("^btn-\\d$", { regex: true }).test("a btn-1"));
  assert.ok(re("/^btn$/", { regex: true }).test("BTN"));
  // The /…/ form survives here only because per-query flags have nowhere else to go.
  assert.ok(re("/^btn.x$/s", { regex: true }).test("BTN\nX"));
  assert.ok(re("/^btn$/m", { regex: true }).test("a\nBTN"));
  for (const [q, flags] of [["/btn/d", "di"], ["/btn/m", "im"], ["/btn/s", "is"], ["/btn/u", "iu"], ["/btn/v", "iv"]] as const) {
    const r = re(q, { regex: true });
    assert.deepEqual([r.source, r.flags], ["btn", flags], q);
  }
  // The default i repeated in the query is a duplicate flag, which RegExp rejects.
  assert.ok(re("/btn/i", { regex: true }).test("BTN"));
});

test("only a whole /pattern/flags wrapper is unwrapped", () => {
  // A slash pair anywhere but around the entire query is part of the pattern.
  assert.ok(re("x/b/i", { regex: true }).test("X/B/I") && !re("x/b/i", { regex: true }).test("b"));
  assert.ok(re("/a/b", { regex: true }).test("/a/b") && !re("/a/b", { regex: true }).test("xay"));
  assert.ok(re("//", { regex: true }).test("a//b") && !re("//", { regex: true }).test("ab"));
  // A name can hold a newline, and the wrapper still spans it.
  assert.ok(re("/a\nb/", { regex: true }).test("a\nb"));
});

test("regex: true reports an invalid pattern instead of quietly matching it literally", () => {
  assert.throws(() => searchPattern("/[/", { regex: true }), SyntaxError);
  assert.throws(() => searchPattern("(", { regex: true }), /Invalid regular expression.*without the regex option/s);
  assert.throws(() => searchPattern("/btn/uv", { regex: true }), SyntaxError, "u and v cannot be combined");
});

test("case_sensitive turns off the default i for literals and patterns alike", () => {
  assert.ok(!re("Button", { caseSensitive: true }).test("button"));
  assert.ok(re("Button", { caseSensitive: true }).test("Button"));
  assert.ok(!re("/^btn$/", { regex: true, caseSensitive: true }).test("BTN"));
  assert.ok(re("/^btn$/i", { regex: true, caseSensitive: true }).test("BTN"), "a flag written in the query still applies");
});

test("g and y flags do not make repeated matches alternate", () => {
  // With g kept, test() resumed from lastIndex and every other identical node was skipped.
  for (const q of ["/button/g", "/button/gi", "/button/y"]) {
    const r = re(q, { regex: true });
    assert.deepEqual(["button", "button", "button"].map((n) => r.test(n)), [true, true, true], q);
    assert.ok(!r.global && !r.sticky && r.ignoreCase, q);
  }
});
