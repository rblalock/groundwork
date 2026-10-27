import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { UnitKind } from "../schema/types";
import { activeVertical, VERTICALS } from "./index";

const UNIT_KINDS: UnitKind[] = ["each", "sqft", "linear_ft", "hour", "visit", "flat", "other"];
const pack = VERTICALS.landscaping;
const saved = process.env.VERTICAL;

afterEach(() => {
  if (saved === undefined) delete process.env.VERTICAL;
  else process.env.VERTICAL = saved;
});

test("the landscaping pack has ten items with unique names and known unit kinds", () => {
  assert.equal(pack.items.length, 10);
  assert.equal(new Set(pack.items.map((i) => i.name)).size, 10);
  for (const item of pack.items) {
    assert.ok(UNIT_KINDS.includes(item.unitKind), `${item.name}: ${item.unitKind}`);
    assert.ok(Number.isInteger(item.priceCents) && item.priceCents > 0, item.name);
  }
});

test("every rule's appliesTo names an item in the pack, and the rush rule leaves haul-away out", () => {
  const names = new Set(pack.items.map((i) => i.name));
  for (const rule of pack.rules) {
    const appliesTo = rule.effect?.appliesTo;
    if (!Array.isArray(appliesTo)) continue;
    for (const name of appliesTo) assert.ok(names.has(name), `${rule.text}: ${name}`);
  }
  const rush = pack.rules.find((r) => r.text.toLowerCase().includes("rush"));
  assert.ok(rush?.effect && Array.isArray(rush.effect.appliesTo));
  assert.equal(rush.effect.appliesTo.length, 9);
  assert.ok(!rush.effect.appliesTo.includes("Haul-away"));
});

test("the minimum charge is profile data, not an item", () => {
  assert.equal(pack.minimumChargeCents, 15000);
  assert.ok(pack.items.every((i) => !i.name.toLowerCase().includes("minimum")));
});

test("activeVertical reads VERTICAL on each call", () => {
  delete process.env.VERTICAL;
  assert.equal(activeVertical(), null);
  process.env.VERTICAL = "none";
  assert.equal(activeVertical(), null);
  process.env.VERTICAL = "landscaping";
  assert.equal(activeVertical(), pack);
  // An unknown pack is no pack, with one warning however many turns read it.
  const warn = mock.method(console, "warn", () => {});
  process.env.VERTICAL = "plumbing";
  assert.equal(activeVertical(), null);
  assert.equal(activeVertical(), null);
  assert.equal(warn.mock.callCount(), 1);
  warn.mock.restore();
});
