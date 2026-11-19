import assert from "node:assert/strict";
import { buildContact, roundTrip as roundTripContact } from "../testdata/usability/consumers/simple.js";
import { library, roundTrip as roundTripLibrary } from "../testdata/usability/consumers/iso-shaped.js";

const contactXml = roundTripContact(buildContact());
assert.match(contactXml, /Ada/);

assert.equal(roundTripLibrary(library), library.GUID);

console.log("Usability consumers round-tripped.");
