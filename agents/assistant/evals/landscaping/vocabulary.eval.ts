import { defineEval } from "eve/evals";
import type config from "../evals.config";

// The same message as interview-quantities, judged on whether the reply talks like a landscaping crew.
export default defineEval<typeof config>({
  description: "A question about bed and hedge work is asked in landscaping terms.",
  tags: ["landscaping"],
  async test(t) {
    await t.context.seed.landscaping();

    await t.send("mulch the beds and trim the hedges at 88 Palm Ave");
    t.succeeded();
    t.judge(
      "Uses landscaping terms naturally (beds, edging, mulch by the yard, hedges) and no terms from another trade.",
    ).gate(0.7);
  },
});
