// Known failures for the W3C sun/ms selection, keyed by
// `<testSetName>/<testGroup>/<instanceTest>`. Each entry pins a genuine bug
// or an unsupported feature with its reason. Entries run as `it.fails`, so a
// fix that makes a case pass turns the suite red — remove the entry in the
// same PR that lands the fix. Generated from a full vitest run, then
// hand-maintained.
export const REASONS = {
  libxmlStrictWildcardXsiType:
    "libxml2 gap: strict-wildcard item with xsi:type but no global element declaration is rejected — the XSD xsi:type fallback is unimplemented (the original instance fails libxml2 too)",
  libxmlGap:
    "libxml2 gap: the original instance/schema fails libxml2 itself (pre-errata XSD 1.0 gMonth lexical, maxOccurs beyond libxml2's integer range, libxml2's XSD-regex dialect rejecting valid patterns or NameChar editions) — the zod-tier round-trip succeeds",
  noRootDeclaration:
    "no root declaration: the schema declares no global element matching the instance root (a type-library schema — instance validity rides xsi:type root assessment), so the generated artifact has no root schema to parse with",
  beyondSafeInteger:
    "integer beyond ±2^53: the default number mapping rejects out-of-safe-range lexicals rather than rounding them (exact at any magnitude only with integers: bigint)",
} as const;

export const W3C_KNOWN_FAILURES = new Map<string, string>([
  ["Additional/addB116/addB116.v", REASONS.libxmlStrictWildcardXsiType],
  ["Additional/addB129/addB129.v", REASONS.beyondSafeInteger],
  ["Additional/addB187/addB187.v", REASONS.noRootDeclaration],
  ["CType/targetns00101m/targetNS00101m1_p", REASONS.noRootDeclaration],
  ["ComplexType/ctI003/ctI003.v", REASONS.beyondSafeInteger],
  ["DataTypes/gMonth002_2061/gMonth002_2061.v", REASONS.libxmlGap],
  ["DataTypes/gMonth004_2063/gMonth004_2063.v", REASONS.libxmlGap],
  ["DataTypes/integer011_2151/integer011_2151.v", REASONS.beyondSafeInteger],
  ["DataTypes/long005_2171/long005_2171.v", REASONS.beyondSafeInteger],
  ["DataTypes/long007_2173/long007_2173.v", REASONS.beyondSafeInteger],
  ["DataTypes/long009_2175/long009_2175.v", REASONS.beyondSafeInteger],
  ["DataTypes/negativeInteger005_2166/negativeInteger005_2166.v", REASONS.beyondSafeInteger],
  ["DataTypes/nonNegativeInteger005_2206/nonNegativeInteger005_2206.v", REASONS.beyondSafeInteger],
  ["DataTypes/nonPositiveInteger005_2161/nonPositiveInteger005_2161.v", REASONS.beyondSafeInteger],
  ["DataTypes/positiveInteger005_2239/positiveInteger005_2239.v", REASONS.beyondSafeInteger],
  ["DataTypes/unsignedLong005_2211/unsignedLong005_2211.v", REASONS.beyondSafeInteger],
  ["DataTypes/unsignedLong007_2213/unsignedLong007_2213.v", REASONS.beyondSafeInteger],
  ["Element/elemO004/elemO004.v", REASONS.beyondSafeInteger],
  ["Element/elemO005/elemO005.v", REASONS.beyondSafeInteger],
  ["Group/groupF009v/groupF009v.v", REASONS.libxmlGap],
  ["Group/groupH009v/groupH009v.v", REASONS.libxmlGap],
  ["Group/groupJ009v/groupJ009v.v", REASONS.libxmlGap],
  ["Group/groupL009v/groupL009v.v", REASONS.libxmlGap],
  ["Group/groupN009v/groupN009v.v", REASONS.libxmlGap],
  ["MGroup/particles00301m1/Positive", REASONS.beyondSafeInteger],
  ["MGroup/particles00302m1/Positive", REASONS.beyondSafeInteger],
  ["ModelGroups/mgA015/mgA015.v", REASONS.libxmlGap],
  ["SimpleType/stG001/stG001.v", REASONS.beyondSafeInteger],
  ["SimpleType/stG006/stG006.v", REASONS.beyondSafeInteger],

  ["SType/st_name00401m/ST_name00401m1_p", REASONS.noRootDeclaration],
  ["SType/st_targetns00101m/ST_targetNS00101m1_p", REASONS.noRootDeclaration],
  ["SType/st_targetns00101m/ST_targetNS00101m2_p", REASONS.noRootDeclaration],
  ["SType/st_targetns00201m/ST_targetNS00201m1_p", REASONS.noRootDeclaration],
]);
