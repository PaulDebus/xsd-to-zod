import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const corpusDir = "testdata/upstream/w3c-xsdtests";

export const assertW3cCorpus = () => {
  if (!fs.existsSync(corpusDir) || fs.readdirSync(corpusDir).length === 0) {
    throw new Error(
      "The W3C XSD test suite submodule is not checked out. Run " +
        "`git submodule update --init --recursive` before a corpus or release run.",
    );
  }
};

export default assertW3cCorpus;

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    assertW3cCorpus();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
