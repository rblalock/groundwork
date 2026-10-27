import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { listQuotes } from "../../../../core/quotes";
import type config from "../evals.config";

// The business requires haul-away on any cleanup over two hours. No calculator rule can add a line, so
// the assistant has to follow the saved process rule itself.
export default defineEval<typeof config>({
  description: "Four hours of cleanup comes with haul-away, on the quote or named as required.",
  tags: ["landscaping"],
  async test(t) {
    const business = await t.context.seed.landscaping();

    await t.send("cleanup at 88 Palm Ave, figure about 4 hours of labor");
    t.succeeded();
    t.judge("Includes haul-away in the quote or says haul-away is required for a cleanup over two hours.").gate(0.7);

    const [quote] = await listQuotes(business.orgId, {});
    if (quote) {
      t.check(
        quote.lines.map((line) => line.name),
        satisfies((names: string[]) => names.some((name) => /haul/i.test(name)), "a Haul-away line"),
      ).label("quote lines");
    }
  },
});
