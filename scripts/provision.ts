import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { closeDb } from "../core/db";
import { createPhotonAdmin } from "../core/photon-admin";
import { provision, provisionSchema, type ProvisionRow } from "../core/provision";

const formatTable = (rows: ProvisionRow[]): string => {
  const header = ["name", "role", "phone", "text this number"];
  const lines = rows.map((r) => [r.name, r.role, r.phone, r.assignedLine]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const render = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join(" | ").trimEnd();
  return [render(header), widths.map((w) => "-".repeat(w)).join("-|-"), ...lines.map(render)].join("\n");
};

async function main(): Promise<number> {
  const path = process.argv[2] ?? "provision.json";
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`Could not read ${path}: ${error instanceof Error ? error.message : error}`);
    console.error("Copy provision.example.json to provision.json and fill it in.");
    return 1;
  }
  const parsed = provisionSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`${path} is not valid:`);
    for (const issue of parsed.error.issues) console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    return 1;
  }

  const missing = [
    ...(process.env.DATABASE_URL ? [] : ["DATABASE_URL"]),
    ...(process.env.PHOTON_ADMIN_FAKE === "1"
      ? []
      : ["IMESSAGE_PROJECT_ID", "IMESSAGE_PROJECT_SECRET"].filter((name) => !process.env[name])),
  ];
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}. Set them in .env.local.`);
    return 1;
  }

  try {
    const { org, rows } = await provision(parsed.data, { admin: createPhotonAdmin() });
    console.log(`${org.name} (${org.slug})\n`);
    console.log(formatTable(rows));
    console.log("\nHand each person their number on the call. Their first text to it activates them.");
    return 0;
  } catch (error) {
    console.error(`Provisioning failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
