import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { listQuotes } from "../../../../core/quotes";
import type config from "../evals.config";

// Every quantity is in the message and every price is saved, so the quote goes straight out.
export default defineEval<typeof config>({
  description: "4 weekly visits, chemicals on all 4, and a filter clean are quoted straight away at the saved prices.",
  tags: ["pool"],
  async test(t) {
    const business = await t.context.seed.pool();

    await t.send("Maria at 412 Oak St wants 4 weekly service visits, chemicals on all 4, and her filter cleaned once.");
    t.succeeded();
    t.calledTool("create_quote");
    t.judge("The reply does not ask for any price and does not ask for quantities already given.").gate(0.7);

    // 4 x $35 visits + 4 x $20 chemicals + $95 filter clean = $315, above the $75 minimum.
    const [quote] = await listQuotes(business.orgId, {});
    t.check(quote?.totalCents, equals(31500)).label("quote total cents");
  },
});
