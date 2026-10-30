import assert from "node:assert/strict";
import { organization } from "../schema/schema";
import { startStop } from "./crew-phone";
import { saveCustomer } from "./customers";
import { db } from "./db";
import type { DayPlan } from "./day-plan";
import { createMember, type Caller } from "./members";
import { updateProfile } from "./profile";
import type { Poster } from "./quotes";
import { checkRunningLong, runningLongTick } from "./running-long";
import { bookVisit } from "./scheduling";
import { TEST_ORG, withTestDb } from "./test-db";

const local = (clock: string) => new Date(`2026-11-03T${clock}:00-05:00`); // a Tuesday in New York

async function member(name: string, role: Caller["role"], orgId = TEST_ORG): Promise<Caller> {
  const row = await createMember({ orgId, name, role });
  return { orgId, memberId: row.id, name, role, language: "en", phoneE164: null };
}

withTestDb("running long: only a business with a stop under way is re-planned, and only a day at risk is handed on", async () => {
  const post: Poster = async () => ({ posted: true });
  const owner = await member("Pat Ortega", "owner");
  const carlos = await member("Carlos Reyes", "member");
  await updateProfile(TEST_ORG, { timeZone: "America/New_York", address: "100 Bridge Rd, Tequesta, FL", dayEndGraceMinutes: 0 }, owner.memberId);
  const maria = await saveCustomer(TEST_ORG, { name: "Maria Alvarez", address: "412 Oak St" }, owner.memberId);
  const pine = await saveCustomer(TEST_ORG, { name: "Pine Customer", address: "7 Pine Ave" }, owner.memberId);
  const book = (customer: typeof maria, time: string) =>
    bookVisit(owner, { title: customer.properties[0].address, customerId: customer.id, propertyId: customer.properties[0].id, memberIds: [carlos.memberId], day: "2026-11-03", time }, { now: local("07:00"), post });
  await book(maria, "13:00");
  await book(pine, "14:30");
  await db().insert(organization).values({ id: "org_other", name: "Other", slug: "other" });

  const handed: Array<[string, DayPlan]> = [];
  const onAtRisk = async (orgId: string, plan: DayPlan) => void handed.push([orgId, plan]);
  assert.deepEqual(await checkRunningLong(TEST_ORG, local("15:50"), onAtRisk), [], "nothing started: nothing to re-plan");

  await startStop(carlos, {}, { now: local("13:05") });
  assert.deepEqual(await checkRunningLong(TEST_ORG, local("14:10"), onAtRisk), [], "on site, not running long yet");
  assert.equal(await runningLongTick(local("15:50"), onAtRisk), 1);
  assert.deepEqual(handed.map(([orgId, plan]) => [orgId, plan.name, plan.atRisk, plan.replan?.runningLong]), [[TEST_ORG, "Carlos Reyes", true, true]]);
});
