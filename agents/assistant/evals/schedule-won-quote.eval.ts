import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";
import { listQuotes } from "../../../core/quotes";
import { readSchedule } from "../../../core/scheduling";
import { resolveDay, wallClock } from "../../../core/scheduling-time";
import type config from "./evals.config";

// A won quote becomes work, booked by text in one go: the customer said yes, so it's won, and the
// visit lands on the coming Tuesday at 9 in the business's time zone, with the crew member named.
export default defineEval<typeof config>({
  description: "\"She said yes, put it on Tuesday at 9 with Carlos\" marks the quote won and books the visit at 9 local time.",
  async test(t) {
    const business = await t.context.seed.scheduled();
    const tuesday = resolveDay("tuesday", business.timeZone);

    const turn = await t.send("Ada said yes to 12 Oak St! put it on Tuesday at 9 with Carlos");
    t.succeeded();
    turn.calledTool("set_quote_outcome");
    turn.calledTool("book_visit");
    t.check(turn.message, includes("9"));
    t.judge(
      "The reply confirms the 12 Oak St visit is booked for Tuesday at 9 AM with Carlos, in a line or two, and doesn't say the customer was texted or notified.",
    ).gate(0.7);

    const [quote] = await listQuotes(business.orgId, { query: "Oak" });
    t.check(quote?.status, equals("won")).label("quote status");
    const schedule = await readSchedule(business.owner, { from: tuesday, days: 1 });
    t.check(schedule.visits.length, equals(1)).label("visits on Tuesday");
    const [visit] = schedule.visits;
    t.check(visit ? wallClock(visit.startAt, business.timeZone).time : null, equals("09:00")).label("local start");
    t.check(visit?.quoteId, equals(business.oakSt.quoteId)).label("visit's quote");
    t.check(visit?.crew.map((c) => c.memberId), equals([business.crew.carlos.memberId])).label("crew");
  },
});
