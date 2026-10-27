import { pathToFileURL } from "node:url";
import { agentMailMode } from "../core/agentmail";
import { closeDb } from "../core/db";
import { createBusinessInbox } from "../core/email-intake";
import { findOrganizationBySlug, getOrganization } from "../core/organizations";

/**
 * Makes a business's email inbox, where its members forward emails to the assistant: the same as
 * Businesses → Email inbox in the web app. A business that has one keeps it. Needs AGENTMAIL_API_KEY and
 * AGENTMAIL_WEBHOOK_SECRET, or AGENTMAIL_FAKE=1 locally.
 */
async function main(): Promise<number> {
  const ref = process.argv[2]?.trim();
  if (!ref) {
    console.error("Usage: npm run email:inbox -- <business id or slug>");
    return 1;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Put it in .env.local.");
    return 1;
  }
  if (!agentMailMode()) {
    console.error("AgentMail isn't set up: set AGENTMAIL_API_KEY and AGENTMAIL_WEBHOOK_SECRET (or AGENTMAIL_FAKE=1 locally).");
    return 1;
  }
  try {
    const org = (await getOrganization(ref)) ?? (await findOrganizationBySlug(ref));
    if (!org) {
      console.error(`No business has the id or slug ${ref}.`);
      return 1;
    }
    const inbox = await createBusinessInbox(org.id);
    console.log(`${org.name} (${org.slug}): ${inbox.created ? "made" : "already has"} ${inbox.address}${agentMailMode() === "fake" ? " (fake)" : ""}`);
    return 0;
  } catch (error) {
    console.error(`Could not make the inbox: ${error instanceof Error ? error.message : error}`);
    return 1;
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
