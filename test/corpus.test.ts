// scripts/corpus.ts is run on real files that cannot be committed, so an invariant that misfires is only found there.
// These run it, as a child process the way `npm run corpus` does, on .fig files written here.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { figBytes, type TestNode } from "./fixtures.ts";

const CORPUS = join(import.meta.dirname, "..", "scripts", "corpus.ts");
const root = mkdtempSync(join(tmpdir(), "figma-reader-corpus-"));
after(() => rmSync(root, { recursive: true, force: true }));

// The fixtures' schema plus Dev Mode annotations, both label fields of them.
const SCHEMA = `
  struct GUID { uint sessionID; uint localID; }
  message ParentIndex { GUID guid = 1; string position = 2; }
  message Annotation { string label = 1; string labelV2 = 2; }
  message NodeChange { GUID guid = 1; ParentIndex parentIndex = 2; string type = 3; string name = 4; string key = 5; Annotation[] annotations = 6; }
  message Message { NodeChange[] nodeChanges = 1; }
`;

function corpus(name: string, annotations: { label?: string; labelV2?: string }[]) {
  const nodes: TestNode[] = [
    { id: "0:1", type: "CANVAS", parent: "0:0", name: "Page" },
    { id: "1:1", type: "FRAME", parent: "0:1", name: "Card", annotations },
  ];
  const path = join(root, `${name}.fig`);
  writeFileSync(path, figBytes(nodes, { schema: SCHEMA }));
  return spawnSync(process.execPath, ["--no-warnings", CORPUS, path], { encoding: "utf8" });
}

test("a label whose code shows a tag is converted markup, not HTML the conversion left behind", () => {
  // `<button>` decoded from &lt;button&gt; inside <code> is the element's name as text. The check used to look for
  // tags in the converted label, found this one, and failed the file for a label converted exactly right.
  const r = corpus("code", [{ label: "<p>Use <code>&lt;button&gt;</code> for <strong>every</strong> action</p>" }, { label: "", labelV2: "plain" }]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ok\s+code\.fig .*\bannotations=2\b/m);
});

test("a label using markup the conversion does not know fails the file, naming the tags and nothing of the text", () => {
  const r = corpus("unknown", [{ label: "<p>secret <u>words</u></p>" }, { labelV2: '<p><span style="color: red">more</span></p>' }]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /annotations: 2 labels with markup the markdown conversion does not know \(span, u\)/);
  assert.doesNotMatch(r.stdout, /secret|words|more/);
});
