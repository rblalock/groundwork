import { defineEval } from "eve/evals";
import type config from "../evals.config";

// Both items are priced but neither has a quantity, so the assistant asks before it quotes.
export default defineEval<typeof config>({
  description: "Filter and tile work with no quantities gets one numbered question for filters and feet of waterline, not a quote.",
  tags: ["pool"],
  async test(t) {
    await t.context.seed.pool();

    const turn = await t.send("clean the filters and the waterline tile at 88 Palm Ave");
    t.succeeded();
    turn.notCalledTool("create_quote");
    t.judge(
      "Asks how many filters and the tile in linear feet of waterline, in one numbered message, and does not state a price or a total.",
    ).gate(0.7);
  },
});
