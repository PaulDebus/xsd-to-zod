import fs from "node:fs";
import path from "node:path";

const reportDir = path.resolve(".xsd-to-zod-tests");
const shardPattern = /^w3c-negative-corpus-.+\.json$/;

if (!fs.existsSync(reportDir)) {
  process.exit(0);
}

let removed = 0;
for (const file of fs.readdirSync(reportDir)) {
  if (shardPattern.test(file)) {
    fs.rmSync(path.join(reportDir, file), { force: true });
    removed += 1;
  }
}

if (removed > 0) {
  console.log(`removed ${removed} stale w3c-negative-corpus shard report(s)`);
}
