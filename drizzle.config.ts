import { defineConfig } from "drizzle-kit";

// DATABASE_URL is the app's one database, for every business. Locally it's in .env.local; in
// production it's set on the Vercel project.
export default defineConfig({
  dialect: "postgresql",
  schema: "./schema/schema.ts",
  out: "./schema/migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
