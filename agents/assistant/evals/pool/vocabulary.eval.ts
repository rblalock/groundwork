import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { listQuotes } from "../../../../core/quotes";
import type config from "../evals.config";

// "Gone green" is a pool tech's word for a neglected pool. Quoted or proposed in a confirm, it is the
// saved Green-to-clean, never a new item.
export default defineEval<typeof config>({
  description: "\"Her pool's gone green\" is taken as one Green-to-clean.",
  tags: ["pool"],
  async test(t) {
    const business = await t.context.seed.pool();

    await t.send("Maria at 412 Oak St, her pool's gone green since the storm. Quote her.");
    t.succeeded();
    t.judge(
      "Treats the green pool as the saved Green-to-clean, on a quote or in a numbered confirm, uses pool service terms, and does not invent an item or a price.",
    ).gate(0.7);

    const [quote] = await listQuotes(business.orgId, {});
    t.check(
      quote?.lines.map((line) => line.name) ?? [],
      satisfies((names: string[]) => names.length === 0 || names.includes("Green-to-clean"), "no quote yet, or one with a Green-to-clean"),
    ).label("green-to-clean line");
  },
});
