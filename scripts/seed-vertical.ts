import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { closeDb } from "../core/db";
import { findMemberByPhone } from "../core/members";
import { provisionSchema } from "../core/provision";
import { applyVerticalPack } from "../core/vertical-seed";
import { VERTICALS } from "../verticals";

// Loads a trade pack into the provisioned business: `npm run seed:vertical -- landscaping [provision.json]`.
// Finds the business through its owner's phone. Never empties or touches any other business.
async function main(): Promise<number> {
  const id = process.argv[2] ?? process.env.VERTICAL;
  const path = process.argv[3] ?? "provision.json";
  if (!id || id === "none") {
    console.error(`Name a pack: npm run seed:vertical -- <${Object.keys(VERTICALS).join("|")}>`);
    return 1;
  }
  const pack = VERTICALS[id];
  if (!pack) {
    console.error(`No pack named "${id}". Packs: ${Object.keys(VERTICALS).join(", ")}.`);
    return 1;
  }
  if (!process.env.DATABASE_URL) {
    console.error("Missing environment variable DATABASE_URL. Set it in .env.local.");
    return 1;
  }

  let ownerPhone: string;
  try {
    ownerPhone = provisionSchema.parse(JSON.parse(readFileSync(path, "utf8"))).owner.phone;
  } catch (error) {
    console.error(`Could not read ${path}: ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  try {
    const found = await findMemberByPhone(ownerPhone);
    if (!found || found.member.role !== "owner") {
      console.error(`No owner with ${ownerPhone}. Run npm run provision first.`);
      return 1;
    }
    const counts = await applyVerticalPack(found.member.orgId, found.member.id, pack);
    console.log(`${pack.label} pack: items ${counts.items}, rulesAdded ${counts.rulesAdded}, notesAdded ${counts.notesAdded}`);
    return 0;
  } catch (error) {
    console.error(`Seeding failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
