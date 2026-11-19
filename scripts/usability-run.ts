import assert from "node:assert/strict";
import { buildContact, roundTrip as roundTripContact } from "../testdata/usability/consumers/simple.js";
import {
  collection,
  roundTrip as roundTripCollection,
} from "../testdata/usability/consumers/inherited-choices.js";

const contactXml = roundTripContact(buildContact());
assert.match(contactXml, /Ada/);

assert.equal(roundTripCollection(collection), collection.id);

console.log("Usability consumers round-tripped.");
