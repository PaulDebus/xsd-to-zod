// Document-order tracking. The compact parser shape groups repeated siblings
// under one key, losing cross-tag document order; the lax tier preserves it so
// interleaved repeated compositor children (and wildcard extras sitting
// between declared fields) survive the round-trip. Two WeakMaps with distinct
// lifecycles: the parser's attachment order per raw node (written by
// OrderTrackingCompactBuilder, read during the walk) and the retained order
// per result object (written by record, consulted by the serializer).
import { CompactBuilder } from "@nodable/compact-builder";
import type { XmlFieldMeta } from "./xmlMeta.js";

/** Raw parser-node occurrence claimed by a field, index-aligned with the field's value array. */
export type ClaimedOccurrence = { rawKey: string; rawValue: unknown; index: number };
/** One element child in document order: result key + index within that key's value array. */
export type DocumentOrderEntry = [key: string, index: number];
/** One element field's occurrences claimed from the raw node. */
export type ElementRead = { key: string; isArray: boolean; claimed: ClaimedOccurrence[] };

export class DocumentOrderTracker {
  private readonly childOrderStore = new WeakMap<object, [string, unknown][]>();
  private readonly retainedStore = new WeakMap<object, DocumentOrderEntry[]>();

  /** Record one child attachment (OrderTrackingCompactBuilder's choke point). */
  noteAttachment(target: object, key: string, value: unknown): void {
    let order = this.childOrderStore.get(target);
    if (order === undefined) {
      order = [];
      this.childOrderStore.set(target, order);
    }
    order.push([key, value]);
  }

  /**
   * Children of a parsed node in document order, when the node came out of
   * the parser (undefined for programmatically built nodes).
   */
  childOrderOf(node: object): [string, unknown][] | undefined {
    return this.childOrderStore.get(node);
  }

  /** Retained order of a parsed result object (undefined when not recorded). */
  orderOf(obj: object): DocumentOrderEntry[] | undefined {
    return this.retainedStore.get(obj);
  }

  /**
   * Record the result object's element children in document order. Field
   * claims map each raw occurrence to its slot in the result; unclaimed
   * children (and overflow occurrences of scalar fields) are wildcard extras
   * resolved through extraKeyOf when an xs:any sweep captured them. When
   * extraKeyOf is undefined (no element wildcard) extras are dropped from the
   * data and the recording alike.
   */
  record(
    result: Record<string, unknown>,
    node: Record<string, unknown>,
    elementReads: readonly ElementRead[],
    extraKeyOf?: (rawKey: string, rawValue: unknown) => string,
  ): void {
    const order = this.childOrderStore.get(node);
    if (order === undefined) {
      return;
    }
    // Claims per raw node key, FIFO per raw value. The invariant the queue
    // relies on: the field scan and the order walk both iterate a given raw
    // tag's occurrences in document order.
    type PendingClaim = [key: string, index: number, isArray: boolean];
    const claims = new Map<string, Map<unknown, PendingClaim[]>>();
    for (const read of elementReads) {
      for (const claim of read.claimed) {
        let byValue = claims.get(claim.rawKey);
        if (byValue === undefined) {
          byValue = new Map();
          claims.set(claim.rawKey, byValue);
        }
        const queue = byValue.get(claim.rawValue) ?? [];
        queue.push([read.key, claim.index, read.isArray]);
        byValue.set(claim.rawValue, queue);
      }
    }
    const extraCounts = new Map<string, number>();
    const retained: DocumentOrderEntry[] = [];
    for (const [rawKey, rawValue] of order) {
      if (rawKey.startsWith("@_") || rawKey === "#text" || rawKey === "#cdata") {
        continue;
      }
      const claim = claims.get(rawKey)?.get(rawValue)?.shift();
      if (claim !== undefined) {
        const [key, index, isArray] = claim;
        if (isArray || index === 0) {
          retained.push([key, index]);
          continue;
        }
      }
      if (extraKeyOf === undefined) {
        continue;
      }
      // Wildcard extra (or scalar overflow, which the sweep captures as one).
      // The retained-first-occurrence rule must stay in lockstep with the
      // wildcard sweep's scalar-overflow capture — both count occurrences in
      // the same scan order.
      const extraKey = extraKeyOf(rawKey, rawValue);
      const index = extraCounts.get(extraKey) ?? 0;
      extraCounts.set(extraKey, index + 1);
      retained.push([extraKey, index]);
    }
    if (retained.length > 0) {
      this.retainedStore.set(result, retained);
    }
  }

  /**
   * Re-key the retained order across zod's safeParse rebuild (the walked and
   * validated trees are structurally isomorphic). The recording is
   * index-based, so it transfers verbatim: zod's rebuild preserves array
   * positions (added defaults are caught by usable's staleness check).
   */
  transfer(walked: unknown, parsed: unknown): void {
    if (
      walked === null ||
      parsed === null ||
      typeof walked !== "object" ||
      typeof parsed !== "object"
    ) {
      return;
    }
    const order = this.retainedStore.get(walked);
    if (order !== undefined) {
      this.retainedStore.delete(walked);
      this.retainedStore.set(parsed, order);
    }
  }

