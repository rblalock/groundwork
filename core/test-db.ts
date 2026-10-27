import { after, test } from "node:test";
import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/schema";
import { closeDb, db } from "./db";
import { settleDeferred } from "./deferred";

/** The business every `withTestDb` test starts with. Tests that need a second one create it. */
export const TEST_ORG = "org_test";

const tableNames = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => `"${getTableName(table)}"`);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db"]);

/** True for a local or docker-compose-style database host (never a managed, remote one). */
export function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return LOCAL_HOSTS.has(host);
  } catch {
    return false;
  }
}

/**
 * Empties every table in the database, for every business. Tests and evals only: refuses unless DATABASE_URL points
 * at a local host, or ALLOW_DB_TRUNCATE=1 says the caller means it.
 */
export async function truncateAll(): Promise<void> {
  if (process.env.ALLOW_DB_TRUNCATE !== "1" && !isLocalDatabaseUrl(process.env.DATABASE_URL)) {
    throw new Error(
      "Refusing to truncate: DATABASE_URL is not a local database (localhost, 127.0.0.1, ::1, postgres, db). " +
        "Set ALLOW_DB_TRUNCATE=1 only if you are sure.",
    );
  }
  await db().execute(sql.raw(`TRUNCATE ${tableNames.join(", ")} RESTART IDENTITY CASCADE`));
}

/**
 * Registers a node:test that needs the database. Skips when DATABASE_URL is
 * unset (plain `npm test`); otherwise truncates every table and creates the
 * `TEST_ORG` business before running. Work the test deferred (a sign-in code's send) is
 * awaited before the test ends, pass or fail, so none of it runs against the next test's data or
 * reopens the database after the file closes it.
 */
let closeRegistered = false;

export function withTestDb(name: string, fn: () => Promise<void>): void {
  if (!closeRegistered) {
    closeRegistered = true;
    after(async () => {
      await settleDeferred();
      await closeDb();
    });
  }
  test(name, { skip: process.env.DATABASE_URL ? false : "DATABASE_URL is not set" }, async () => {
    await settleDeferred();
    await truncateAll();
    await db().insert(schema.organization).values({ id: TEST_ORG, name: "Test Business", slug: "test-business" });
    try {
      await fn();
    } finally {
      await settleDeferred();
    }
  });
}

/**
 * Tests and evals only: makes `address` the member's confirmed forwarding email, as if they had emailed
 * its code (core/email-claims.ts). The app itself only ever confirms through that email.
 */
export async function confirmedEmailForTests(orgId: string, memberId: string, address: string): Promise<void> {
  await db()
    .update(schema.members)
    .set({ email: address.toLowerCase(), emailSetByMemberId: memberId, emailSetAt: new Date() })
    .where(sql`${schema.members.orgId} = ${orgId} and ${schema.members.id} = ${memberId}`);
}
