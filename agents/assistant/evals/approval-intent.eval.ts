import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { listQuotes } from "../../../core/quotes";
import type config from "./evals.config";

// The HTTP channel adds no context block, so the quote the owner answers has to be the agent's last
// message, as the instructions require. The first turn has the agent create that draft.
export default defineEval<typeof config>({
  description: "A Spanish 'looks good, send it' after a quote summary approves that quote.",
  async test(t) {
    const business = await t.context.seed.priced();

    const first = await t.send("new one. 310 Coral Way, 16 windows in and out, no screens");
    first.calledTool("create_quote");
    const [draft] = await listQuotes(business.orgId, {});
    await t.require(draft?.status, equals("draft"));

    const turn = await first.session.send("se ve bien, mándalo");
    turn.calledTool("approve_quote");
    t.judge("The reply confirms approval in Spanish and tells the member to forward the PDF.").gate(0.7);

    const [after] = await listQuotes(business.orgId, {});
    t.check(after?.status, equals("approved")).label("quote status");
  },
});
