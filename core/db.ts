import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../schema/schema";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

let database: Db | undefined;
let client: ReturnType<typeof postgres> | undefined;

/**
 * The app's database (DATABASE_URL), shared by every business. Connects on first use: `eve build` loads
 * every module before DATABASE_URL exists on Vercel.
 */
export function db(): Db {
  if (!database) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set. Locally, put it in .env.local.");
    }
    // `prepare: false` works through Neon's connection pooler. A few connections, so a page's queries
    // (and the requests one instance serves at once) run side by side instead of queuing on one.
    client = postgres(url, { prepare: false, max: 5 });
    database = drizzle(client, { schema });
  }
  return database;
}

/** Prefixed text id: `${prefix}_` + 16 hex chars. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/** Close the connection (tests and scripts that must exit). The next `db()` call reconnects. */
export async function closeDb(): Promise<void> {
  const open = client;
  client = undefined;
  database = undefined;
  await open?.end();
}
