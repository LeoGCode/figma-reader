// Scene graphs for tests, written as flat node lists instead of real (unpublishable) design files.
import { deflateSync, zipSync } from "fflate";
import { compileSchema, encodeBinarySchema, parseSchema } from "kiwi-schema";
import { FigDocument } from "../src/fig-file.ts";

export const guid = (id: string) => {
  const [sessionID, localID] = id.split(":").map(Number);
  return { sessionID, localID };
};

/**
 * A node as tests write it: "1:2" ids, a parent id and optionally its fractional-index position among its siblings
 * (default: list order). Every other field is passed through as raw kiwi data.
 */
export interface TestNode {
  id: string;
  type: string;
  parent?: string;
  position?: string;
  name?: string;
  [field: string]: unknown;
}

/** Kiwi node changes. A DOCUMENT "0:0" is added when the list has none. */
export function nodeChanges(nodes: TestNode[]) {
  const all = nodes.some((n) => n.type === "DOCUMENT") ? nodes : [{ id: "0:0", type: "DOCUMENT", name: "Document" }, ...nodes];
  return all.map(({ id, parent, position, ...rest }, i) => ({
    ...structuredClone(rest),
    guid: guid(id),
    ...(parent ? { parentIndex: { guid: guid(parent), position: position ?? String.fromCharCode(0x21 + i) } } : {}),
  }));
}

export const figDoc = (nodes: TestNode[], fileKey = "test") => new FigDocument(fileKey, new Date(0), { nodeChanges: nodeChanges(nodes) });

/** Variables and their collections live on an internal-only page. */
export const internalPage: TestNode = { id: "0:9", type: "CANVAS", parent: "0:0", name: "Internal", internalOnly: true };

/** A variable collection; the first mode is the default (modes are stored out of order: sortPosition decides). */
export const variableSet = (id: string, name: string, modes: [string, string][], extra: object = {}): TestNode => ({
  id, type: "VARIABLE_SET", parent: "0:9", name,
  variableSetModes: modes.map(([modeId, modeName], i) => ({ id: guid(modeId), name: modeName, sortPosition: String.fromCharCode(0x61 + i) })).reverse(),
  ...extra,
});

/**
 * A value per mode id. `alias` names a variable by guid; `libraryAlias` by publish key only, as variables copied from
 * a library reference each other (resolved through byKey when the target is in the file).
 */
export type VariableFixtureValue = {
  color?: [number, number, number, number?];
  float?: number;
  text?: string;
  bool?: boolean;
  alias?: string;
  libraryAlias?: string;
};

/**
 * A variable. `set` is the collection's id, or `{ key }` for the assetRef-only reference that library variables use
 * (in real files, every variable of a library collection names its collection that way).
 */
export const variable = (
  id: string, set: string | { key: string }, name: string, type: string, values: Record<string, VariableFixtureValue>, extra: object = {},
): TestNode => ({
  id, type: "VARIABLE", parent: "0:9", name, variableResolvedType: type,
  variableSetID: typeof set === "string" ? { guid: guid(set) } : { assetRef: { key: set.key, version: "1:0" } },
  variableDataValues: {
    entries: Object.entries(values).map(([modeId, v]) => ({
      modeID: guid(modeId),
      variableData: {
        value:
          v.color ? { colorValue: { r: v.color[0], g: v.color[1], b: v.color[2], a: v.color[3] ?? 1 } }
          : v.float !== undefined ? { floatValue: v.float }
          : v.text !== undefined ? { textValue: v.text }
          : v.bool !== undefined ? { boolValue: v.bool }
          : { alias: v.libraryAlias ? { assetRef: { key: v.libraryAlias, version: "1:0" } } : { guid: guid(v.alias!) } },
      },
    })),
  },
  ...extra,
});

// Just enough of Figma's schema to round-trip the fields the .fig fixtures use. It carries guid, parentIndex, type,
// name and key only, so anything encoded through figBytes and decoded back holds no text, sizes, instances, variables
// or styles, whatever the TestNodes said: a test that needs those either builds its document with figDoc (no
// encoding) or writes a .fig with a schema of its own, as test/tools.test.ts does.
const SCHEMA = parseSchema(`
  struct GUID { uint sessionID; uint localID; }
  message ParentIndex { GUID guid = 1; string position = 2; }
  message NodeChange { GUID guid = 1; ParentIndex parentIndex = 2; string type = 3; string name = 4; string key = 5; }
  message Message { NodeChange[] nodeChanges = 1; }
`);
const codec = compileSchema(SCHEMA) as { encodeMessage(m: unknown): Uint8Array };

/** A real .fig archive: "fig-kiwi" canvas (deflated schema + message chunks), meta.json and images/. */
export function figBytes(nodes: TestNode[], opts: { meta?: object; images?: Record<string, Uint8Array> } = {}): Uint8Array {
  const chunk = (b: Uint8Array) => {
    const z = deflateSync(b);
    const out = new Uint8Array(4 + z.length);
    new DataView(out.buffer).setUint32(0, z.length, true);
    out.set(z, 4);
    return out;
  };
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode("fig-kiwi"));
  new DataView(header.buffer).setUint32(8, 15, true);
  const message = codec.encodeMessage({ nodeChanges: nodeChanges(nodes) });
  const canvas = new Uint8Array([...header, ...chunk(encodeBinarySchema(SCHEMA)), ...chunk(message)]);
  const files: Record<string, Uint8Array> = { "canvas.fig": canvas, "meta.json": new TextEncoder().encode(JSON.stringify(opts.meta ?? {})) };
  for (const [hash, bytes] of Object.entries(opts.images ?? {})) files[`images/${hash}`] = bytes;
  return zipSync(files);
}
