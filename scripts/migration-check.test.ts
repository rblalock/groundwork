import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { checkMigrations, guardDatabaseUrl, MIGRATIONS_DIR, missingMessage, missingMigrations, readMigrations } from "./migration-check.mjs";

const m = (tag: string, when: number) => ({ tag, when, hash: `hash_${tag}` });
const journal = [m("0000_a", 100), m("0001_b", 200), m("0002_c", 300)];

test("migration check: hashes and times match what drizzle's migrator records", () => {
  const ours = readMigrations();
  const drizzles = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
  assert.ok(ours.length >= 1);
  assert.deepEqual(
    ours.map((x) => [x.when, x.hash]),
    drizzles.map((x) => [x.folderMillis, x.hash]),
  );
  assert.equal(ours[0].tag, "0000_init");
});

test("migration check: nothing missing when every migration has a row", () => {
  const applied = journal.map((x) => ({ hash: x.hash, created_at: String(x.when) }));
  assert.deepEqual(missingMigrations(journal, applied), { missing: [], stranded: [] });
});

test("migration check: the newest unapplied migrations are missing, and drizzle-kit can apply them", () => {
  const result = missingMigrations(journal, [{ hash: "hash_0000_a", created_at: "100" }]);
  assert.deepEqual(result.missing.map((x) => x.tag), ["0001_b", "0002_c"]);
  assert.deepEqual(result.stranded, []);
  const message = missingMessage(result);
  assert.match(message, /missing 2 migrations/);
  assert.match(message, /- 0001_b\n {2}- 0002_c/);
  assert.match(message, /npm run db:migrate/);
  assert.match(message, /DATABASE_URL_UNPOOLED/);
  assert.doesNotMatch(message, /skips/);
});

test("migration check: a fresh database (no table) is missing everything", () => {
  assert.deepEqual(missingMigrations(journal, []).missing.map((x) => x.tag), ["0000_a", "0001_b", "0002_c"]);
  assert.match(missingMessage(missingMigrations(journal, [])), /missing 3 migrations/);
});

test("migration check: a row matches by hash or by created_at (an edited file still counts as applied)", () => {
  const applied = [
    { hash: "hash_0000_a", created_at: null },
    { hash: "stale_hash", created_at: 200n },
    { hash: "hash_0002_c", created_at: 300 },
  ];
  assert.deepEqual(missingMigrations(journal, applied).missing, []);
});

test("migration check: a gap older than the newest applied row is stranded: drizzle-kit migrate would skip it", () => {
  const applied = [
    { hash: "hash_0000_a", created_at: "100" },
    { hash: "hash_0002_c", created_at: "300" },
  ];
  const result = missingMigrations(journal, applied);
  assert.deepEqual(result.missing.map((x) => x.tag), ["0001_b"]);
  assert.deepEqual(result.stranded.map((x) => x.tag), ["0001_b"]);
  assert.match(missingMessage(result), /missing 1 migration from/);
  assert.match(missingMessage(result), /drizzle-kit migrate skips 0001_b/);
});

test("migration check: the guard prefers the unpooled URL and fails closed without one", async () => {
  assert.equal(guardDatabaseUrl({ DATABASE_URL: "pooled", DATABASE_URL_UNPOOLED: "direct" }), "direct");
  assert.equal(guardDatabaseUrl({ DATABASE_URL: "pooled" }), "pooled");
  assert.equal(guardDatabaseUrl({ DATABASE_URL_UNPOOLED: "" }), undefined);
  const result = await checkMigrations({ url: undefined });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /neither DATABASE_URL_UNPOOLED nor DATABASE_URL is set/);
});

// Against the test database (`npm run test:db`): it's migrated, so it has everything; a scratch schema
// holds a migrations table with some rows missing. Only reads the real table; drops the scratch schema.
const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL is not set";

test("migration check (db): the migrated test database has every migration", { skip }, async () => {
  const result = await checkMigrations({ url });
  assert.deepEqual(result, { ok: true, checked: readMigrations().length });
});

test("migration check (db): missing migrations are named, and a database without the table has none", { skip }, async () => {
  const sql = postgres(url!, { max: 1, onnotice: () => {} });
  const schema = `migration_check_${process.pid}`;
  try {
    await sql`create schema ${sql(schema)}`;
    const where = { schema, table: "__drizzle_migrations" };
    const none = await checkMigrations({ url, where });
    assert.equal(none.ok, false);
    assert.match(!none.ok ? none.message : "", /- 0000_init/);

    await sql`create table ${sql(schema)}.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
    const all = readMigrations();
    const kept = all.slice(0, -1);
    for (const x of kept) await sql`insert into ${sql(schema)}.__drizzle_migrations (hash, created_at) values (${x.hash}, ${x.when})`;
    const partial = await checkMigrations({ url, where });
    assert.equal(partial.ok, false);
    const message = !partial.ok ? partial.message : "";
    assert.match(message, /missing 1 migration\b/);
    for (const x of all.slice(-1)) assert.match(message, new RegExp(`- ${x.tag}`));
    for (const x of kept) assert.doesNotMatch(message, new RegExp(`- ${x.tag}\\b`));

    for (const x of all.slice(-1)) await sql`insert into ${sql(schema)}.__drizzle_migrations (hash, created_at) values (${x.hash}, ${x.when})`;
    assert.deepEqual(await checkMigrations({ url, where }), { ok: true, checked: all.length });
  } finally {
    await sql`drop schema if exists ${sql(schema)} cascade`;
    await sql.end();
  }
});

test("migration check (db): an unreachable database fails closed", { skip }, async () => {
  const result = await checkMigrations({ url: "postgres://nobody:nothing@127.0.0.1:1/none" });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /Can't read the production database's migrations/);
});

test("migration check: a journal entry without its SQL file is an error, not a pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-migrations-"));
  mkdirSync(join(dir, "meta"));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ entries: [{ tag: "0000_gone", when: 1 }] }));
  assert.throws(() => readMigrations(dir), /ENOENT/);
});
