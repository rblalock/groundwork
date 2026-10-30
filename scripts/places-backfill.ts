import { pathToFileURL } from "node:url";
import { closeDb } from "../core/db";
import { placesFake, placeUnplaced } from "../core/places";

// Places the yards and properties saved before places existed, or whose placing failed:
// `npm run places:backfill [-- --org <orgId>] [--retry-not-found]`. Safe to run again; a placed address is left alone.
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const orgAt = args.indexOf("--org");
  const orgId = orgAt >= 0 ? args[orgAt + 1] : undefined;
  if (orgAt >= 0 && !orgId) {
    console.error("Usage: npm run places:backfill -- [--org <orgId>] [--retry-not-found]");
    return 1;
  }
  if (!process.env.DATABASE_URL) {
    console.error("Missing environment variable DATABASE_URL. Set it in .env.local.");
    return 1;
  }
  try {
    if (placesFake()) console.log("Using the fake geocoder (PLACES_FAKE=0 asks the Census geocoder).");
    const counts = await placeUnplaced({ orgId, retryNotFound: args.includes("--retry-not-found") });
    console.log(`Placed ${counts.ok}, not found ${counts.not_found}, failed ${counts.failed}, skipped ${counts.skipped}.`);
    return 0;
  } catch (error) {
    console.error(`Backfill failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
