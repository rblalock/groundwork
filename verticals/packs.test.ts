import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { UnitKind } from "../schema/types";
import { activeVertical, VERTICALS } from "./index";

const UNIT_KINDS: UnitKind[] = ["each", "sqft", "linear_ft", "hour", "visit", "flat", "other"];
const NOTE_TITLES = ["How we quote", "Crew and schedule", "Service area"];
const packs = Object.entries(VERTICALS);
const saved = process.env.VERTICAL;

afterEach(() => {
  if (saved === undefined) delete process.env.VERTICAL;
  else process.env.VERTICAL = saved;
});

for (const [id, pack] of packs) {
  test(`the ${id} pack has 8 to 10 items with unique names, known unit kinds, and whole-cent prices`, () => {
    assert.equal(pack.id, id);
    assert.ok(pack.items.length >= 8 && pack.items.length <= 10, `${pack.items.length} items`);
    assert.equal(new Set(pack.items.map((i) => i.name.trim().toLowerCase())).size, pack.items.length);
    for (const item of pack.items) {
      assert.ok(UNIT_KINDS.includes(item.unitKind), `${item.name}: ${item.unitKind}`);
      assert.ok(item.unitLabel.trim(), item.name);
      assert.ok(Number.isInteger(item.priceCents) && item.priceCents > 0, item.name);
      for (const thing of item.equipment ?? []) assert.ok(thing.trim(), `${item.name}: blank equipment`);
    }
  });

  test(`every ${id} rule's appliesTo names an item in the pack`, () => {
    const names = new Set(pack.items.map((i) => i.name));
    assert.ok(pack.rules.length > 0);
    for (const rule of pack.rules) {
      const appliesTo = rule.effect?.appliesTo;
      if (!Array.isArray(appliesTo)) continue;
      assert.ok(appliesTo.length > 0, rule.text);
      for (const name of appliesTo) assert.ok(names.has(name), `${rule.text}: ${name}`);
    }
  });

  test(`the ${id} pack has its instructions, the three notes, and its minimum as profile data, not an item`, () => {
    assert.ok(pack.label.trim());
    assert.ok(pack.instructions.trim().length > 200);
    assert.deepEqual(pack.notes.map((n) => n.title), NOTE_TITLES);
    for (const note of pack.notes) assert.ok(note.body.trim(), note.title);
    assert.ok(pack.minimumChargeCents === null || (Number.isInteger(pack.minimumChargeCents) && pack.minimumChargeCents > 0));
    assert.ok(pack.items.every((i) => !i.name.toLowerCase().includes("minimum")));
  });
}

test("the landscaping pack keeps its ten items, the rush rule leaves haul-away out, and the minimum is $150", () => {
  const pack = VERTICALS.landscaping;
  assert.equal(pack.items.length, 10);
  const rush = pack.rules.find((r) => r.text.toLowerCase().includes("rush"));
  assert.ok(rush?.effect && Array.isArray(rush.effect.appliesTo));
  assert.equal(rush.effect.appliesTo.length, 9);
  assert.ok(!rush.effect.appliesTo.includes("Haul-away"));
  assert.equal(pack.minimumChargeCents, 15000);
});

test("activeVertical reads VERTICAL on each call", () => {
  delete process.env.VERTICAL;
  assert.equal(activeVertical(), null);
  process.env.VERTICAL = "none";
  assert.equal(activeVertical(), null);
  for (const [id, pack] of packs) {
    process.env.VERTICAL = id;
    assert.equal(activeVertical(), pack);
  }
  // An unknown pack is no pack, with one warning however many turns read it.
  const warn = mock.method(console, "warn", () => {});
  process.env.VERTICAL = "plumbing";
  assert.equal(activeVertical(), null);
  assert.equal(activeVertical(), null);
  assert.equal(warn.mock.callCount(), 1);
  warn.mock.restore();
});
