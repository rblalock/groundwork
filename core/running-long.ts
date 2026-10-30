// The ten-minute check on crews running long. Per business with a stop under way or a declared delay today,
// it re-plans each crew's day from now (`core/day-plan.ts`) and hands each day at risk to `dayAtRisk`, which
// for now only logs it. The schedule page and the tools compute the same plans live from the visits, so this
// records nothing; it's where a day at risk turns into a proposal to move its last stops.
import { and, eq, gt, inArray, isNotNull, lt, or } from "drizzle-orm";
import { visits } from "../schema/schema";
import { db } from "./db";
import { dayPlans, type DayPlan } from "./day-plan";
import { listOrganizations } from "./organizations";

const HOUR = 3_600_000;

/** What a day at risk is handed to. */
export type AtRiskHandler = (orgId: string, plan: DayPlan) => Promise<void>;

/** A day at risk, re-planned from now: running long, and back past the workday's end plus the grace. Logs it. */
export async function dayAtRisk(orgId: string, plan: DayPlan): Promise<void> {
  console.info("running long: a day is at risk", {
    orgId,
    memberId: plan.memberId,
    date: plan.date,
    visitId: plan.replan?.visitId ?? null,
    shiftMinutes: plan.replan?.shiftMinutes ?? 0,
    backAtYardAt: plan.backAtYardAt?.toISOString() ?? null,
    latestBackAt: plan.replan?.latestBackAt?.toISOString() ?? null,
  });
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

/** The ten-minute schedule's entry point: every business that isn't paused. A failure is logged, never thrown. */
export async function runningLongTick(now: Date = new Date(), onAtRisk: AtRiskHandler = dayAtRisk): Promise<number> {
  let count = 0;
  try {
    for (const org of await listOrganizations()) {
      if (org.suspended) continue;
      try {
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
