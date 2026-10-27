import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalDatabaseUrl } from "./test-db";

test("isLocalDatabaseUrl accepts local and compose hosts", () => {
  for (const url of [
    "postgres://dev:dev@localhost:55432/groundwork_test",
    "postgres://dev:dev@127.0.0.1:5432/x",
    "postgres://dev:dev@[::1]:5432/x",
    "postgres://dev:dev@postgres:5432/x",
    "postgres://dev:dev@db/x",
    "postgres://dev:dev@LOCALHOST/x",
  ]) {
    assert.equal(isLocalDatabaseUrl(url), true, url);
  }
});

test("isLocalDatabaseUrl rejects remote, lookalike, and unreadable URLs", () => {
  for (const url of [
    "postgres://u:p@ep-cool-123.us-east-2.aws.neon.tech/neondb",
    "postgres://u:p@localhost.example.com/x",
    "postgres://u:p@db.example.com/x",
    "postgres://u:p@10.0.0.5/x",
    "not a url",
    "",
    undefined,
  ]) {
    assert.equal(isLocalDatabaseUrl(url), false, String(url));
  }
});
