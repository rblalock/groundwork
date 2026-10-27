import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { listQuotes } from "../../../core/quotes";
import type config from "./evals.config";

// A job with nothing priced used to become a "$0" quote with a PDF, then a second ask for the price.
// "tomorrow" also used to pull it into booking: it asked only for a time and never the price.
export default defineEval<typeof config>({
  description: "A job whose only item has no price gets one price question, not a $0 quote.",
  async test(t) {
    const business = await t.context.seed.priced();

    const turn = await t.send("need the back porch at 12 Sample St cleaned tomorrow");
    t.succeeded();
    turn.notCalledTool("create_quote");
    t.judge(
      "The reply asks what the member charges for cleaning the back porch, once (it may also ask what time in the same message), and states no total or $0 price.",
    ).gate(0.7);
    t.check((await listQuotes(business.orgId, {})).length, equals(0)).label("quotes created");
  },
});
