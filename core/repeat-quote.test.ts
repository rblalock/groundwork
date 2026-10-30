import { test } from "node:test";
import assert from "node:assert/strict";
import type { LineResult } from "../schema/types";
import { lastTimeAdjustments, repeatDate, repeatProposal, repeatSummaryText } from "./repeat-quote";

const line = (over: Partial<LineResult>): LineResult => ({
  itemId: null,
  name: "",
  unitLabel: "",
  quantity: 1,
  unitCents: null,
  taxable: true,
  source: "pricebook",
  totalCents: null,
  ...over,
});

const ITEMS = new Map([
  ["itm_mow", { id: "itm_mow", name: "Lawn mowing", unitLabel: "visit", priceCents: 6500, status: "active" as const }],
  ["itm_mulch", { id: "itm_mulch", name: "Mulch installed", unitLabel: "cubic yard", priceCents: 10000, status: "active" as const }],
  ["itm_edge", { id: "itm_edge", name: "Bed edging", unitLabel: "linear foot", priceCents: 250, status: "retired" as const }],
]);

const LAST_TIME = [
  line({ itemId: "itm_mow", name: "Lawn mowing", unitLabel: "visit", quantity: 1, unitCents: 6500, totalCents: 6500 }),
  line({ itemId: "itm_mulch", name: "Mulch in the front beds", unitLabel: "cubic yard", quantity: 3, unitCents: 9500, totalCents: 28500 }),
  line({ itemId: "itm_edge", name: "Bed edging", unitLabel: "linear foot", quantity: 40, unitCents: 250, totalCents: 10000 }),
  line({ name: "Gate repair", unitLabel: "job", quantity: 1, unitCents: 8000, totalCents: 8000, source: "override" }),
];

function proposal() {
  return repeatProposal({
    title: "412 Oak St",
    customerId: "cus_maria",
    propertyId: "prop_oak",
    lines: LAST_TIME,
    ruleIds: ["rul_slope", "rul_rush", "rul_slope"],
    ruleLabels: new Map([["rul_gone", "Old rule"]]),
    items: ITEMS,
    rules: new Map([
      ["rul_slope", { id: "rul_slope", text: "Steep slope +10%", status: "active" as const }],
      ["rul_rush", { id: "rul_rush", text: "Rush job +$50", status: "retired" as const }],
    ]),
    privateNotes: "Repeat of 412 Oak St, Apr 12",
  });
}

test("each line is compared with today's price book: same, repriced, retired, or never in it", () => {
  const { lines } = proposal();
  assert.deepEqual(
    lines.map((l) => [l.name, l.change, l.thenUnitCents, l.nowUnitCents]),
    [
      ["Lawn mowing", "same", 6500, 6500],
      ["Mulch in the front beds", "repriced", 9500, 10000],
      ["Bed edging", "retired", 250, null],
      ["Gate repair", "unpriced", 8000, null],
    ],
  );
  assert.equal(lines[2].itemId, "itm_edge");
});

test("the create_quote input names items by id, keeps the member's words, and leaves retired and unsaved work unpriced", () => {
  const { createQuoteInput } = proposal();
  // No line carries a price: the calculator takes each from the price book.
  assert.ok(createQuoteInput.lines.every((l) => l.unitCents === undefined));
  assert.deepEqual(createQuoteInput, {
    title: "412 Oak St",
    customerId: "cus_maria",
    propertyId: "prop_oak",
    lines: [
      { itemId: "itm_mow", quantity: 1 },
      { itemId: "itm_mulch", quantity: 3, name: "Mulch in the front beds" },
      { name: "Bed edging", unitLabel: "linear foot", quantity: 40 },
      { name: "Gate repair", unitLabel: "job", quantity: 1 },
    ],
    ruleIds: ["rul_slope"],
    privateNotes: "Repeat of 412 Oak St, Apr 12",
  });
});

test("rules applied last time say whether they're still active; only active ones go on the new quote", () => {
  const { rules } = proposal();
  assert.deepEqual(rules, [
    { ruleId: "rul_slope", name: "Steep slope +10%", active: true },
    { ruleId: "rul_rush", name: "Rush job +$50", active: false },
  ]);
  const none = repeatProposal({ title: "x", customerId: null, propertyId: null, lines: [LAST_TIME[0]], ruleIds: ["rul_gone"], ruleLabels: new Map([["rul_gone", "Old rule"]]), items: ITEMS, rules: new Map(), privateNotes: "" });
  assert.deepEqual(none.rules, [{ ruleId: "rul_gone", name: "Old rule", active: false }]);
  assert.equal(none.createQuoteInput.ruleIds, undefined);
  assert.equal(none.createQuoteInput.customerId, undefined);
});

test("last time's set total and discounts are reported, never repeated", () => {
  assert.deepEqual(lastTimeAdjustments([]), { lastTimeOverrideCents: null, lastTimeDiscountCents: null });
  assert.deepEqual(
    lastTimeAdjustments([
      { kind: "override", amountCents: 45000, reason: "call it 450", memberId: "mem_1" },
      { kind: "discount", amountCents: 1000, reason: "neighbor", memberId: "mem_1" },
      { kind: "discount", amountCents: 500, reason: "repeat", memberId: "mem_1" },
    ]),
    { lastTimeOverrideCents: 45000, lastTimeDiscountCents: 1500 },
  );
});

test("the summary numbers the lines and says then, today, what changed, and what waits for the owner", () => {
  const { lines, rules } = proposal();
  const args = {
    title: "412 Oak St",
    date: "Apr 12",
    customerName: "Maria Alvarez",
    status: null,
    lines,
    rules,
    thenTotalCents: 45000,
    preview: { state: "needs_owner" as const, totalCents: 36500 },
    lastTimeOverrideCents: 45000,
    lastTimeDiscountCents: null,
  };
  assert.equal(
    repeatSummaryText(args, "en"),
    [
      "Same as 412 Oak St (Apr 12) for Maria Alvarez:",
      "1. Lawn mowing, 1 visit",
      "2. Mulch in the front beds, 3 cubic yards",
      "3. Bed edging, 40 linear feet",
      "4. Gate repair, 1 job",
      "",
      "Then $450; today $365 so far (Mulch in the front beds $95 → $100/cubic yard).",
      "Bed edging isn't in the price book now; it stays unpriced for the owner.",
      "Gate repair has no saved price; it stays unpriced for the owner.",
      'The rule "Rush job +$50" is retired, so it\'s left off.',
      "Last time the total was set by hand to $450.",
      "Quote it?",
    ].join("\n"),
  );
  const ready = repeatSummaryText({ ...args, lines: lines.slice(0, 1), rules: [], preview: { state: "ready", totalCents: 15000 }, lastTimeOverrideCents: null, status: "lost" }, "es");
  assert.equal(ready, ["Igual que 412 Oak St (Apr 12, perdida) para Maria Alvarez:", "1. Lawn mowing, 1 visit", "", "Antes $450; hoy $150.", "¿La cotizo?"].join("\n"));
});

test("the date reads in the business's time zone, with the year only when it isn't this year", () => {
  const now = new Date("2026-10-30T15:00:00Z");
  assert.equal(repeatDate(new Date("2026-04-12T15:00:00Z"), "en", "America/New_York", now), "Apr 12");
  // Late evening in New York is the next day in UTC.
  assert.equal(repeatDate(new Date("2026-04-13T02:00:00Z"), "en", "America/New_York", now), "Apr 12");
  assert.equal(repeatDate(new Date("2025-05-03T15:00:00Z"), "en", "America/New_York", now), "May 3, 2025");
});
