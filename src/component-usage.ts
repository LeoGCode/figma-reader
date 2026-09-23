// Where components are used, for figma_get_components. Kept apart from tools.ts, which starts a browser manager on import.
import { type FigDocument, type FigNode, guidId, type Raw } from "./fig-file.ts";

export interface ComponentUse {
  /** The instance node the use is recorded on. */
  instance: FigNode;
  component: FigNode;
  /** false: the instance itself is of this component. true: the component was swapped into it, by an override or an instance-swap property. */
  swap: boolean;
}

/**
 * Every use of a component in the file. An instance is a direct use of its main component (symbolData.symbolID). A
 * component also shows wherever it is swapped in: a nested instance swapped by an override on the outer instance
 * (symbolOverrides[].overriddenSymbolID), or an instance-swap property set on the instance or on a nested one
 * (componentPropAssignments, inline guidValue or variable-backed symbolIdValue). Icons are typically used this way only,
 * so counting symbolID alone reported them unused. Each swapped slot counts once per instance, however many override
 * entries record it: a slot is a path and the property that filled it, or a path and the component an override put
 * there, and one slot recorded both ways is still one.
 */
export function* componentUses(doc: FigDocument): Generator<ComponentUse> {
  /** Soft-deleted nodes and stale copies of a library asset (an older version kept for old instances) are not uses. */
  const gone = (n: FigNode) => !!n.isSoftDeleted || doc.isSuperseded(n);
  const symbol = (ref: Raw | undefined) => {
    let n = ref ? doc.resolveRef(ref) : undefined;
    // An instance can still name a stale copy of a library component; its uses belong to the copy that is exported,
    // the one the key resolves to, as extractVariables follows an alias to a stale variable.
    if (n && doc.isSuperseded(n)) n = doc.byKey.get(n.key);
    // A soft-deleted target is not skipped, unlike a soft-deleted instance: a component in the trash whose instances
    // are still on the canvas is still rendered, and its count is what says so. extractVariables drops a soft-deleted
    // variable because a token nothing can reference is no token; a use is a fact about the instance.
    return n?.type === "SYMBOL" ? n : undefined;
  };
  for (const instance of doc.nodes.values()) {
    if (instance.type !== "INSTANCE" || gone(instance)) continue;
    const main = symbol({ guid: instance.symbolData?.symbolID });
    if (main) yield { instance, component: main, swap: false };
    // One slot is one use however the swap was recorded. A slot carrying both a swap override and an instance-swap
    // property naming the same component counted twice; that no real file has been seen doing is why two different
    // components on one path are kept apart rather than letting either win.
    const slots = new Map<string, FigNode>();
    /** Which (path, component) pairs a property set, so the swap override that recorded the same slot can go. */
    const assigned = new Set<string>();
    const assignments = (path: string, list: Raw[] | undefined) => {
      for (const a of list ?? []) {
        const target = symbol(a.value?.guidValue ? { guid: a.value.guidValue } : a.varValue?.value?.symbolIdValue);
        if (!target) continue;
        // Every property an instance sets on itself shares the instance's own (empty) path, so the property is part
        // of the key: a button with a leading and a trailing icon property both set to the same icon renders it
        // twice, and keying by path and component alone reported that icon once, which is how icons look unused.
        slots.set(`${path}|${guidId(a.defID)}|${target.id}`, target);
        assigned.add(`${path}|${target.id}`);
      }
    };
    assignments("", instance.componentPropAssignments);
    for (const o of instance.symbolData?.symbolOverrides ?? []) {
      const path = (o.guidPath?.guids ?? []).map(guidId).join("/");
      const target = symbol({ guid: o.overriddenSymbolID });
      if (target) slots.set(`${path}|${target.id}`, target);
      assignments(path, o.componentPropAssignments);
    }
    // A property naming the component a swap override on its own path already named is that one slot recorded twice,
    // whichever of the two was read first.
    for (const key of assigned) slots.delete(key);
    for (const component of slots.values()) yield { instance, component, swap: true };
  }
}

export interface Usage {
  instances: number;
  swapInstances: number;
}

/** Use counts by component id. */
export function componentUsage(doc: FigDocument): Map<string, Usage> {
  const out = new Map<string, Usage>();
  for (const u of componentUses(doc)) {
    const e = out.get(u.component.id) ?? { instances: 0, swapInstances: 0 };
    if (u.swap) e.swapInstances++;
    else e.instances++;
    out.set(u.component.id, e);
  }
  return out;
}
