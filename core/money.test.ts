import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCents, parseMoneyToCents, percentOf } from "./money";

test("parses plain, dollar, comma, and decimal forms", () => {
  assert.equal(parseMoneyToCents("12"), 1200);
  assert.equal(parseMoneyToCents("$12"), 1200);
  assert.equal(parseMoneyToCents("12.5"), 1250);
  assert.equal(parseMoneyToCents("12.50"), 1250);
  assert.equal(parseMoneyToCents("1,250"), 125000);
  assert.equal(parseMoneyToCents(" $1,234.56 "), 123456);
});
test("rejects negatives, three decimals, and words", () => {
  for (const bad of ["-5", "12.345", "150 min", "twelve", ""]) assert.equal(parseMoneyToCents(bad), null);
});
test("formats in both languages", () => {
  assert.equal(formatCents(39200, "en"), "$392.00");
  assert.equal(formatCents(39200, "en", { concise: true }), "$392");
  assert.equal(formatCents(39250, "en", { concise: true }), "$392.50");
  assert.equal(formatCents(39250, "es"), "$392.50");
});
test("percentOf rounds half up", () => { assert.equal(percentOf(1050, 700), 74); });
