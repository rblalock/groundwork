import { defineEval } from "eve/evals";
import type config from "../evals.config";

// Both items are priced but neither has a quantity, so the assistant asks before it quotes. With no bed
// size or photo to go on, a proposed number would be a guess, so the judge asks only for the units.
export default defineEval<typeof config>({
  description: "Mulch and hedge work with no quantities gets one numbered question for yards and cubic feet, not a quote.",
  tags: ["landscaping"],
  async test(t) {
    await t.context.seed.landscaping();

    const turn = await t.send("mulch the beds and trim the hedges at 88 Palm Ave");
    t.succeeded();
    turn.notCalledTool("create_quote");
    t.judge(
      "Asks for the mulch amount in cubic yards and hedge trimming in cubic feet, in one numbered message, and does not state a price or a total.",
    ).gate(0.7);
  },
});
