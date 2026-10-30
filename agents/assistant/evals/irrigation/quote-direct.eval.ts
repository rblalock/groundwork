import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { listQuotes } from "../../../../core/quotes";
import type config from "../evals.config";

// Every quantity is in the message and every price is saved, so the quote goes straight out.
export default defineEval<typeof config>({
  description: "4 heads, an inspection of 6 zones, and a backflow test are quoted straight away at the saved prices.",
  tags: ["irrigation"],
  async test(t) {
    const business = await t.context.seed.irrigation();

    await t.send("Maria at 412 Oak St needs 4 sprinkler heads replaced, all 6 zones inspected, and her backflow test.");
    t.succeeded();
    t.calledTool("create_quote");
    t.judge("The reply does not ask for any price and does not ask for quantities already given.").gate(0.7);

    // 4 x $35 heads + 6 x $15 zones + $75 backflow test = $305, above the $95 minimum.
    const [quote] = await listQuotes(business.orgId, {});
    t.check(quote?.totalCents, equals(30500)).label("quote total cents");
  },
});
