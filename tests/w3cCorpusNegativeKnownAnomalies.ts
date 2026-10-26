// Known anomalies for the full-corpus negative suite, keyed by
// `<testSet-relative-path>/<testGroup>/<instanceTest>`. An anomaly is an
// instance the suite marks INVALID that both the zod tier and libxml2 accept.
// Entries run as `it.fails` — a fix that makes a case pass turns the suite
// red; remove the entry in the same PR.
export const W3C_CORPUS_NEGATIVE_REASONS = {
  xsd10Difference: "both tiers accept (needs triage — likely XSD 1.0/1.1 expectation difference)",
  regexMetadata:
    "W3C suite metadata marks the instance invalid while its own annotation documents the value as valid (Unicode category/version drift, W3C bug 4113); both tiers accept",
  versionSpecific:
    "W3C suite expectation is version-specific (invalid for Unicode 4.0.0, valid for 6.0.0); both tiers follow modern Unicode and accept",
  danglingIdref:
    "libxml2 does not enforce IDREF referential resolution and the zod tier matches; both tiers accept the dangling IDREF",
  idrefSemantics:
    "ID/IDREF/IDREFS referential semantics are not enforced — the dangling IDREFS default is out of scope",
} as const;

export const W3C_CORPUS_NEGATIVE_KNOWN_ANOMALIES = new Map<string, string>([
  ["msMeta/Additional_w3c.xml/addB066/addB066.i", W3C_CORPUS_NEGATIVE_REASONS.xsd10Difference],
  ["msMeta/Attribute_w3c.xml/attZ014a/attZ014a.i", W3C_CORPUS_NEGATIVE_REASONS.xsd10Difference],
  ["msMeta/Attribute_w3c.xml/attZ014b/attZ014b.i", W3C_CORPUS_NEGATIVE_REASONS.xsd10Difference],
  ["msMeta/Element_w3c.xml/elemZ016/elemZ016.i", W3C_CORPUS_NEGATIVE_REASONS.xsd10Difference],
  ["msMeta/IdentityConstraint_w3c.xml/idZ012/idZ012.i", W3C_CORPUS_NEGATIVE_REASONS.idrefSemantics],
  [
    "msMeta/Particles_w3c.xml/particlesZ001/particlesZ001.i",
    W3C_CORPUS_NEGATIVE_REASONS.xsd10Difference,
  ],
  ["msMeta/Regex_w3c.xml/reJ11/reJ11.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reJ13/reJ13.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reJ19/reJ19.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reJ21/reJ21.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reJ23/reJ23.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reJ25/reJ25.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reJ29/reJ29.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reJ31/reJ31.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reJ33/reJ33.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reJ35/reJ35.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reJ61/reJ61.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reJ69/reJ69.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reJ75/reJ75.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reJ77/reJ77.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reS21/reS21.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reS42/reS42.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reT63/reT63.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reT84/reT84.i", W3C_CORPUS_NEGATIVE_REASONS.regexMetadata],
  ["msMeta/Regex_w3c.xml/reU6/reU6.i", W3C_CORPUS_NEGATIVE_REASONS.versionSpecific],
  ["msMeta/Regex_w3c.xml/reDH7a/reDH7a.i", W3C_CORPUS_NEGATIVE_REASONS.danglingIdref],
]);
