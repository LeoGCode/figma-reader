// Files on disk: the local .fig files a key can be served from, the type of exported image-fill bytes, and where the
// CLI puts images nobody gave a path for.
import { randomBytes } from "node:crypto";
import { type Dirent, lstatSync, mkdirSync, readdirSync, realpathSync, type Stats, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Raw } from "./fig-file.ts";
import { keyFromFileName } from "./figma-web.ts";

/** The entry as it is after following symlinks; nothing for a broken one, which must not throw out of list-files. */
const target = (p: string): Stats | undefined => {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
};

/** .fig files up to two directories below each dir (skipping dot-dirs and node_modules), newest first. */
export function localFigFiles(dirs: string[]): Raw[] {
  const out: Raw[] = [];
  // Real paths of the directories already walked: a symlink pointing back up would otherwise be followed forever.
  const walked = new Set<string>();
  const walk = (dir: string, level: number) => {
    let real: string;
    let entries: Dirent[];
    try {
      real = realpathSync(dir);
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (walked.has(real)) return;
    walked.add(real);
    for (const e of entries) {
      const p = join(dir, e.name);
      // A Dirent is "symbolic link", never the type of what it points at, so isDirectory() and isFile() are both
      // false for one: a .fig reachable only through a symlink, or in a symlinked directory, was invisible, and
      // list-files then called a directory of them empty.
      const fig = e.name.toLowerCase().endsWith(".fig");
      const st = e.isSymbolicLink() || (e.isFile() && fig) ? target(p) : undefined;
      if ((e.isDirectory() || st?.isDirectory()) && level < 2 && !e.name.startsWith(".") && e.name !== "node_modules") walk(p, level + 1);
      else if (fig && st?.isFile()) {
        const key = keyFromFileName(p);
        out.push({ path: p, name: e.name.slice(0, -4).replace(/\s*\[[A-Za-z0-9]+\]$/, ""), key, sizeMB: Math.round(st.size / 1e5) / 10, modifiedAt: st.mtime.toISOString() });
      }
    }
  };
  for (const d of dirs) walk(d, 0);
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** File extension from an image's magic bytes; "bin" when unrecognised. */
export function imageExt(b: Uint8Array) {
  if (b[0] === 0x89 && b[1] === 0x50) return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
  if (b[0] === 0x47 && b[1] === 0x49) return "gif";
  if (b[8] === 0x57 && b[9] === 0x45) return "webp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "mp4";
  return "bin";
}

/** What makes each file name its own; a parameter so a test can force the collision the exclusive create refuses. */
const unique = () => `${Date.now()}-${randomBytes(4).toString("hex")}`;

/**
 * Write bytes to a new file in this user's own directory under the temp dir. A fixed shared directory with predictable
 * names let another local user pre-create the directory or plant a symlink where the next image would be written, so
 * the directory must be ours and private, and the file is created exclusively (never through an existing path).
 */
export function writePrivateTemp(name: string, ext: string, bytes: Uint8Array, suffix = unique): string {
  const uid = process.getuid?.();
  const dir = join(tmpdir(), uid === undefined ? "figma-reader" : `figma-reader-${uid}`);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const st = lstatSync(dir);
  if (!st.isDirectory() || (uid !== undefined && (st.uid !== uid || (st.mode & 0o077) !== 0))) {
    throw new Error(`${dir} is not a private directory owned by this user; remove it or pass --save-path`);
  }
  const path = join(dir, `${name}-${suffix()}.${ext}`);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return path;
}
