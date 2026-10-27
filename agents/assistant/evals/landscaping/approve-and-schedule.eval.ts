import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { getProfile } from "../../../../core/profile";
import { listQuotes } from "../../../../core/quotes";
import { readSchedule } from "../../../../core/scheduling";
import { wallClock } from "../../../../core/scheduling-time";
import type config from "../evals.config";

// End to end in three messages: the job is quoted, the owner approves it, and the visit is booked.
export default defineEval<typeof config>({
  description: "A quote, an ok, and \"schedule it for next Tuesday at 8am\" end with one booked 8 AM visit.",
  tags: ["landscaping"],
  async test(t) {
    const business = await t.context.seed.landscaping();
    const { timeZone } = await getProfile(business.orgId);

    const quoted = await t.send(
      "Maria at 412 Oak St wants her front yard mowed, 3 yards of mulch in the beds and about 40 feet of edging.",
    );
    t.succeeded();
    quoted.calledTool("create_quote");

    const approved = await quoted.session.send("approve it");
    approved.calledTool("approve_quote");

    const booked = await approved.session.send("schedule it for next Tuesday at 8am");
    booked.calledTool("book_visit");
    t.judge("The reply confirms a visit booked for Tuesday at 8 AM, in a line or two.").gate(0.6);

    // "Next Tuesday" can mean this coming Tuesday or the one after, so look two weeks out.
    const [quote] = await listQuotes(business.orgId, {});
    const today = wallClock(new Date(), timeZone).date;
    const schedule = await readSchedule(business.owner, { from: today, days: 15 });
    t.check(schedule.visits.length, equals(1)).label("visits booked");
    const [visit] = schedule.visits;
    const local = visit ? wallClock(visit.startAt, timeZone) : null;
    t.check(local?.time ?? null, equals("08:00")).label("local start");
    t.check(
      local?.date ?? "",
      satisfies((ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay() === 2, "a Tuesday"),
    ).label("visit day");
    t.check(visit?.quoteId, equals(quote?.quoteId)).label("visit's quote");
  },
});
