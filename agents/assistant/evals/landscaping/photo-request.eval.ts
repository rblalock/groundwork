import { defineEval } from "eve/evals";
import type config from "../evals.config";

// Bed work with no quantities and no photos: the photo ask rides along with the other questions.
export default defineEval<typeof config>({
  description: "A bed cleanup with no photo gets a front and back photo request in the same numbered message.",
  tags: ["landscaping"],
  async test(t) {
    await t.context.seed.landscaping();

    const turn = await t.send("clean up the beds at 88 Palm Ave and re-mulch");
    t.succeeded();
    turn.notCalledTool("create_quote");
    t.judge("Asks for a front and back yard photo in the same numbered message as its other questions.").gate(0.7);
  },
});
