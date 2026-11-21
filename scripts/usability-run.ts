import assert from "node:assert/strict";
import { buildContact, roundTrip as roundTripContact } from "../testdata/usability/consumers/simple.js";
import {
  addItemRef,
  buildCollection,
  parseModel,
  renameGroup,
  serializeModel,
  toCollectionModel,
} from "../testdata/usability/consumers/inherited-choices.js";

const contactXml = roundTripContact(buildContact());
assert.match(contactXml, /Ada/);

const model = toCollectionModel(buildCollection());
const edited = addItemRef(renameGroup(model, 0, "renamed group"), 0, "item-2");
const xml = serializeModel(edited);
const reparsed = parseModel(xml);

assert.equal(reparsed.id, model.id);
assert.equal(reparsed.groups[0]?.labels[0]?.text, "renamed group");
assert.deepEqual(reparsed.groups[0]?.itemRefs, ["item-1", "item-2"]);
assert.deepEqual(reparsed.items[0]?.limits, { min: "0", max: "10" });
assert.equal(serializeModel(reparsed), xml);

console.log("Usability consumers round-tripped.");
