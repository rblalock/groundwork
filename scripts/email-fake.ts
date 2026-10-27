import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { organization } from "../schema/schema";
import { agentMailMode, deliverFakeEmail } from "../core/agentmail";
import { closeDb, db } from "../core/db";

const TYPES: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".csv": "text/csv", ".txt": "text/plain" };

/**
 * Local dev only: delivers an email to a business's fake inbox, signed like AgentMail's, to a running
 * app's webhook, so a forwarded email runs end to end with AGENTMAIL_FAKE=1. Obviously fake data only.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      to: { type: "string" },
      from: { type: "string" },
      subject: { type: "string", default: "Fwd: a job" },
      text: { type: "string" },
      attach: { type: "string", multiple: true },
      origin: { type: "string", default: process.env.BETTER_AUTH_URL || "http://localhost:3000" },
    },
  });
  if (!values.to || !values.from || !values.text) {
    console.error('Usage: npm run email:fake -- --to <inbox address> --from <member email> --text "…" [--subject "…"] [--attach file]… [--origin http://localhost:3000]');
    return 1;
  }
  if (agentMailMode() !== "fake") {
    console.error("Set AGENTMAIL_FAKE=1 (here and on the running app): this only talks to the fake.");
    return 1;
  }
  try {
    const [org] = await db().select().from(organization).where(eq(organization.inboxAddress, values.to.toLowerCase()));
    if (!org?.inboxId) {
      console.error(`No business has the inbox ${values.to}. Make one with npm run email:inbox.`);
      return 1;
    }
    const attachments = await Promise.all(
      (values.attach ?? []).map(async (file) => ({
        filename: basename(file),
        contentType: TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        bytes: new Uint8Array(await readFile(file)),
      })),
    );
    const result = await deliverFakeEmail(values.origin, { inboxId: org.inboxId, to: values.to, from: values.from, subject: values.subject, text: values.text, attachments });
    console.log(`${result.status} ${JSON.stringify(result.body)}`);
    return result.status === 200 ? 0 : 1;
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
