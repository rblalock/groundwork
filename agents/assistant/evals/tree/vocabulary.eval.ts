import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { listQuotes } from "../../../../core/quotes";
import type config from "../evals.config";

// A limb down on a fence is one limb to take away. Quoted or proposed in a confirm, it is the saved Limb
// removal, never a new item.
export default defineEval<typeof config>({
  description: "\"A limb came down on her fence\" is taken as one Limb removal.",
  tags: ["tree"],
  async test(t) {
    const business = await t.context.seed.tree();

    await t.send("Maria at 412 Oak St, a limb came down on her fence in the storm. Quote her to get it gone.");
    t.succeeded();
    t.judge(
      "Treats the fallen limb as the saved Limb removal for one limb, on a quote or in a numbered confirm, uses tree crew terms, and does not invent an item or a price.",
    ).gate(0.7);

    const [quote] = await listQuotes(business.orgId, {});
    t.check(
      quote?.lines.map((line) => line.name) ?? [],
      satisfies((names: string[]) => names.length === 0 || names.includes("Limb removal"), "no quote yet, or one with a Limb removal"),
    ).label("limb removal line");
  },
});
