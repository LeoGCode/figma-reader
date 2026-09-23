// Local .fig files are found by walking FIGMA_FILES_DIRS; a key or URL is served from one when its name carries the key.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageExt, localFigFiles, writePrivateTemp } from "../src/local-files.ts";

const root = mkdtempSync(join(tmpdir(), "figma-reader-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string, ageMinutes: number) => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "x");
  const t = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(p, t, t);
  return p;
};

test("finds .fig files up to two levels down, newest first, with the [key] read from the name", () => {
  const app = put("My App [AbCdEf1234567890].fig", 10);
  const nested = put("clients/acme/Brand.FIG", 5);
  put("clients/acme/deeper/Too deep.fig", 1);
  put(".hidden/Secret.fig", 1);
  put("node_modules/pkg/Dep.fig", 1);
  put("notes.txt", 1);
  const files = localFigFiles([root, join(root, "missing")]);
  assert.deepEqual(files.map((f) => [f.path, f.name, f.key]), [
    [nested, "Brand", undefined],
    [app, "My App", "AbCdEf1234567890"],
  ]);
});

test("a .fig reached through a symlink is found, and a broken one does not break the listing", () => {
  const dir = join(root, "links");
  mkdirSync(dir);
  const real = put("linked/Real [Key1234567890ab].fig", 20);
  const realDir = join(root, "linked");
  // Dirent.isFile()/isDirectory() are false for a symlink, so both of these used to be skipped: list-files called
  // the directory empty, and a key that a local copy could have answered paid for a browser export instead.
  symlinkSync(real, join(dir, "Link [Key1234567890ab].fig"));
  symlinkSync(realDir, join(dir, "sub"));
  symlinkSync(join(root, "gone.fig"), join(dir, "Broken.fig"));
  // A link back to an ancestor is walked once, not forever.
  symlinkSync(dir, join(realDir, "loop"));
  const files = localFigFiles([dir]);
  assert.deepEqual(files.map((f) => [f.path, f.key]).sort(), [
    [join(dir, "Link [Key1234567890ab].fig"), "Key1234567890ab"],
    [join(dir, "sub", "Real [Key1234567890ab].fig"), "Key1234567890ab"],
  ].sort());
  assert.equal(files[0].sizeMB, 0);
  rmSync(dir, { recursive: true });
  rmSync(realDir, { recursive: true });
});

test("CLI images go to a private directory of this user, never through a path someone else prepared", { skip: !process.getuid && "no POSIX users" }, () => {
  const saved = process.env.TMPDIR;
  const tmp = join(root, "tmp");
  mkdirSync(tmp);
  process.env.TMPDIR = tmp;
  try {
    const dir = join(tmp, `figma-reader-${process.getuid!()}`);
    const a = writePrivateTemp("screenshot", "png", new Uint8Array([1, 2]));
    const b = writePrivateTemp("screenshot", "png", new Uint8Array([3]));
    assert.equal(join(a, ".."), dir);
    assert.notEqual(a, b, "names cannot collide within a millisecond");
    assert.deepEqual([...readFileSync(a)], [1, 2]);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(a).mode & 0o777, 0o600);
    // A directory others can write to (the old shared $TMPDIR/figma-reader was created with the default mode), or a
    // symlink planted in its place, is refused rather than written through.
    chmodSync(dir, 0o777);
    assert.throws(() => writePrivateTemp("screenshot", "png", new Uint8Array()), /not a private directory/);
    rmSync(dir, { recursive: true });
    mkdirSync(join(tmp, "elsewhere"));
    symlinkSync(join(tmp, "elsewhere"), dir);
    assert.throws(() => writePrivateTemp("screenshot", "png", new Uint8Array()), /not a private directory/);
    assert.deepEqual(readdirSync(join(tmp, "elsewhere")), []);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
});

test("a temp image is created, never written through a name that is already there", { skip: !process.getuid && "no POSIX users" }, () => {
  const saved = process.env.TMPDIR;
  const tmp = join(root, "tmp2");
  mkdirSync(tmp);
  process.env.TMPDIR = tmp;
  try {
    // The name is unique in real use; forcing the collision is the only way to see the exclusive create.
    const same = () => "fixed";
    const path = writePrivateTemp("screenshot", "png", new Uint8Array([1]), same);
    assert.throws(() => writePrivateTemp("screenshot", "png", new Uint8Array([2]), same), /EEXIST/);
    assert.deepEqual([...readFileSync(path)], [1], "the first file was not overwritten");
    // Without the exclusive create, a symlink planted at the next name would be written through.
    const planted = join(tmp, "planted");
    writeFileSync(planted, "keep");
    rmSync(path);
    symlinkSync(planted, path);
    assert.throws(() => writePrivateTemp("screenshot", "png", new Uint8Array([2]), same), /EEXIST/);
    assert.equal(readFileSync(planted, "utf8"), "keep");
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
});

test("imageExt recognises image-fill formats by their magic bytes", () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...Array(12).fill(0)]);
  assert.equal(imageExt(bytes(0x89, 0x50, 0x4e, 0x47)), "png");
  assert.equal(imageExt(bytes(0xff, 0xd8, 0xff)), "jpg");
  assert.equal(imageExt(bytes(0x47, 0x49, 0x46)), "gif");
  assert.equal(imageExt(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "webp");
  assert.equal(imageExt(new TextEncoder().encode("\0\0\0\x20ftypisom")), "mp4");
  assert.equal(imageExt(bytes(1, 2, 3)), "bin");
});
