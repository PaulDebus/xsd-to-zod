import fs from "node:fs";

const corpusDir = "testdata/upstream/w3c-xsdtests";

if (!fs.existsSync(corpusDir) || fs.readdirSync(corpusDir).length === 0) {
  console.error(
    "The W3C XSD test suite submodule is not checked out. Run " +
      "`git submodule update --init --recursive` before a corpus or release run.",
  );
  process.exit(1);
}
