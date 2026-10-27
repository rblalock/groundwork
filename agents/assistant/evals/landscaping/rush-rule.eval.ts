import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { listQuotes } from "../../../../core/quotes";
import type config from "../evals.config";

// "This week" is the saved same-week rush rule: the calculator adds 20% to every line.
export default defineEval<typeof config>({
  description: "A job wanted this week is quoted with the rush rule applied.",
  tags: ["landscaping"],
  async test(t) {
    const business = await t.context.seed.landscaping();

    await t.send(
      "Maria at 412 Oak St wants her front yard mowed, 3 yards of mulch in the beds and about 40 feet of edging, this week.",
    );
    t.succeeded();
    t.calledTool("create_quote");
    t.judge("The reply mentions the rush charge.").gate(0.6);

    // $450 plus the 20% rush (no haul-away on this job to exempt) = $540.
    const [quote] = await listQuotes(business.orgId, {});
    t.check(quote?.totalCents, equals(54000)).label("quote total cents");
  },
});
