import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { messages } from "../../../schema/schema";
import { getBranding } from "../../../core/branding";
import { db, newId } from "../../../core/db";
import { listItems } from "../../../core/pricebook";
import type config from "./evals.config";

// The owner texts a made-up "Sample Co" logo and says to use it. The Photon channel would have stored
// the photo and logged the text; an eval talks to the agent directly, so the eval logs it the same way,
// pointing at the fixture, and sends the image along so the model sees it.
const LOGO = resolve(process.cwd(), "agents/assistant/evals/fixtures/logo.png");

export default defineEval<typeof config>({
  description: "\"Use this as our logo\" with an image sets the business's logo, and nothing else.",
  async test(t) {
    const business = await t.context.seed.empty();
    await db().insert(messages).values({
      id: newId("msg"),
      orgId: business.orgId,
      memberId: business.owner.memberId,
      phoneE164: "+15555550100",
      direction: "inbound",
      kind: "user",
      body: "use this as our logo",
      attachments: [{ type: "image", url: pathToFileURL(LOGO).href, name: "logo.png", mimeType: "image/png" }],
    });
    const session = await t.session();

    const turn = await session.sendFile("use this as our logo", LOGO, "image/png");
    t.succeeded();
    turn.calledTool("set_logo");
    turn.notCalledTool("create_quote");
    turn.notCalledTool("save_pricebook_items");
    turn.notCalledTool("save_note");
    t.check((await getBranding(business.orgId)).logoUrl, satisfies((url: string | null) => Boolean(url), "a logo is stored")).label("logo set");
    t.check((await listItems(business.orgId)).length, equals(0)).label("no prices read off the logo");
    t.judge(
      "The reply confirms in a line or two that the logo is set (saying it goes on the quotes and invoices is fine, not required). " +
        "It doesn't describe the image at length, doesn't ask about prices or a job, and uses no markdown.",
    ).gate(0.7);
  },
});
