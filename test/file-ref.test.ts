// Every tool's `file` argument goes through parseFileRef, so the forms users paste are pinned here.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileKeyFromPath, keyFromFileName, parseFileRef } from "../src/figma-web.ts";

const KEY = "AbCdEf1234567890XyZ";

test("a design URL gives the key and the node-id with ':' in place of '-'", () => {
  assert.deepEqual(parseFileRef(`https://www.figma.com/design/${KEY}/My-App?node-id=1190-37798&t=x`), { key: KEY, nodeId: "1190:37798" });
  assert.deepEqual(parseFileRef(`https://www.figma.com/file/${KEY}/My-App`), { key: KEY, nodeId: undefined });
  assert.equal(parseFileRef(`https://www.figma.com/proto/${KEY}/x`).key, KEY);
});

test("every dash in the node-id becomes ':', not just the first", () => {
  assert.equal(parseFileRef(`https://www.figma.com/design/${KEY}/x?node-id=I1-2;3-4`).nodeId, "I1:2;3:4");
});

test("a URL pasted without its scheme still parses, node-id included", () => {
  assert.deepEqual(parseFileRef(`figma.com/design/${KEY}/My-App?node-id=1-2`), { key: KEY, nodeId: "1:2" });
  assert.deepEqual(parseFileRef(`www.figma.com/design/${KEY}/My-App`), { key: KEY, nodeId: undefined });
});

test("every product Figma serves files under names a file, not only /design", () => {
  // The .fig download filter already accepts .deck/.site/.make/.buzz, so these files are exportable; their URLs
  // were rejected outright, and fileKeyFromPath returning undefined for them re-navigated the tab every time.
  for (const kind of ["design", "file", "proto", "board", "slides", "deck", "make", "site", "buzz"]) {
    assert.equal(parseFileRef(`https://www.figma.com/${kind}/${KEY}/My-App`).key, KEY, kind);
    assert.equal(fileKeyFromPath(`/${kind}/${KEY}/My-App`), KEY, kind);
  }
});

test("a bare key is accepted and anything else is rejected by name", () => {
  assert.deepEqual(parseFileRef(KEY), { key: KEY });
  assert.throws(() => parseFileRef("short"), /not a Figma file key or URL: short/);
  assert.throws(() => parseFileRef("https://example.com/design/AbCdEf1234567890"), /not a Figma file key or URL/);
});

test("the host decides whether a URL is Figma's, whatever its case, and a host that merely contains it is not", () => {
  for (const ref of [`WWW.FIGMA.COM/design/${KEY}/My-App`, `https://Figma.com/design/${KEY}/My-App`, `https://www.FIGMA.com/design/${KEY}/x`]) {
    assert.equal(parseFileRef(ref).key, KEY, ref);
  }
  for (const ref of [
    `https://notfigma.com/design/${KEY}/My-App`,
    `https://evil.test/?u=figma.com/design/${KEY}/x`,
    `https://figma.com.evil.test/design/${KEY}/x`,
  ]) {
    assert.throws(() => parseFileRef(ref), /not a Figma file key or URL/, ref);
  }
});

test("a local .fig is used as a path, keyed by the [key] in its name when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "figma-reader-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const named = join(dir, `My App [${KEY}].fig`);
  const plain = join(dir, "export.fig");
  writeFileSync(named, "");
  writeFileSync(plain, "");
  assert.deepEqual(parseFileRef(named), { key: KEY, path: named, keyInName: true });
  assert.deepEqual(parseFileRef(plain), { key: plain, path: plain, keyInName: false });
  assert.throws(() => parseFileRef(join(dir, "missing.fig")), /local \.fig not found/);
});

