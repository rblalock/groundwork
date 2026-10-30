import { defineEval } from "eve/evals";
import type config from "../evals.config";

// Both items are priced but neither has a quantity, so the assistant asks before it quotes.
export default defineEval<typeof config>({
  description: "Drip line and valve work with no quantities gets one numbered question for feet and valves, not a quote.",
  tags: ["irrigation"],
  async test(t) {
    await t.context.seed.irrigation();

    const turn = await t.send("redo the drip line in the front beds and replace the bad valves at 88 Palm Ave");
    t.succeeded();
    turn.notCalledTool("create_quote");
    t.judge(
      "Asks for the drip line in linear feet and how many valves, in one numbered message, and does not state a price or a total.",
    ).gate(0.7);
  },
});
