import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { listQuotes } from "../../../../core/quotes";
import type config from "../evals.config";

// Every quantity is in the message and every price is saved, so the quote goes straight out.
export default defineEval<typeof config>({
  description: "Mowing, 3 yards of mulch, and 40 feet of edging are quoted straight away at the saved prices.",
  tags: ["landscaping"],
  async test(t) {
    const business = await t.context.seed.landscaping();

    await t.send("Maria at 412 Oak St wants her front yard mowed, 3 yards of mulch in the beds and about 40 feet of edging.");
    t.succeeded();
    t.calledTool("create_quote");
    t.judge("The reply does not ask for any price and does not ask for quantities already given.").gate(0.7);

    // $65 mowing + 3 x $95 mulch + 40 x $2.50 edging = $450, above the $150 minimum.
    const [quote] = await listQuotes(business.orgId, {});
    t.check(quote?.totalCents, equals(45000)).label("quote total cents");
  },
});
