import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDateOnly, isLanguage, LANGUAGES, localeFor } from "./language";

test("formatDateOnly does not shift across time zones", () => {
  assert.equal(formatDateOnly("2026-11-15", "en"), "November 15, 2026");
  assert.equal(formatDateOnly("2026-11-15", "es"), "15 de noviembre de 2026");
});
test("language guards and locales", () => {
  assert.deepEqual([...LANGUAGES], ["en", "es"]);
  assert.equal(isLanguage("es"), true);
  assert.equal(isLanguage("fr"), false);
  assert.equal(isLanguage(undefined), false);
  assert.equal(localeFor("en"), "en-US");
  assert.equal(localeFor("es"), "es-US");
});
