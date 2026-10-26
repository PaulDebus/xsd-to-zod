import fs from "node:fs";
import path from "node:path";

const reportDir = path.resolve(".xsd-to-zod-tests");
const shardPattern = /^w3c-negative-corpus-.+\.json$/;

const shards = fs
  .readdirSync(reportDir)
  .filter((file) => shardPattern.test(file))
  .map((file) => ({
    file,
    report: JSON.parse(fs.readFileSync(path.join(reportDir, file), "utf8")),
  }))
  .sort((a, b) => String(a.report.label).localeCompare(String(b.report.label)));

if (shards.length === 0) {
  console.error("no w3c-negative-corpus shard reports found");
  process.exit(1);
}

const bySpecSection = {};
for (const { report } of shards) {
  for (const [anchor, tally] of Object.entries(report.bySpecSection ?? {})) {
    const entry = (bySpecSection[anchor] ??= { rejected: 0, lenient: 0, anomaly: 0 });
    entry.rejected += tally.rejected ?? 0;
    entry.lenient += tally.lenient ?? 0;
    entry.anomaly += tally.anomaly ?? 0;
  }
}

const merged = {
  generated: new Date().toISOString(),
  totalCases: shards.reduce((sum, s) => sum + (s.report.totalCases ?? 0), 0),
  knownAnomalies: shards.reduce((sum, s) => sum + (s.report.knownAnomalies ?? 0), 0),
  bySpecSection: Object.fromEntries(
    Object.entries(bySpecSection).sort(([a], [b]) => a.localeCompare(b)),
  ),
  lenientCases: shards.flatMap((s) => s.report.lenientCases ?? []).sort(),
  anomalyCases: shards.flatMap((s) => s.report.anomalyCases ?? []).sort(),
  shards: shards.map(({ report }) => ({
    label: report.label,
    totalCases: report.totalCases ?? 0,
    knownAnomalies: report.knownAnomalies ?? 0,
    lenientCases: (report.lenientCases ?? []).length,
    anomalyCases: (report.anomalyCases ?? []).length,
  })),
};

const out = path.join(reportDir, "w3c-negative-corpus.json");
fs.writeFileSync(out, `${JSON.stringify(merged, null, 2)}\n`);
console.log(
  `wrote ${path.relative(process.cwd(), out)}: ${merged.totalCases} cases, ` +
    `${merged.lenientCases.length} lenient, ${merged.anomalyCases.length} anomalies`,
);
