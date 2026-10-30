import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { listQuotes } from "../../../../core/quotes";
import type config from "../evals.config";

// "The zone by the pool is dead" is crew talk for one zone that needs inspecting. Quoted or proposed in
// a confirm, it is the saved Zone inspection, never a new item.
export default defineEval<typeof config>({
  description: "\"The zone by the pool is dead\" is taken as a Zone inspection for one zone.",
  tags: ["irrigation"],
  async test(t) {
    const business = await t.context.seed.irrigation();

    await t.send("Maria at 412 Oak St says the zone by the pool is dead. Quote her.");
    t.succeeded();
    t.judge(
      "Treats the dead zone as the saved Zone inspection for one zone, on a quote or in a numbered confirm, uses irrigation terms, and does not invent an item or a price.",
    ).gate(0.7);

    const [quote] = await listQuotes(business.orgId, {});
    t.check(
      quote?.lines.map((line) => line.name) ?? [],
      satisfies((names: string[]) => names.length === 0 || names.includes("Zone inspection"), "no quote yet, or one with a Zone inspection"),
    ).label("zone inspection line");
  },
});