  /**
   * The retained document order describes the data as parsed. It is honored
   * only while it still does: every declared element field and every wildcard
   * extra must hold exactly as many values as the recording. The check is
   * cardinality-only (counts per field/extra), not value identity — a value
   * swapped between two equal-count fields is still replayed at its recorded
   * position. Added, removed, or re-parented values (and defaults zod filled
   * after the walk) break the correspondence, and objects with mixed content
   * keep the schema-order path since text interleaving is not modeled.
   * Anything else falls back to schema-order emission.
   */
  usable(
    obj: Record<string, unknown>,
    fields: Record<string, XmlFieldMeta>,
    hasElementWildcard: boolean,
    isSyntheticKey: (key: string) => boolean,
  ): DocumentOrderEntry[] | undefined {
    const retained = this.retainedStore.get(obj);
    if (retained === undefined) {
      return undefined;
    }
    const counts = matchCounts(retained, obj, fields);
    if (counts === undefined) {
      return undefined;
    }
    // Remaining retained keys are wildcard extras (clark keys): they must
    // match the data's extras one-to-one, with none left over on either side.
    if (hasElementWildcard) {
      for (const [key, value] of Object.entries(obj)) {
        if (key in fields || value === undefined || key.startsWith("@") || isSyntheticKey(key)) {
          continue;
        }
        if (counts.get(key) !== countOf(value)) {
          return undefined;
        }
        counts.delete(key);
      }
    }
    return counts.size === 0 ? retained : undefined;
  }

  /**
   * Same correspondence rule as usable, for an order recording whose extras
   * live outside the object (an unknown-xsi:type capture): every declared
   * element field and every captured extra must still hold exactly as many
   * values as the recording.
   */
  usableCapture(
    order: DocumentOrderEntry[],
    extras: Record<string, unknown[]>,
    obj: Record<string, unknown>,
    fields: Record<string, XmlFieldMeta>,
  ): DocumentOrderEntry[] | undefined {
    const counts = matchCounts(order, obj, fields);
    if (counts === undefined) {
      return undefined;
    }
    for (const [key, count] of counts) {
      if ((extras[key]?.length ?? 0) !== count) {
        return undefined;
      }
    }
    return order;
  }

  /**
   * Assemble children in document order from occurrences pre-built in schema
   * order: buffered holds each element field's occurrence strings (undefined
   * entries are holes from missing values — skipped). Entries without a buffer
   * are extras (resolved through extraOf) passed to emitExtra. Pre-building
   * keeps namespace prefix allocation observing the same field sequence as the
   * schema-order path.
   */
  replay(
    order: readonly DocumentOrderEntry[],
    buffered: ReadonlyMap<string, readonly (string | undefined)[]>,
    extraOf: (key: string) => unknown,
    emit: (xml: string) => void,
    emitExtra: (key: string, item: unknown) => void,
  ): void {
    for (const [key, index] of order) {
      const built = buffered.get(key);
      if (built !== undefined) {
        const emitted = built[index];
        if (emitted !== undefined) {
          emit(emitted);
        }
        continue;
      }
      const value = extraOf(key);
      const item = Array.isArray(value) ? value[index] : value;
      if (item !== undefined) {
        emitExtra(key, item);
      }
    }
  }
}

const countOf = (value: unknown): number =>
  value === undefined ? 0 : Array.isArray(value) ? value.length : 1;

// Counts per recorded key minus the declared element fields' current counts;
// undefined on any mismatch (or mixed content, which takes the schema-order
// path). Leftover counts belong to extras.
const matchCounts = (
  order: readonly DocumentOrderEntry[],
  obj: Record<string, unknown>,
  fields: Record<string, XmlFieldMeta>,
): Map<string, number> | undefined => {
  const counts = new Map<string, number>();
  for (const [key] of order) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, fieldMeta] of Object.entries(fields)) {
    if (fieldMeta.kind === "text") {
      return undefined;
    }
    if (fieldMeta.kind !== "element") {
      continue;
    }
    if (countOf(obj[key]) !== (counts.get(key) ?? 0)) {
      return undefined;
    }
    counts.delete(key);
  }
  return counts;
};

/** Shared tracker instance: parser, walker and serializer must agree. */
export const documentOrderTracker = new DocumentOrderTracker();

/**
 * Children of a parsed node in document order, when the node came out of the
 * parser (undefined for programmatically built nodes).
 */
export const childOrderOf = (node: object): [string, unknown][] | undefined =>
  documentOrderTracker.childOrderOf(node);

// CompactBuilder with the same grouping semantics plus order tracking in the
// tracker. _addChildTo is the single choke point every child attachment goes
// through; it is not part of the upstream type declarations, so the grouping
// logic is mirrored here.
export class OrderTrackingCompactBuilder extends CompactBuilder {
  _addChildTo(
    key: string,
    val: unknown,
    node: Record<string, unknown> | string,
    forceArray: boolean,
  ): Record<string, unknown> {
    const target: Record<string, unknown> = typeof node === "string" ? {} : node;
    documentOrderTracker.noteAttachment(target, key, val);
    if (Object.hasOwn(target, key)) {
      const existing = target[key];
      if (Array.isArray(existing)) {
        existing.push(val);
      } else {
        target[key] = [existing, val];
      }
    } else {
      target[key] = forceArray ? [val] : val;
    }
    return target;
  }
}
