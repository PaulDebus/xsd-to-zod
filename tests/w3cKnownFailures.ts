// Known failures for the W3C sun/ms selection (#108), keyed by
// `<testSetName>/<testGroup>/<instanceTest>`. Each entry pins a genuine bug
// or an unsupported feature with its reason. Entries run as `it.fails`, so a
// fix that makes a case pass turns the suite red — remove the entry in the
// same PR that lands the fix. Generated from a full vitest run, then
// hand-maintained.
export const REASONS = {
  libxmlStrictWildcardXsiType:
    "libxml2 gap: strict-wildcard item with xsi:type but no global element declaration is rejected — the XSD xsi:type fallback is unimplemented (the original instance fails libxml2 too)",
  libxmlGap:
    "libxml2 gap: the original instance/schema fails libxml2 itself (pre-errata XSD 1.0 gMonth lexical, maxOccurs beyond libxml2's integer range) — the zod-tier round-trip succeeds",
  libxmlRejectsSerialized: "libxml2 rejects serialized XML (needs triage)",
  needsTriage: "needs triage",
  patternOnNonString:
    "runtime: pattern checked against coerced value, not the original lexical (lexical preservation needed)",
  choiceDocumentOrder:
    "choice: interleaved repeated branches collapse into per-element arrays; document order is lost and the serialized XML no longer validates",
  requiredArrayEmpty: "cardinality: required element array parsed empty (needs triage)",
  unionCoercion: "runtime: union member coercion rejects a valid value (needs triage)",
  simpleContentShape: "parse: simpleContent _text shape mismatch (needs triage)",
  fileResolution: "harness: test-set file resolution (needs triage)",
} as const;

export const W3C_KNOWN_FAILURES = new Map<string, string>([
  ["Additional/addB116/addB116.v", REASONS.libxmlStrictWildcardXsiType],
  ["Additional/addB187/addB187.v", REASONS.needsTriage],
  ["Additional/isDefault079/isDefault079.v", REASONS.needsTriage],
  ["Attribute/attO009/attO009.v", REASONS.needsTriage],
  ["Attribute/attO011/attO011.v", REASONS.needsTriage],
  ["CType/basetd00101m1/Positive", REASONS.simpleContentShape],
  ["CType/basetd00101m2/Positive", REASONS.simpleContentShape],
  ["CType/targetns00101m/targetNS00101m1_p", REASONS.needsTriage],
  ["DataTypes/gMonth002_2061/gMonth002_2061.v", REASONS.libxmlGap],
  ["DataTypes/gMonth004_2063/gMonth004_2063.v", REASONS.libxmlGap],
  ["ElemDecl/targetns00101m/targetNS00101m1_p", REASONS.needsTriage],
  ["ElemDecl/valueconstraint00501m1/Positive", REASONS.patternOnNonString],
  ["ElemDecl/valueconstraint00501m2/Positive", REASONS.patternOnNonString],
  ["ElemDecl/valueconstraint00501m4/Positive", REASONS.patternOnNonString],
  ["ElemDecl/valueconstraint00501m5/Positive", REASONS.patternOnNonString],
  ["ElemDecl/valueconstraint00601m7/Positive", REASONS.patternOnNonString],
  ["Element/QFE1700c2/QFE1700c2.v", REASONS.needsTriage],
  ["Errata10/errC001/errC001.v", REASONS.needsTriage],
  ["Group/groupF009v/groupF009v.v", REASONS.libxmlGap],
  ["Group/groupH009v/groupH009v.v", REASONS.libxmlGap],
  ["Group/groupJ009v/groupJ009v.v", REASONS.libxmlGap],
  ["Group/groupL009v/groupL009v.v", REASONS.libxmlGap],
  ["Group/groupN009v/groupN009v.v", REASONS.libxmlGap],
  ["ModelGroups/mgA015/mgA015.v", REASONS.libxmlRejectsSerialized],

  ["ModelGroups/mgO006/mgO006.v", REASONS.libxmlRejectsSerialized],
  ["ModelGroups/mgQ003/mgQ003.v", REASONS.choiceDocumentOrder],
  ["Particles/particlesQ030/particlesQ030.v", REASONS.libxmlRejectsSerialized],
  ["Particles/particlesQ032/particlesQ032.v", REASONS.libxmlRejectsSerialized],
  ["Particles/particlesZ005/particlesZ005.v", REASONS.needsTriage],
  ["Particles/particlesZ012/particlesZ012.v", REASONS.needsTriage],
  ["SimpleType/stE065/stE065.v", REASONS.libxmlRejectsSerialized],
  ["SimpleType/stE066/stE066.v", REASONS.libxmlRejectsSerialized],
  ["SType/st_name00401m/ST_name00401m1_p", REASONS.needsTriage],
  ["SType/st_targetns00101m/ST_targetNS00101m1_p", REASONS.needsTriage],
  ["SType/st_targetns00101m/ST_targetNS00101m2_p", REASONS.needsTriage],
  ["SType/st_targetns00201m/ST_targetNS00201m1_p", REASONS.needsTriage],
  ["suntest/xsd001/xsd001.v00", REASONS.needsTriage],
  ["suntest/xsd001/xsd001.v01", REASONS.needsTriage],
  ["suntest/xsd001/xsd001.v02", REASONS.needsTriage],
  ["suntest/xsd001/xsd001.v03", REASONS.needsTriage],
]);
