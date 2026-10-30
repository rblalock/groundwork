import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { checklistCounts, checklistFor } from "../../../../core/checklist";
import { upsertThread } from "../../../../core/conversations";
import { saveCustomer } from "../../../../core/customers";
import { createMember } from "../../../../core/members";
import { getProfile } from "../../../../core/profile";
import { approveQuote, createQuote, setQuoteOutcome } from "../../../../core/quotes";
import { bookVisit, getVisit } from "../../../../core/scheduling";
import { resolveLocalTime, wallClock } from "../../../../core/scheduling-time";
import type config from "../evals.config";

// Maria's won quote at 412 Oak St (mowing, 3 yards of mulch, 40 feet of edging), Carlos booked there
// today. The session is Carlos's thread, so the agent runs as him. "Mulch is done" ticks that one item;
// the visit stays open with two to go.
export default defineEval<typeof config>({
  description: "Crew texting \"mulch is done\" ticks the mulch on the work's checklist, leaves the rest, and keeps the visit open.",
  tags: ["landscaping"],
  async test(t) {
    const business = await t.context.seed.landscaping();
    const { owner } = business;
    const ids = business.itemIdsByName;
    const noPost = async () => ({ posted: false as const, reason: "eval" });
    const carlos = await createMember({ orgId: business.orgId, name: "Carlos Reyes", role: "member", addedByMemberId: owner.memberId });
    const maria = await saveCustomer(business.orgId, { name: "Maria Alvarez", phone: "305 555 0142", address: "412 Oak St" }, owner.memberId);
    const quote = await createQuote(
      {
        title: "412 Oak St",
        customerId: maria.id,
        propertyId: maria.properties[0].id,
        lines: [
          { itemId: ids["Lawn mowing"], quantity: 1 },
          { itemId: ids["Mulch installed"], quantity: 3 },
          { itemId: ids["Bed edging"], quantity: 40 },
        ],
      },
      owner,
      { post: noPost },
    );
    await approveQuote(quote.quoteId, owner, { post: noPost });
    await setQuoteOutcome(quote.quoteId, "won", owner, { post: noPost });
    // Booked as of early this morning, so today's visit can be ticked; outside hours is fine on a weekend.
    const { timeZone } = await getProfile(business.orgId);
    const today = wallClock(new Date(), timeZone).date;
    const booked = await bookVisit(
      owner,
      { quoteId: quote.quoteId, memberIds: [carlos.id], day: today, time: "06:00", allowOutsideHours: true },
      { now: resolveLocalTime(today, "00:30", timeZone), post: noPost },
    );

    const session = await t.session();
    await upsertThread(business.orgId, carlos.id, session.sessionId);
    const turn = await session.send("mulch is done at oak st");
    t.succeeded();
    turn.calledTool("tick_checklist");
    turn.notCalledTool("change_visit_status");

    const items = await checklistFor(business.orgId, booked.visit.jobId);
    t.check(checklistCounts(items), equals({ done: 1, total: 3 })).label("items done");
    t.check(items.find((item) => item.doneAt)?.name ?? null, equals("Mulch installed")).label("the item ticked");
    t.check((await getVisit(owner, booked.visit.visitId))?.status ?? null, equals("scheduled")).label("visit still open");
    t.judge("The reply says the mulch is ticked off and names what's left (the mowing and the edging) in a line or two, with no prices and without saying the visit is done.").gate(0.7);
  },
});
