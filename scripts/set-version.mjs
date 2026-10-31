import fs from "node:fs";
import path from "node:path";

const [, , version] = process.argv;
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

if (version === undefined || !semver.test(version)) {
  console.error("usage: npm run version:set -- <semver>");
  process.exit(1);
}

const root = process.cwd();
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const writeJson = (file, value) => {
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
};

const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const versionFile = path.join(root, "src/version.ts");
const versionSource = fs.readFileSync(versionFile, "utf8");
const updatedVersionSource = versionSource.replace(
  /export const PACKAGE_VERSION = "[^"]+";/,
  `export const PACKAGE_VERSION = "${version}";`,
);

if (updatedVersionSource === versionSource) {
  console.error("src/version.ts: PACKAGE_VERSION assignment not found");
  process.exit(1);
}

pkg.version = version;
lock.version = version;
if (lock.packages?.[""] !== undefined) {
  lock.packages[""].version = version;
}

writeJson("package.json", pkg);
writeJson("package-lock.json", lock);
fs.writeFileSync(versionFile, updatedVersionSource);

console.log(`set version to ${version}`);
