import { resolve } from "node:path";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { upsertThread } from "../../../core/conversations";
import { listItems } from "../../../core/pricebook";
import { getProfile } from "../../../core/profile";
import type config from "./evals.config";

// Crew don't change prices. The session is Carlos's thread, so the local agent runs as him (crew).
const SHEET = resolve(process.cwd(), "agents/assistant/evals/fixtures/price-sheet.png");

export default defineEval<typeof config>({
  description: "A crew member's price sheet goes nowhere near the price book; they're told to send it to the owner.",
  async test(t) {
    const business = await t.context.seed.scheduled();
    const before = (await listItems(business.orgId)).map((item) => `${item.name}:${item.priceCents}`).sort();
    const session = await t.session();
    await upsertThread(business.orgId, business.crew.carlos.memberId, session.sessionId);

    const turn = await session.sendFile("new prices", SHEET, "image/png");
    t.succeeded();
    turn.notCalledTool("save_pricebook_items");
    turn.notCalledTool("update_pricebook_item");
    turn.notCalledTool("update_profile");
    t.check((await listItems(business.orgId)).map((item) => `${item.name}:${item.priceCents}`).sort(), equals(before)).label(
      "price book unchanged",
    );
    t.check((await getProfile(business.orgId)).minimumChargeCents, equals(15000)).label("minimum unchanged");
    t.judge(
      "The reply tells the crew member, briefly, that the owner or an admin adds prices, so they should send the sheet to them. " +
        "It does not say any price was saved or changed.",
    ).gate(0.7);
  },
});
