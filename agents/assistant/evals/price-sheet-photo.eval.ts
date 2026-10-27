import { resolve } from "node:path";
import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { listItems } from "../../../core/pricebook";
import { getProfile } from "../../../core/profile";
import type config from "./evals.config";

// The owner texts a photo of a fake price sheet whose last price is smudged. The assistant proposes
// what it can read, asks only about the smudged one, and saves nothing until the owner answers.
const SHEET = resolve(process.cwd(), "agents/assistant/evals/fixtures/price-sheet.png");

export default defineEval<typeof config>({
  description: "A photo of a price sheet becomes price-book items after one question about the unreadable price.",
  async test(t) {
    const business = await t.context.seed.empty();
    const session = await t.session();

    const turn = await session.sendFile("here's my price list", SHEET, "image/png");
    t.succeeded();
    turn.calledTool("set_aside_document");
    turn.notCalledTool("save_pricebook_items");
    turn.notCalledTool("update_profile");
    turn.notCalledTool("create_quote");
    t.judge(
      "The reply lists Widget service $12 each, Gadget fitting $2 each, Sprocket check $45 per hour, and the $150 minimum, " +
        "numbered, and asks one question: the price of Doohickey polish, which it says it can't read. It proposes no price " +
        "for Doohickey polish, asks nothing about the other items, and asks for an ok before saving. No markdown.",
    ).gate(0.7);

    const next = await turn.session.send("ok, the last one is 30");
    next.calledTool("save_pricebook_items");
    next.notCalledTool("create_quote");

    const prices = Object.fromEntries((await listItems(business.orgId)).map((item) => [item.name.toLowerCase(), item.priceCents]));
    t.check(
      prices,
      satisfies(
        (p: Record<string, number>) =>
          Object.keys(p).length === 4 &&
          p["widget service"] === 1200 &&
          p["gadget fitting"] === 200 &&
          p["sprocket check"] === 4500 &&
          p["doohickey polish"] === 3000,
        "exactly the four prices on the sheet, with the answered one",
      ),
    ).label("saved prices");
    const hourly = (await listItems(business.orgId)).find((item) => /sprocket/i.test(item.name));
    t.check(hourly?.unitKind, equals("hour")).label("per hour is an hourly item");
    t.check((await getProfile(business.orgId)).minimumChargeCents, equals(15000)).label("saved minimum cents");
    t.judge("The reply confirms in a line or two that the prices and the $150 minimum were saved, without listing every item again.").gate(0.6);
  },
});
