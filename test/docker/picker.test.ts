// Runs inside test/docker/picker.Dockerfile, on a machine laid out the way Ubuntu lays one out: /usr/bin/chromium
// is a link into /snap, and a native browser sits beside it. No developer machine and no CI runner has that shape
// without root, so on one the demotion can only be checked as strings. Here it is checked against the filesystem,
// and the fall-through against a browser that really does exit without opening a port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserCandidates, BrowserManager } from "../../src/browser.ts";

const CONFINED = "/usr/bin/chromium";
const NATIVE = "/usr/bin/google-chrome-stable";

const manager = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `picker-${name}-`));
  return { dir, m: new BrowserManager({ userDataDir: join(dir, "profile"), headless: true, stateDir: join(dir, "state") }) };
};

test("a link into a snap is kept but tried last, behind the native build", () => {
  const found = browserCandidates();
  // The preference order lists chromium BEFORE google-chrome-stable, so only the demotion can produce this: the
  // test cannot pass by accident of naming.
  assert.deepEqual(found, [NATIVE, CONFINED], found.join(" "));
});

test("a launch settles on the browser that starts, not the one that is preferred by name", async () => {
  const { dir, m } = manager("fallthrough");
  try {
    await m.launch(true, "work");
    assert.equal(m.launchRecord()?.exe, NATIVE, "recorded the browser that answered");
    // The fake browser records which executable ran it, so this does not rest on our own bookkeeping alone.
    assert.equal(readFileSync(join(dir, "profile", "started-by"), "utf8"), "native");
  } finally {
    await m.release();
  }
});

test("with only a confined build installed, it is still tried, and the failure says why", async () => {
  renameSync(NATIVE, `${NATIVE}.hidden`);
  try {
    assert.deepEqual(browserCandidates(), [CONFINED], "the confined one is kept when it is all there is");
    const { m } = manager("confined-only");
    await assert.rejects(m.launch(true, "work"), (e: Error) => {
      assert.match(e.message, /No installed browser could be started/);
      assert.ok(e.message.includes(CONFINED), "names what it tried");
      assert.match(e.message, /snap or flatpak|user namespaces/, "says what to look at");
      return true;
    });
  } finally {
    renameSync(`${NATIVE}.hidden`, NATIVE);
  }
});

test("with no browser at all, the error says to install one or name one", async () => {
  renameSync(NATIVE, `${NATIVE}.hidden`);
  renameSync("/snap/bin/chromium", "/snap/bin/chromium.hidden");
  try {
    assert.deepEqual(browserCandidates(), [], "a dangling /usr/bin/chromium link is not a browser");
    const { m } = manager("none");
    await assert.rejects(m.launch(true, "work"), /No Chromium-family browser found.*FIGMA_BROWSER_PATH/s);
  } finally {
    renameSync(`${NATIVE}.hidden`, NATIVE);
    renameSync("/snap/bin/chromium.hidden", "/snap/bin/chromium");
  }
});
