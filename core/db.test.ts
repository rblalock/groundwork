import { test } from "node:test";
import assert from "node:assert/strict";
import { db, newId } from "./db";

test("newId uses the prefix and 16 hex chars", () => {
  assert.match(newId("qt"), /^qt_[0-9a-f]{16}$/);
});

test("db() throws a clear error without DATABASE_URL", () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.throws(() => db(), /DATABASE_URL/);
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});
