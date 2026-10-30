import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { listQuotes } from "../../../../core/quotes";
import type config from "../evals.config";

// Every quantity is in the message and every price is saved, so the quote goes straight out.
export default defineEval<typeof config>({
  description: "2 palms, a stump, and a load hauled away are quoted straight away at the saved prices.",
  tags: ["tree"],
  async test(t) {
    const business = await t.context.seed.tree();

    await t.send("Maria at 412 Oak St wants 2 palms trimmed, 1 stump ground, and 1 load hauled away.");
    t.succeeded();
    t.calledTool("create_quote");
    t.judge("The reply does not ask for any price and does not ask for quantities already given.").gate(0.7);

    // 2 x $65 palms + $150 stump + $175 haul-away = $455, above the $250 minimum.
    const [quote] = await listQuotes(business.orgId, {});
    t.check(quote?.totalCents, equals(45500)).label("quote total cents");
  },
});
