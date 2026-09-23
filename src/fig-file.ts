// Decode a .fig (zip containing canvas.fig in "fig-kiwi" format) into an indexed scene graph.
import { readFileSync } from "node:fs";
import { unzipSync, inflateSync } from "fflate";
import { decompress as zstdDecompress } from "fzstd";
import { compileSchema, decodeBinarySchema } from "kiwi-schema";

export type Raw = Record<string, any>;

export interface FigNode extends Raw {
  id: string;
  type: string;
  name: string;
  parentId?: string;
  childIds: string[];
}

export interface FigImage {
  hash: string;
  bytes: Uint8Array;
}

export const guidId = (g: { sessionID: number; localID: number } | undefined) =>
  g ? `${g.sessionID}:${g.localID}` : undefined;

/** Chunks are zstd (newer files) or raw deflate; `what` names the chunk, as the other canvas checks name theirs. */
function decompress(b: Uint8Array, what: string): Uint8Array {
  const zstd = b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;
  try {
    return zstd ? zstdDecompress(b) : inflateSync(b);
  } catch (e) {
    throw new Error(`${what} is not ${zstd ? "zstd" : "raw deflate"} data: ${(e as Error).message}`);
  }
}

function decodeCanvas(buf: Uint8Array) {
  const magic = new TextDecoder().decode(buf.subarray(0, 8));
  // Every Figma product writes the same container under its own 8-byte tag ("fig-kiwi", "fig-jam.", "fig-deck"...).
  if (!magic.startsWith("fig-")) throw new Error(`unexpected canvas header "${magic}"`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = dv.getUint32(8, true);
  const chunks: Uint8Array[] = [];
  for (let off = 12; off + 4 <= buf.length; ) {
    const len = dv.getUint32(off, true);
    if (off + 4 + len > buf.length) throw new Error(`truncated canvas: chunk ${chunks.length} needs ${len} bytes, ${buf.length - off - 4} left`);
    chunks.push(buf.subarray(off + 4, off + 4 + len));
    off += 4 + len;
  }
  if (chunks.length < 2) throw new Error(`canvas has ${chunks.length} chunk(s), expected a schema and a message`);
  const schema = compileSchema(decodeBinarySchema(decompress(chunks[0], `the schema chunk of this "${magic}" canvas`))) as any;
  const message = schema.decodeMessage(decompress(chunks[1], `the message chunk of this "${magic}" canvas`));
  return { version, message };
}

/**
 * Order library versions ("2710:0" is newer than "2002:352"). A "@S2_DEDUPE_..." suffix marks a duplicate of the same
 * version, which ranks below the plain one; missing or unparsable versions rank lowest.
 */
/**
 * Guid ids ("2:14") in the order Figma allocated them: sessionID then localID, both as numbers, where a string
 * compare would put "2:10" before "2:9". The lowest id is the nearest thing to "created first" that a bare mode id
 * can say. Both the token export and the normalizer read a modeless collection by this rule; two copies of it drifted
 * once already, and the same variable then read two ways.
 */
export const compareGuidIds = (a: string, b: string): number => {
  const [sa, la] = a.split(":").map(Number), [sb, lb] = b.split(":").map(Number);
  return sa - sb || la - lb || a.localeCompare(b);
};

export function compareVersions(a: unknown, b: unknown): number {
  const parse = (v: unknown) => {
    const m = typeof v === "string" ? /^(\d+):(\d+)(.*)$/.exec(v) : null;
    return m ? [1, Number(m[1]), Number(m[2]), m[3] ? 0 : 1] : [0, 0, 0, 0];
  };
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export interface FigContents {
  /** Kiwi NodeChange records; each is indexed in place, gaining id, childIds and parentId. */
  nodeChanges: Raw[];
  version?: number;
  meta?: Raw;
  /** Image bytes by hash (hex). */
  images?: Map<string, Uint8Array>;
}

export class FigDocument {
  readonly nodes = new Map<string, FigNode>();
  readonly images = new Map<string, Uint8Array>();
  readonly rootId: string;
  readonly version: number;
  readonly meta: Raw;
  /**
   * Nodes indexed by publish key (styles, components, variables imported from libraries). A file can hold several
   * versions of one library asset; the newest wins.
   */
  readonly byKey = new Map<string, FigNode>();
  /** Nodes by publish key and library version ("key version"), for references that name the version they use. */
  private byKeyVersion = new Map<string, FigNode>();

  readonly fileKey: string;
  readonly exportedAt: Date;
  /** Node changes left out for want of a guid: they are counted rather than indexed under an undefined id. */
  readonly skippedNodeChanges: number;

  /** Index decoded node changes. Most callers want fromFile; tests build scene graphs directly from node changes. */
  constructor(fileKey: string, exportedAt: Date, contents: FigContents) {
    this.fileKey = fileKey;
    this.exportedAt = exportedAt;
    this.version = contents.version ?? 0;
    this.meta = contents.meta ?? {};
    for (const [hash, bytes] of contents.images ?? []) this.images.set(hash, bytes);

    const positions = new Map<string, string>();
    let root: string | undefined;
    let skipped = 0;
    for (const nc of contents.nodeChanges) {
      const id = guidId(nc.guid);
      // Nothing can address a node change that carries no guid, and indexing it would key `nodes` on undefined.
      if (!id) {
        skipped++;
        continue;
      }
      const node = nc as FigNode;
      node.id = id;
      node.childIds = [];
      node.name ??= "";
      if (nc.parentIndex) {
        node.parentId = guidId(nc.parentIndex.guid);
        positions.set(id, nc.parentIndex.position ?? "");
      }
      // The pages hang off the first DOCUMENT; taking the last left a file holding two of them with no pages at all.
      if (nc.type === "DOCUMENT") root ??= id;
      this.nodes.set(id, node);
      if (typeof nc.key === "string" && nc.key) {
        const prev = this.byKey.get(nc.key);
        // Node order says nothing about which copy is current, so two copies at the same version tie-break on the id:
        // the lower one, which the file imported first. Otherwise which library copy survives depends on where it
        // sits in the file, and the same file read twice can answer differently.
        const newer = !prev || compareVersions(node.version, prev.version) > 0 ||
          (compareVersions(node.version, prev.version) === 0 && compareVersions(node.id, prev.id) < 0);
        if (newer) this.byKey.set(nc.key, node);
        if (typeof node.version === "string") {
          const at = `${nc.key} ${node.version}`;
          const kept = this.byKeyVersion.get(at);
          // Two copies at one version tie-break the same way here: resolveRef prefers this index, so without it a
          // reference naming a version landed on whichever copy came last in the file - possibly a superseded one.
          if (!kept || compareVersions(node.id, kept.id) < 0) this.byKeyVersion.set(at, node);
        }
      }
    }
    this.skippedNodeChanges = skipped;
    if (!root) throw new Error("no DOCUMENT node in file");
    this.rootId = root;
    for (const n of this.nodes.values()) {
      if (n.parentId) this.nodes.get(n.parentId)?.childIds.push(n.id);
    }
    // Fractional-index positions compare by code unit, not locale.
    for (const n of this.nodes.values()) {
      n.childIds.sort((a, b) => {
        const pa = positions.get(a)!, pb = positions.get(b)!;
        return pa < pb ? -1 : pa > pb ? 1 : 0;
      });
    }
  }

  /** Decode .fig bytes: a zip holding canvas.fig, meta.json and images/, or a bare canvas.fig. */
  static fromBytes(fileKey: string, exportedAt: Date, figBytes: Uint8Array) {
    const zip: Record<string, Uint8Array> = figBytes[0] === 0x50 && figBytes[1] === 0x4b ? unzipSync(figBytes) : { "canvas.fig": figBytes };
    const canvas = zip["canvas.fig"];
    if (!canvas) throw new Error("canvas.fig missing from .fig archive");
    const images = new Map<string, Uint8Array>();
    for (const [name, bytes] of Object.entries(zip)) {
      if (name.startsWith("images/") && bytes.length) images.set(name.slice(7), bytes);
    }
    const { version, message } = decodeCanvas(canvas);
    return new FigDocument(fileKey, exportedAt, {
      nodeChanges: message.nodeChanges,
      version,
      meta: zip["meta.json"] ? JSON.parse(new TextDecoder().decode(zip["meta.json"])) : {},
      images,
    });
  }

  static fromFile(fileKey: string, path: string, exportedAt: Date) {
    return FigDocument.fromBytes(fileKey, exportedAt, readFileSync(path));
  }

  /**
   * A library asset copied into the file at an older version than another copy with the same key. Instances made
   * before a library update keep pointing at the old copy, so it stays in the file, but it is not the current token.
   */
  isSuperseded(n: FigNode): boolean {
    return typeof n.key === "string" && !!n.key && this.byKey.get(n.key) !== n;
  }

  get(id: string): FigNode | undefined {
    return this.nodes.get(id);
  }

  require(id: string): FigNode {
    const n = this.nodes.get(id.replaceAll("-", ":"));
    if (!n) throw new Error(`node ${id} not found in file ${this.fileKey}`);
    return n;
  }

  /** Visible (non internal-only) pages. */
  pages(): FigNode[] {
    return this.nodes.get(this.rootId)!.childIds.map((id) => this.nodes.get(id)!).filter((n) => n.type === "CANVAS" && !n.internalOnly);
  }

  children(n: FigNode): FigNode[] {
    return n.childIds.map((id) => this.nodes.get(id)!).filter(Boolean);
  }

  /** The node and its ancestors, nearest first. A corrupt file can hold a parent cycle: it ends there. */
  *ancestry(n: FigNode): Generator<FigNode> {
    const seen = new Set<string>();
    for (let cur: FigNode | undefined = n; cur && !seen.has(cur.id); cur = cur.parentId ? this.nodes.get(cur.parentId) : undefined) {
      seen.add(cur.id);
      yield cur;
    }
  }

  pageOf(n: FigNode): FigNode | undefined {
    for (const cur of this.ancestry(n)) if (cur.type === "CANVAS") return cur;
    return undefined;
  }

  path(n: FigNode): string {
    const parts: string[] = [];
    for (const cur of this.ancestry(n)) {
      if (cur.type === "DOCUMENT") break;
      parts.unshift(cur.name);
    }
    return parts.join(" / ");
  }

  *walk(start: FigNode): Generator<FigNode> {
    const stack = [start];
    const seen = new Set<string>(); // a parent cycle would otherwise walk forever
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      yield n;
      for (let i = n.childIds.length - 1; i >= 0; i--) {
        const c = this.nodes.get(n.childIds[i]);
        if (c) stack.push(c);
      }
    }
  }

  /**
   * Resolve a {guid | assetRef} reference (StyleId, VariableID, SymbolId...) to a node in this file: the copy at the
   * library version the reference names when the file has it, else the newest copy.
   */
  resolveRef(ref: { guid?: any; assetRef?: { key?: string; version?: string } } | undefined): FigNode | undefined {
    if (!ref) return undefined;
    if (ref.guid) {
      const n = this.nodes.get(guidId(ref.guid)!);
      if (n) return n;
    }
    const key = ref.assetRef?.key;
    if (!key) return undefined;
    return (ref.assetRef!.version ? this.byKeyVersion.get(`${key} ${ref.assetRef!.version}`) : undefined) ?? this.byKey.get(key);
  }
}

/**
 * The node a reference names, as the copy this file would show: a reference made before a library update points at the
 * copy of that version, which is still in the file but is not what the asset holds now. Reading the reference as it
 * stands makes two answers about one variable disagree - the text an instance renders against the exported token.
 */
export function currentCopy(doc: FigDocument, ref: Parameters<FigDocument["resolveRef"]>[0]): FigNode | undefined {
  const n = doc.resolveRef(ref);
  return n && doc.isSuperseded(n) ? doc.byKey.get(n.key) ?? n : n;
}
