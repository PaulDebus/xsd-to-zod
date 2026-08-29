// Known failures for the full-corpus suite (#108 Phase 4), keyed by
// `<testSet-relative-path>/<testGroup>/<instanceTest>`. Entries run as
// `it.fails` — a fix that makes a case pass turns the suite red; remove the
// entry in the same PR. Generated from full corpus runs, then hand-maintained.
export const W3C_CORPUS_REASONS = {
  choiceDocumentOrder:
    "choice: interleaved repeated branches collapse into per-element arrays; document order is lost and the serialized XML no longer validates",
  libxmlRejectsSerialized: "libxml2 rejects serialized XML (needs triage)",
  libxmlStrictWildcardXsiType:
    "libxml2 gap: strict-wildcard item with xsi:type but no global element declaration is rejected — the XSD xsi:type fallback is unimplemented (the original instance fails libxml2 too)",
  libxmlGap:
    "libxml2 gap: the original instance/schema fails libxml2 itself (pre-errata XSD 1.0 gMonth lexical, maxOccurs beyond libxml2's integer range, libxml2's XSD-regex dialect rejecting valid patterns or NameChar editions) — the zod-tier round-trip succeeds",
  needsTriage: "needs triage",
  requiredArrayEmpty: "cardinality: required element array parsed empty (needs triage)",
  patternOnNonString:
    "runtime: pattern checked against coerced value, not the original lexical (lexical preservation needed)",
  simpleContentShape: "parse: simpleContent _text shape mismatch (needs triage)",
} as const;

export const W3C_CORPUS_KNOWN_FAILURES = new Map<string, string>([
  ["msMeta/Additional_w3c.xml/addB116/addB116.v", W3C_CORPUS_REASONS.libxmlStrictWildcardXsiType],
  ["msMeta/Additional_w3c.xml/addB187/addB187.v", W3C_CORPUS_REASONS.needsTriage],
  ["msMeta/DataTypes_w3c.xml/gMonth002_2061/gMonth002_2061.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/DataTypes_w3c.xml/gMonth004_2063/gMonth004_2063.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Group_w3c.xml/groupF009v/groupF009v.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Group_w3c.xml/groupH009v/groupH009v.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Group_w3c.xml/groupJ009v/groupJ009v.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Group_w3c.xml/groupL009v/groupL009v.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Group_w3c.xml/groupN009v/groupN009v.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/IdentityConstraint_w3c.xml/idF012/idF012.v", W3C_CORPUS_REASONS.libxmlRejectsSerialized],
  ["msMeta/IdentityConstraint_w3c.xml/idF013/idF013.v", W3C_CORPUS_REASONS.libxmlRejectsSerialized],
  ["msMeta/IdentityConstraint_w3c.xml/idF014/idF014.v", W3C_CORPUS_REASONS.libxmlRejectsSerialized],
  ["msMeta/ModelGroups_w3c.xml/mgA015/mgA015.v", W3C_CORPUS_REASONS.libxmlGap],

  ["msMeta/Regex_w3c.xml/RegexTest_42/RegexTest_42.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Regex_w3c.xml/RegexTest_73/RegexTest_73.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Regex_w3c.xml/reF43/reF43.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Regex_w3c.xml/reK4/reK4.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Regex_w3c.xml/reZ006i/reZ006i.i", W3C_CORPUS_REASONS.libxmlGap],
  ["sunMeta/CType.testSet/targetns00101m/targetNS00101m1_p", W3C_CORPUS_REASONS.needsTriage],
  ["sunMeta/ElemDecl.testSet/targetns00101m/targetNS00101m1_p", W3C_CORPUS_REASONS.needsTriage],
  ["sunMeta/SType.testSet/st_name00401m/ST_name00401m1_p", W3C_CORPUS_REASONS.needsTriage],
  ["sunMeta/SType.testSet/st_targetns00101m/ST_targetNS00101m1_p", W3C_CORPUS_REASONS.needsTriage],
  ["sunMeta/SType.testSet/st_targetns00101m/ST_targetNS00101m2_p", W3C_CORPUS_REASONS.needsTriage],
  ["sunMeta/SType.testSet/st_targetns00201m/ST_targetNS00201m1_p", W3C_CORPUS_REASONS.needsTriage],
]);
