import type { QName } from "./types.js";

// Shared QName/Clark-notation helpers (#84). Clark notation: `{ns-uri}local`.

export const splitQName = (name: string): { prefix: string; local: string } => {
  const idx = name.indexOf(":");
  return idx === -1
    ? { prefix: "", local: name }
    : { prefix: name.slice(0, idx), local: name.slice(idx + 1) };
};

export const toClark = (nsUri: string | undefined, local: string): QName =>
  `{${nsUri ?? ""}}${local}`;

// Lenient split: non-Clark input is treated as a local name without namespace.
export const splitClark = (qname: string): { namespace: string; local: string } => {
  if (!qname.startsWith("{")) {
    return { namespace: "", local: qname };
  }
  const boundary = qname.indexOf("}");
  if (boundary === -1) {
    return { namespace: "", local: qname };
  }
  return {
    namespace: qname.slice(1, boundary),
    local: qname.slice(boundary + 1),
  };
};

// Strict split: undefined for input that is not in Clark notation.
export const trySplitClark = (qname: string): { ns: string; local: string } | undefined => {
  const match = qname.match(/^\{(.*)}(.*)$/);
  return match ? { ns: match[1]!, local: match[2]! } : undefined;
};

export const clarkToLocal = (qname: string): string => splitClark(qname).local;

// Names for synthetic types derived from a declared type (inline list item /
// union member types). The `${qname}_` prefix is load-bearing: redefine
// orphan cleanup in parseXsd deletes synthetics by that prefix.
export const syntheticChildName = (qname: QName, suffix: string): QName =>
  `${qname}${suffix}` as QName;