test("a bare key stays a key even when the working directory holds something of that name", async (t) => {
  // The key forms are tried first now: a directory or file that happens to be named like a key used to win, and
  // the file then failed to decode with an error naming neither problem.
  const dir = mkdtempSync(join(tmpdir(), "figma-reader-test-"));
  const cwd = process.cwd();
  t.after(() => (process.chdir(cwd), rmSync(dir, { recursive: true, force: true })));
  mkdirSync(join(dir, KEY));
  process.chdir(dir);
  assert.deepEqual(parseFileRef(KEY), { key: KEY });
  // A ref shaped like a path is still read as one.
  assert.equal(parseFileRef(`./${KEY}`).path, join(process.cwd(), KEY));
  assert.throws(() => parseFileRef("missing-thing"), /not a Figma file key or URL/);
});

test("keyFromFileName reads only a trailing [key] of plausible length", () => {
  assert.equal(keyFromFileName(`/x/My App [${KEY}].fig`), KEY);
  assert.equal(keyFromFileName(`/x/My App [${KEY}].FIG`), KEY);
  assert.equal(keyFromFileName("/x/Draft [v2].fig"), undefined);
  assert.equal(keyFromFileName(`/x/[${KEY}] copy.fig`), undefined);
  // A bracketed note in a file name is not a key, and reading one as a key keys the whole snapshot cache by it:
  // real keys are 19-odd characters, and names like "Homepage [rev2024].fig" are ordinary.
  assert.equal(keyFromFileName("/x/Homepage [rev2024].fig"), undefined, "7 characters is not a key");
  assert.equal(keyFromFileName("/x/Deck [v2final8].fig"), undefined, "8 characters is not a key");
  assert.equal(keyFromFileName("/x/Deck [abcdefghi].fig"), undefined, "nor is 9");
  assert.equal(keyFromFileName("/x/Deck [abcdefghij].fig"), "abcdefghij", "10 is the shortest accepted");
});

const BRANCH = "BrAnCh9876543210QwE";

test("a branch URL names the branch, not its main file", () => {
  assert.deepEqual(parseFileRef(`https://www.figma.com/design/${KEY}/branch/${BRANCH}/My-App?node-id=1-2`), { key: BRANCH, nodeId: "1:2" });
  assert.deepEqual(parseFileRef(`figma.com/file/${KEY}/branch/${BRANCH}/My-App`), { key: BRANCH, nodeId: undefined });
});

test("the open editor tab's file is compared by exact key, so a branch is never mistaken for its main file", () => {
  assert.equal(fileKeyFromPath(`/design/${KEY}/My-App`), KEY);
  assert.equal(fileKeyFromPath(`/design/${KEY}/branch/${BRANCH}/My-App`), BRANCH);
  assert.equal(fileKeyFromPath(`/design/${KEY}/`), KEY);
  assert.equal(fileKeyFromPath("/files/recents"), undefined);
});

test("a bare name is never read as a design file just because the cwd happens to hold one", () => {
  // parseFileRef used to try the filesystem first, so a file key became a local path whenever something in the
  // server's working directory carried that name. The order was inverted, and what stops the inverse — an ordinary
  // word being read as a design because a file of that name sits there — is that a ref with no '/', '.' or '~' in
  // it is not a path. An MCP server runs wherever its client started it, so that directory is not one we choose.
  //
  // Resolved, since process.chdir below makes this the cwd that parseFileRef resolves "./real.fig" against, and
  // the cwd comes back with its symlinks gone: on macOS the temp dir is under /var, which is a link to /private/var.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "figma-reader-ref-")));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    for (const name of ["notes", "Design", "archive"]) writeFileSync(join(dir, name), "not a fig");
    for (const name of ["notes", "Design", "archive"]) {
      assert.throws(() => parseFileRef(name), /not a Figma file key or URL/, name);
    }
    // A path-shaped ref that exists is still read as one, and a .fig always is.
    writeFileSync(join(dir, "real.fig"), "x");
    assert.equal(parseFileRef("./real.fig").path, join(dir, "real.fig"));
  } finally {
    process.chdir(cwd);
  }
});
