import { test } from "node:test";
import assert from "node:assert/strict";
import { calculate, type Adjustment, type CalcInput, type LineInput } from "./calculator";

const L = (name: string, quantity: number, unitCents: number | null): LineInput => ({
  itemId: name,
  name,
  unitLabel: "each",
  quantity,
  unitCents,
  taxable: true,
  source: "pricebook",
});
const ov = (amountCents: number): Adjustment => ({ kind: "override", amountCents, reason: "owner", memberId: "m" });
const base: Omit<CalcInput, "lines"> = { rules: [], minimumCents: null, adjustments: [], taxRateBp: null };
const palmInput: CalcInput = { lines: [L("a", 28, 1200), L("b", 28, 200)], rules: [], minimumCents: 15000, adjustments: [], taxRateBp: null };

test("28 x $12 + 28 x $2 meets the $150 minimum", () => {
  const palm = calculate(palmInput);
  assert.equal(palm.state, "ready");
  assert.equal(palm.totalCents, 39200);
  assert.equal(palm.minimumAppliedCents, 0);
});

test("minimum applies when the subtotal is below it", () => {
  assert.equal(calculate({ ...base, lines: [L("a", 2, 1200)], minimumCents: 15000 }).minimumAppliedCents, 12600);
});

test("an unpriced line blocks the quote and is named", () => {
  const u = calculate({ ...base, lines: [L("a", 16, 1200), { ...L("skylight", 2, null), source: "unpriced" }] });
  assert.equal(u.state, "needs_owner");
  assert.deepEqual(u.reasons, ["unpriced:skylight"]);
  assert.equal(u.lines[1].totalCents, null);
});

test("fixed rule adds once", () => {
  const r = calculate({
    ...base,
    lines: [L("a", 10, 1000)],
    rules: [{ ruleId: "r1", text: "+$50 3rd story", effect: { op: "add_fixed", amount: 5000, appliesTo: "any" } }],
  });
  assert.equal(r.totalCents, 15000);
  assert.deepEqual(r.ruleLines, [{ ruleId: "r1", label: "+$50 3rd story", cents: 5000 }]);
});

test("per-unit and percent rules", () => {
  assert.equal(
    calculate({ ...base, lines: [L("a", 10, 1000)], rules: [{ ruleId: "r", text: "", effect: { op: "add_per_unit", amount: 100, appliesTo: ["a"] } }] }).totalCents,
    11000,
  );
  assert.equal(
    calculate({ ...base, lines: [L("a", 10, 1000)], rules: [{ ruleId: "r", text: "", effect: { op: "percent", amount: 1000, appliesTo: "any" } }] }).totalCents,
    11000,
  );
});

test("rules only count the lines they apply to; null-effect rules add no line", () => {
  const r = calculate({
    ...base,
    lines: [L("a", 10, 1000), L("b", 5, 500)],
    rules: [
      { ruleId: "p", text: "p", effect: { op: "percent", amount: 1000, appliesTo: ["b"] } },
      { ruleId: "n", text: "note only", effect: null },
    ],
  });
  assert.equal(r.ruleLines.length, 1);
  assert.equal(r.ruleLines[0].cents, 250);
  assert.equal(r.totalCents, 12750);
});

test("override replaces the total and records the adjustment", () => {
  const o = calculate({ ...palmInput, adjustments: [ov(37500)] });
  assert.equal(o.totalCents, 37500);
  assert.equal(o.adjustmentCents, -1700);
  assert.equal(o.state, "ready");
});

test("two overrides need the owner", () => {
  const r = calculate({ ...palmInput, adjustments: [ov(37500), ov(38000)] });
  assert.equal(r.state, "needs_owner");
  assert.ok(r.reasons.includes("multiple_overrides"));
});

test("a discount subtracts from the subtotal", () => {
  const r = calculate({ ...base, lines: [L("a", 1, 10000)], adjustments: [{ kind: "discount", amountCents: 1500, reason: "", memberId: "m" }] });
  assert.equal(r.adjustmentCents, -1500);
  assert.equal(r.totalCents, 8500);
});

test("a discount below zero clamps and flags", () => {
  const neg = calculate({ ...base, lines: [L("a", 1, 1000)], adjustments: [{ kind: "discount", amountCents: 5000, reason: "", memberId: "m" }] });
  assert.equal(neg.totalCents, 0);
  assert.equal(neg.state, "needs_owner");
  assert.ok(neg.reasons.includes("negative_total"));
});

test("tax applies to taxable lines only, 7%", () => {
  const t = calculate({ ...base, lines: [L("a", 1, 10000), { ...L("labor", 1, 5000), taxable: false }], taxRateBp: 700 });
  assert.equal(t.taxableCents, 10000);
  assert.equal(t.taxCents, 700);
  assert.equal(t.totalCents, 15700);
});

