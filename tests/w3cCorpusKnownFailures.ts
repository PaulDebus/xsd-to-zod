// Known failures for the full-corpus suite (#108 Phase 4), keyed by
// `<testSet-relative-path>/<testGroup>/<instanceTest>`. Entries run as
// `it.fails` — a fix that makes a case pass turns the suite red; remove the
// entry in the same PR. Generated from full corpus runs, then hand-maintained.
export const W3C_CORPUS_REASONS = {
  noRootDeclaration: "no root declaration: the schema declares no global element matching the instance root (a type-library schema — instance validity rides xsi:type root assessment), so the generated artifact has no root schema to parse with",
  libxmlStrictWildcardXsiType:
    "libxml2 gap: strict-wildcard item with xsi:type but no global element declaration is rejected — the XSD xsi:type fallback is unimplemented (the original instance fails libxml2 too)",
  libxmlGap:
    "libxml2 gap: the original instance/schema fails libxml2 itself (pre-errata XSD 1.0 gMonth lexical, maxOccurs beyond libxml2's integer range, libxml2's XSD-regex dialect rejecting valid patterns or NameChar editions) — the zod-tier round-trip succeeds",
} as const;

export const W3C_CORPUS_KNOWN_FAILURES = new Map<string, string>([
  ["msMeta/Additional_w3c.xml/addB116/addB116.v", W3C_CORPUS_REASONS.libxmlStrictWildcardXsiType],
  ["msMeta/Additional_w3c.xml/addB187/addB187.v", W3C_CORPUS_REASONS.noRootDeclaration],
  ["msMeta/DataTypes_w3c.xml/gMonth002_2061/gMonth002_2061.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/DataTypes_w3c.xml/gMonth004_2063/gMonth004_2063.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Group_w3c.xml/groupF009v/groupF009v.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Group_w3c.xml/groupH009v/groupH009v.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Group_w3c.xml/groupJ009v/groupJ009v.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Group_w3c.xml/groupL009v/groupL009v.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Group_w3c.xml/groupN009v/groupN009v.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/ModelGroups_w3c.xml/mgA015/mgA015.v", W3C_CORPUS_REASONS.libxmlGap],

  ["msMeta/Regex_w3c.xml/RegexTest_42/RegexTest_42.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Regex_w3c.xml/RegexTest_73/RegexTest_73.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Regex_w3c.xml/reF43/reF43.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Regex_w3c.xml/reK4/reK4.v", W3C_CORPUS_REASONS.libxmlGap],
  ["msMeta/Regex_w3c.xml/reZ006i/reZ006i.i", W3C_CORPUS_REASONS.libxmlGap],
  ["sunMeta/CType.testSet/targetns00101m/targetNS00101m1_p", W3C_CORPUS_REASONS.noRootDeclaration],
  ["sunMeta/SType.testSet/st_name00401m/ST_name00401m1_p", W3C_CORPUS_REASONS.noRootDeclaration],
  ["sunMeta/SType.testSet/st_targetns00101m/ST_targetNS00101m1_p", W3C_CORPUS_REASONS.noRootDeclaration],
  ["sunMeta/SType.testSet/st_targetns00101m/ST_targetNS00101m2_p", W3C_CORPUS_REASONS.noRootDeclaration],
  ["sunMeta/SType.testSet/st_targetns00201m/ST_targetNS00201m1_p", W3C_CORPUS_REASONS.noRootDeclaration],
]);
