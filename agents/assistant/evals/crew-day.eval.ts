import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";
import { upsertThread } from "../../../core/conversations";
import type config from "./evals.config";

// Crew see their own day. The session is Carlos's thread, so the local agent runs as him (crew).
export default defineEval<typeof config>({
  description: "A crew member asking what's on today hears their own visits, not anyone else's.",
  async test(t) {
    const business = await t.context.seed.scheduled();
    await t.context.seed.todaysVisits(business);
    const session = await t.session();
    await upsertThread(business.orgId, business.crew.carlos.memberId, session.sessionId);

    const turn = await session.send("what's on today?");
    t.succeeded();
    turn.calledTool("read_schedule");
    t.check(turn.message, includes("Oak")).label("names their visit");
    t.check(/elm/i.test(turn.message ?? ""), equals(false)).label("no one else's visit");
    t.check(/pine/i.test(turn.message ?? ""), equals(false)).label("not tomorrow's");
    t.judge("The reply tells the member they have one visit today, at 12 Oak St at 9 AM, briefly and without markdown.").gate(0.7);
  },
});
