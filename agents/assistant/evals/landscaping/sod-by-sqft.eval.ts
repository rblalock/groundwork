import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { listQuotes } from "../../../../core/quotes";
import type config from "../evals.config";

// Sod is priced by the square foot, so the member's square feet go on the line as given.
export default defineEval<typeof config>({
  description: "1,200 square feet of sod is one sod line of 1,200 square feet.",
  tags: ["landscaping"],
  async test(t) {
    const business = await t.context.seed.landscaping();

    await t.send("sod the front lawn at 88 Palm Ave, about 1,200 square feet");
    t.succeeded();
    t.calledTool("create_quote");

    // 1,200 x $1.85 = $2,220.
    const [quote] = await listQuotes(business.orgId, {});
    const sod = quote?.lines.find((line) => /sod/i.test(line.name));
    t.check(sod?.quantity, equals(1200)).label("sod square feet");
    t.check(quote?.totalCents, equals(222000)).label("quote total cents");
  },
});
