import { defineEval } from "eve/evals";
import type config from "../evals.config";

// Both items are priced but neither has a quantity, so the assistant asks before it quotes.
export default defineEval<typeof config>({
  description: "Stump and chipping work with no quantities gets one numbered question for stumps and hours, not a quote.",
  tags: ["tree"],
  async test(t) {
    await t.context.seed.tree();

    const turn = await t.send("grind the stumps and chip the brush pile at 88 Palm Ave");
    t.succeeded();
    turn.notCalledTool("create_quote");
    t.judge(
      "Asks how many stumps and how many hours of chipping, in one numbered message, and does not state a price or a total.",
    ).gate(0.7);
  },
});
