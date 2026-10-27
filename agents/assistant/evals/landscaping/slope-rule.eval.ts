import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { listQuotes } from "../../../../core/quotes";
import type config from "../evals.config";

// The member says the yard is steep, which is the saved slope rule: 15% on the labor lines.
export default defineEval<typeof config>({
  description: "Mowing and edging on a steep slope are quoted with the slope rule applied.",
  tags: ["landscaping"],
  async test(t) {
    const business = await t.context.seed.landscaping();

    await t.send("backyard on a steep slope at 88 Palm Ave, mow it and edge about 60 feet");
    t.succeeded();
    t.calledTool("create_quote");

    // ($65 mowing + 60 x $2.50 edging) = $215, plus 15% on both labor lines = $247.25.
    const [quote] = await listQuotes(business.orgId, {});
    t.check(quote?.totalCents, equals(24725)).label("quote total cents");
  },
});
