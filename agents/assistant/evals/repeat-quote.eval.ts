import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";
import { listQuotes } from "../../../core/quotes";
import type config from "./evals.config";

export default defineEval<typeof config>({
  description: "With every price saved, a job is quoted straight away and no price is asked for.",
  async test(t) {
    const business = await t.context.seed.priced();

    const turn = await t.send("new one. 310 Coral Way, 16 windows in and out, no screens");
    t.succeeded();
    t.calledTool("create_quote");
    t.check(turn.message, includes("192"));
    t.judge("The reply does not ask for any price.").gate(0.7);

    // 16 x $12 = $192, above the $150 minimum.
    const [quote] = await listQuotes(business.orgId, {});
    t.check(quote?.totalCents, equals(19200)).label("quote total cents");
  },
});
