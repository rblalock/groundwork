import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { listQuotes } from "../../../../core/quotes";
import type config from "../evals.config";

// A small job comes in under the business's $150 minimum, and the calculator raises it.
export default defineEval<typeof config>({
  description: "Two sprinkler heads are quoted at the $150 minimum, not $70.",
  tags: ["landscaping"],
  async test(t) {
    const business = await t.context.seed.landscaping();

    await t.send("replace 2 sprinkler heads at 88 Palm Ave");
    t.succeeded();
    t.calledTool("create_quote");

    // 2 x $35 = $70, raised to the $150 minimum.
    const [quote] = await listQuotes(business.orgId, {});
    t.check(quote?.totalCents, equals(15000)).label("quote total cents");
  },
});
