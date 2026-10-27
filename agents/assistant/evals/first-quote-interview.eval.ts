import { defineEval } from "eve/evals";
import { equals, includes, satisfies } from "eve/evals/expect";
import { listItems } from "../../../core/pricebook";
import { getProfile } from "../../../core/profile";
import { listQuotes } from "../../../core/quotes";
import type config from "./evals.config";

// Onboarding is the first quote: no prices saved, so one numbered question message, then a finished quote.
export default defineEval<typeof config>({
  description: "A new business is asked for its prices once, in one numbered message, and the quote follows.",
  async test(t) {
    const business = await t.context.seed.empty();

    const turn = await t.send("quote 4512 Palm Ave. 2 story, about 28 windows in and out, screens");
    t.succeeded();
    turn.notCalledTool("create_quote");
    t.judge(
      "The reply asks for the member's unit prices (per window, per screen) and a minimum charge, numbered, in one message, and does not state a total or guess a price.",
    ).gate(0.7);

    const next = await turn.session.send("12, 2, 150 min");
    t.calledTool("save_pricebook_items");
    t.calledTool("create_quote");
    t.check(next.message, includes("392"));

    // 28 x $12 + 28 x $2 = $392, above the $150 minimum. The prices and the minimum were saved.
    const [quote] = await listQuotes(business.orgId, {});
    t.check(quote?.totalCents, equals(39200)).label("quote total cents");
    t.check(
      (await listItems(business.orgId)).map((item) => item.priceCents),
      satisfies((prices: number[]) => prices.includes(1200) && prices.includes(200), "saved $12 and $2 prices"),
    );
    t.check((await getProfile(business.orgId)).minimumChargeCents, equals(15000)).label("saved minimum cents");
  },
});
