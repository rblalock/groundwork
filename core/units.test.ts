import assert from "node:assert/strict";
import { test } from "node:test";
import { pluralUnit } from "./units";

test("an English unit reads plural for anything but 1", () => {
  assert.equal(pluralUnit(3, "cubic yard", "en"), "cubic yards");
  assert.equal(pluralUnit(40, "linear foot", "en"), "linear feet");
  assert.equal(pluralUnit(2, "square foot", "en"), "square feet");
  assert.equal(pluralUnit(2.5, "hour", "en"), "hours");
  assert.equal(pluralUnit(0, "visit", "en"), "visits");
  assert.equal(pluralUnit(4, "delivery", "en"), "deliveries");
  assert.equal(pluralUnit(4, "day", "en"), "days");
  assert.equal(pluralUnit(6, "inch", "en"), "inches");
  assert.equal(pluralUnit(2, "flat", "en"), "flats");
});

test("1 keeps the unit as written, and so does a word with no plural form", () => {
  assert.equal(pluralUnit(1, "cubic yard", "en"), "cubic yard");
  assert.equal(pluralUnit(1.001, "linear foot", "en"), "linear foot");
  assert.equal(pluralUnit(3, "each", "en"), "each");
  assert.equal(pluralUnit(30, "sq ft", "en"), "sq ft");
  assert.equal(pluralUnit(3, "", "en"), "");
  assert.equal(pluralUnit(3, " hour ", "en"), "hours");
});

test("case follows the label", () => {
  assert.equal(pluralUnit(2, "Foot", "en"), "Feet");
  assert.equal(pluralUnit(2, "YARD", "en"), "YARDS");
});

test("a Spanish unit takes an s unless it ends in one", () => {
  assert.equal(pluralUnit(3, "hora", "es"), "horas");
  assert.equal(pluralUnit(3, "metros", "es"), "metros");
  assert.equal(pluralUnit(1, "visita", "es"), "visita");
});
