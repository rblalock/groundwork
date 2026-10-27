import { defineEval } from "eve/evals";
import type config from "../evals.config";

// Pressure washing is not on the price list: the assistant asks the owner for a price, never guesses one.
export default defineEval<typeof config>({
  description: "A job with no saved price gets a question for the price, not a guessed one.",
  tags: ["landscaping"],
  async test(t) {
    await t.context.seed.landscaping();

    const turn = await t.send("pressure wash the driveway at 88 Palm Ave");
    t.succeeded();
    turn.notCalledTool("create_quote");
    t.judge("Does not state or guess a price for pressure washing; asks the owner for one.").gate(0.7);
  },
});
