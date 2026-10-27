import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { checkMigrations, guardDatabaseUrl } from "./migration-check.mjs";

const words = spawnSync("node", ["scripts/check-words.mjs"], { stdio: "inherit" });
if (words.status !== 0) process.exit(words.status ?? 1);

// A production build on Vercel first checks that the production database has every migration in
// schema/migrations, and stops if it doesn't or can't be read. It never migrates: a person runs
// `npm run db:migrate` against production (README, "Deploy"). Preview and local builds skip the check.
if (process.env.VERCEL && process.env.VERCEL_ENV === "production") {
  const result = await checkMigrations({ url: guardDatabaseUrl() });
  if (!result.ok) {
    console.error(`\n${result.message}\n`);
    process.exit(1);
  }
  console.log(`Production database: all ${result.checked} migrations are applied.`);
}

// On Vercel, withEve builds each agent as its own service. A local production build needs each agent's
// server bundle (agents/<name>/.output/) before `next start` can run them beside the app.
const agents = readdirSync("agents", { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join("agents", entry.name));
const commands = [...(process.env.VERCEL ? [] : agents.map((cwd) => ({ args: ["eve", "build"], cwd }))), { args: ["next", "build"], cwd: "." }];
for (const { args, cwd } of commands) {
  const result = spawnSync("npx", ["--no-install", ...args], { stdio: "inherit", env: process.env, cwd });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
