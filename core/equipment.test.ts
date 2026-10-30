import assert from "node:assert/strict";
import { test } from "node:test";
import { carriesAll, cleanEquipment, equipmentKey, equipmentUnion, missingEquipment, MAX_EQUIPMENT } from "./equipment";

test("equipment words match trimmed, lowercase, spaces collapsed, and without a trailing s", () => {
  assert.equal(equipmentKey("  Trailers "), "trailer");
  assert.equal(equipmentKey("60in   Mower"), "60in mower");
  assert.equal(equipmentKey("Sprayer License"), "sprayer license");
  assert.equal(equipmentKey("s"), "s");
  assert.equal(equipmentKey("   "), "");
});

test("a saved list keeps the owner's words, once each, without blanks", () => {
  assert.deepEqual(cleanEquipment([" Trailer ", "trailers", "", "60in  mower", "Chipper"]), ["Trailer", "60in mower", "Chipper"]);
  assert.equal(cleanEquipment(Array.from({ length: 30 }, (_, i) => `thing ${i}`)).length, MAX_EQUIPMENT);
});

test("a job needs everything its items need, and a crew covers it between them", () => {
  const needs = equipmentUnion([["trailer"], ["Trailer", "chipper"], []]);
  assert.deepEqual(needs, ["trailer", "chipper"]);
  assert.deepEqual(missingEquipment(needs, [["Trailers", "60in mower"]]), ["chipper"]);
  assert.equal(carriesAll(needs, [["trailers"], ["Chipper"]]), true);
  assert.equal(carriesAll(needs, [["trailer"]]), false);
  assert.equal(carriesAll([], [[]]), true, "work that needs nothing goes to anyone");
  assert.deepEqual(missingEquipment(needs, []), ["trailer", "chipper"]);
});