test("rules are taxed in proportion to the taxable share of the lines", () => {
  const t = calculate({
    ...base,
    lines: [L("a", 1, 10000), { ...L("labor", 1, 10000), taxable: false }],
    rules: [{ ruleId: "f", text: "fee", effect: { op: "add_fixed", amount: 1000, appliesTo: "any" } }],
    taxRateBp: 1000,
  });
  assert.equal(t.taxableCents, 10500);
  assert.equal(t.taxCents, 1050);
  assert.equal(t.totalCents, 22050);
});

test("hash is stable and changes with input", () => {
  assert.equal(calculate(palmInput).hash, calculate(palmInput).hash);
  assert.match(calculate(palmInput).hash, /^[0-9a-f]{64}$/);
  assert.notEqual(calculate(palmInput).hash, calculate({ ...palmInput, minimumCents: 1 }).hash);
});

test("hash ignores object key order", () => {
  const a = calculate({ lines: [L("a", 1, 100)], rules: [], minimumCents: null, adjustments: [], taxRateBp: null });
  const b = calculate({ taxRateBp: null, adjustments: [], minimumCents: null, rules: [], lines: [{ source: "pricebook", taxable: true, unitCents: 100, quantity: 1, unitLabel: "each", name: "a", itemId: "a" }] });
  assert.equal(a.hash, b.hash);
});

test("bad quantity is flagged", () => {
  assert.deepEqual(calculate({ ...base, lines: [L("a", 0, 1200)] }).reasons, ["bad_quantity:a"]);
  assert.deepEqual(calculate({ ...base, lines: [L("a", Number.NaN, 1200)] }).reasons, ["bad_quantity:a"]);
});

test("minimum is not applied while the quote needs the owner", () => {
  const r = calculate({ ...base, lines: [L("a", 1, 1000), L("b", 1, null)], minimumCents: 15000 });
  assert.equal(r.minimumAppliedCents, 0);
});

test("per-unit rule yields integer cents with fractional quantities", () => {
  const r = calculate({
    ...base,
    lines: [L("a", 2.5, 1000)],
    rules: [{ ruleId: "r", text: "", effect: { op: "add_per_unit", amount: 33, appliesTo: "any" } }],
  });
  assert.ok(Number.isInteger(r.ruleLines[0].cents));
  assert.equal(r.ruleLines[0].cents, 83);
  assert.equal(r.totalCents, 2500 + 83);
});

test("per-unit rule ignores lines with a bad quantity", () => {
  const r = calculate({
    ...base,
    lines: [L("a", 4, 1000), L("b", Number.NaN, 1000), L("c", -3, 1000)],
    rules: [{ ruleId: "r", text: "", effect: { op: "add_per_unit", amount: 100, appliesTo: "any" } }],
  });
  assert.equal(r.ruleLines[0].cents, 400);
  assert.equal(r.state, "needs_owner");
  assert.deepEqual(r.reasons, ["bad_quantity:b", "bad_quantity:c"]);
});

test("one total override prices a quote whose lines are unpriced", () => {
  const unpriced = (name: string, quantity: number): LineInput => ({ ...L(name, quantity, null), itemId: null, source: "unpriced" });
  const r = calculate({ ...base, lines: [unpriced("windows", 28), unpriced("screens", 28)], minimumCents: 15000, adjustments: [ov(40000)] });
  assert.equal(r.state, "ready");
  assert.deepEqual(r.reasons, []);
  assert.equal(r.preTaxCents, 40000);
  assert.equal(r.totalCents, 40000);
  assert.equal(r.minimumAppliedCents, 0);
  // Taxable lines with no prices of their own still make the override taxable.
  const taxed = calculate({ ...base, lines: [unpriced("windows", 28)], adjustments: [ov(40000)], taxRateBp: 700 });
  assert.equal(taxed.taxCents, 2800);
  assert.equal(taxed.totalCents, 42800);
  const exempt = calculate({ ...base, lines: [{ ...unpriced("labor", 1), taxable: false }], adjustments: [ov(40000)], taxRateBp: 700 });
  assert.equal(exempt.taxCents, 0);
});

test("an override does not clear a bad quantity, and two overrides still leave the line unpriced", () => {
  const bad = calculate({ ...base, lines: [L("a", 0, 1200), L("b", 1, null)], adjustments: [ov(40000)] });
  assert.deepEqual(bad.reasons, ["bad_quantity:a"]);
  const two = calculate({ ...base, lines: [L("b", 1, null)], adjustments: [ov(40000), ov(41000)] });
  assert.deepEqual(two.reasons, ["unpriced:b", "multiple_overrides"]);
});
