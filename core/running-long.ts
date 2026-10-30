// The ten-minute check on crews running long. Per business with a stop under way or a declared delay today,
// it re-plans each crew's day from now (`core/day-plan.ts`) and hands each day at risk to `dayAtRisk`, which
// raises a proposal to move its last stops (`core/proposals.ts`) and texts it to the owners. The schedule page
// and the tools compute the same plans live from the visits; the proposal is the only thing this records. Each
// run also expires the proposals whose day is over.
import { and, eq, gt, inArray, isNotNull, lt, or } from "drizzle-orm";
import { visits } from "../schema/schema";
import { db } from "./db";
import { dayPlans, type DayPlan } from "./day-plan";
import { listOrganizations } from "./organizations";
import { expireProposals, proposeMoves, sendProposal, type Proposal } from "./proposals";

const HOUR = 3_600_000;

/** What a day at risk is handed to. */
export type AtRiskHandler = (orgId: string, plan: DayPlan) => Promise<unknown>;

/**
 * A day at risk, re-planned from now: running long, and back past the workday's end plus the grace. Raises its
 * move proposal (once per member and day) and texts it to the owners; a day with no stop that can move is only
 * logged.
 */
export async function dayAtRisk(orgId: string, plan: DayPlan): Promise<{ proposal: Proposal; sent: string[] } | null> {
  const proposal = await proposeMoves(orgId, plan);
  if (!proposal) {
    console.info("running long: a day is at risk, with nothing to propose", {
      orgId,
      memberId: plan.memberId,
      date: plan.date,
      shiftMinutes: plan.replan?.shiftMinutes ?? 0,
      backAtYardAt: plan.backAtYardAt?.toISOString() ?? null,
    });
    return null;
  }
  const sent = await sendProposal(orgId, proposal, { now: plan.replan?.at });
  console.info("running long: proposed moving stops", { orgId, proposalId: proposal.id, items: proposal.items.length, sent: sent.length });
  return { proposal, sent };
}

/** Whether the business has an open visit near now that's started or has a delay: the only days worth re-planning. */
async function hasStartedVisits(orgId: string, now: Date): Promise<boolean> {
  const [row] = await db()
    .select({ id: visits.id })
    .from(visits)
    .where(
      and(
        eq(visits.orgId, orgId),
        inArray(visits.status, ["proposed", "scheduled"]),
        or(isNotNull(visits.startedAt), gt(visits.delayMinutes, 0)),
        gt(visits.startAt, new Date(now.getTime() - 24 * HOUR)),
        lt(visits.startAt, new Date(now.getTime() + 24 * HOUR)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** One business's crews running long today; returns the days at risk it handed on. */
export async function checkRunningLong(orgId: string, now: Date, onAtRisk: AtRiskHandler = dayAtRisk): Promise<DayPlan[]> {
  if (!(await hasStartedVisits(orgId, now))) return [];
  // The whole business's day, as an owner sees it; nobody is acting.
  const { plans } = await dayPlans({ orgId, memberId: null, role: "owner" }, { date: "today" }, { now });
  const atRisk = plans.filter((plan) => plan.atRisk);
  for (const plan of atRisk) await onAtRisk(orgId, plan);
  return atRisk;
}

/** The ten-minute schedule's entry point: every business that isn't paused, its proposals past their day expired first. A failure is logged, never thrown. */
export async function runningLongTick(now: Date = new Date(), onAtRisk: AtRiskHandler = dayAtRisk): Promise<number> {
  let count = 0;
  try {
    for (const org of await listOrganizations()) {
      if (org.suspended) continue;
      try {
        await expireProposals(org.id, now);
        count += (await checkRunningLong(org.id, now, onAtRisk)).length;
      } catch (error) {
        console.error("running long: the check failed for a business", { orgId: org.id, error });
      }
    }
  } catch (error) {
    console.error("running long: the check failed", error);
  }
  return count;
}
