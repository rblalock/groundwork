// The production deploy guard: before a production build on Vercel, check that the database already has
// every migration in schema/migrations. It only reads (in a read-only transaction) and never migrates.
// Migrations are applied by a person with `npm run db:migrate` (README, "Deploy").
//
//   node scripts/migration-check.mjs     checks DATABASE_URL_UNPOOLED, else DATABASE_URL (`npm run db:check`)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../schema/migrations", import.meta.url));

/** The command that applies migrations to production, from a checkout with `.env.prod.local` (README, "Deploy"). */
export const MIGRATE_COMMAND =
  'DATABASE_URL="$(node --env-file=.env.prod.local -p process.env.DATABASE_URL_UNPOOLED)" npm run db:migrate';

/**
 * @typedef {{ tag: string; when: number; hash: string }} Migration  A migration in the journal, hashed as drizzle hashes it.
 * @typedef {{ hash: string; created_at: string | number | bigint | null }} AppliedRow  A row of drizzle.__drizzle_migrations.
 */

/**
 * The migrations in `meta/_journal.json`, in order, each with the sha256 of its SQL file: the same hash
 * and `when` that drizzle's migrator records in `__drizzle_migrations`.
 * @param {string} [dir]
 * @returns {Migration[]}
 */
export function readMigrations(dir = MIGRATIONS_DIR) {
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8"));
  return journal.entries.map((/** @type {{ tag: string; when: number }} */ entry) => ({
    tag: entry.tag,
    when: entry.when,
    hash: createHash("sha256").update(readFileSync(join(dir, `${entry.tag}.sql`), "utf8")).digest("hex"),
  }));
}

/**
 * Which journal migrations the database hasn't applied. A migration counts as applied when a row has its
 * hash or its `created_at` (drizzle stores the journal's `when` there). `stranded` are the missing ones
 * older than the newest applied row: `drizzle-kit migrate` only runs migrations newer than that, so it
 * would skip them.
 * @param {Migration[]} migrations
 * @param {AppliedRow[]} applied
 * @returns {{ missing: Migration[]; stranded: Migration[] }}
 */
export function missingMigrations(migrations, applied) {
  const hashes = new Set(applied.map((row) => row.hash));
  const times = new Set(applied.filter((row) => row.created_at != null).map((row) => Number(row.created_at)));
  const newest = times.size ? Math.max(...times) : -Infinity;
  const missing = migrations.filter((m) => !hashes.has(m.hash) && !times.has(m.when));
  return { missing, stranded: missing.filter((m) => m.when <= newest) };
}

/**
 * The build's error for missing migrations, naming each one and how to apply it.
 * @param {{ missing: Migration[]; stranded: Migration[] }} result
 */
export function missingMessage({ missing, stranded }) {
  const lines = [
    `The production database is missing ${missing.length} migration${missing.length === 1 ? "" : "s"} from schema/migrations:`,
    ...missing.map((m) => `  - ${m.tag}`),
    "",
    "This build stops here so the new code doesn't run against the old tables. Nothing was migrated.",
    "A person applies them from a checkout of this commit, after `vercel env pull --environment production .env.prod.local`:",
    `  ${MIGRATE_COMMAND}`,
    "then redeploys (README, \"Deploy\").",
  ];
  if (stranded.length) {
    lines.push(
      "",
      `drizzle-kit migrate skips ${stranded.map((m) => m.tag).join(", ")}: ${stranded.length === 1 ? "it is" : "they are"} older than the newest applied migration.`,
      "Apply that SQL by hand, then insert its hash and `when` into drizzle.__drizzle_migrations.",
    );
  }
  return lines.join("\n");
}

/**
 * Reads the applied migrations, in a read-only transaction. A database with no migrations table has
 * applied none.
 * @param {string} url
 * @param {{ schema?: string; table?: string }} [where]  drizzle's defaults; tests point it elsewhere
 * @returns {Promise<AppliedRow[]>}
 */
export async function readApplied(url, { schema = "drizzle", table = "__drizzle_migrations" } = {}) {
  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 15, idle_timeout: 1, onnotice: () => {} });
  try {
    return await sql.begin("read only", async (tx) => {
      const [{ exists }] = await tx`select to_regclass(${`${quoteIdent(schema)}.${quoteIdent(table)}`}) is not null as exists`;
      if (!exists) return [];
      return /** @type {AppliedRow[]} */ (await tx`select hash, created_at from ${tx(schema)}.${tx(table)}`);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** @param {string} name */
const quoteIdent = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * The whole check: `{ ok: true }` when every migration is applied, otherwise `{ ok: false, message }`,
 * including when there's no database URL or the database can't be read (it fails closed).
 * @param {{ url?: string; dir?: string; where?: { schema?: string; table?: string } }} options
 * @returns {Promise<{ ok: true; checked: number } | { ok: false; message: string }>}
 */
export async function checkMigrations({ url, dir, where }) {
  if (!url) {
    return {
      ok: false,
      message:
        "Can't check the production database's migrations: neither DATABASE_URL_UNPOOLED nor DATABASE_URL is set for this build.",
    };
  }
  const migrations = readMigrations(dir);
  let applied;
  try {
    applied = await readApplied(url, where);
  } catch (error) {
    return {
      ok: false,
      message: [
        `Can't read the production database's migrations, so this build stops (nothing was migrated): ${error instanceof Error ? error.message : String(error)}`,
        "Check that DATABASE_URL_UNPOOLED (or DATABASE_URL) on the Vercel project is right and the database is up, then redeploy.",
      ].join("\n"),
    };
  }
  const result = missingMigrations(migrations, applied);
  if (result.missing.length) return { ok: false, message: missingMessage(result) };
  return { ok: true, checked: migrations.length };
}

/**
 * The database the guard reads: Neon's direct connection when there is one.
 * @param {Record<string, string | undefined>} [env]
 */
export const guardDatabaseUrl = (env = process.env) => env.DATABASE_URL_UNPOOLED || env.DATABASE_URL || undefined;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await checkMigrations({ url: guardDatabaseUrl() });
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(`All ${result.checked} migrations are applied.`);
}
