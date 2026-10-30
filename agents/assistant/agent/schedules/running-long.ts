import { defineSchedule } from "eve/schedules";
import { runningLongTick } from "../../../../core/running-long";

// Every ten minutes, crews running long: each business with a stop under way or a delay declared today has
// its days re-planned from now, and a day whose return runs past the workday's end plus the grace is handed
// on (`core/running-long.ts`). Businesses with nothing started cost one small query. Needs Vercel Pro crons.
export default defineSchedule({
  cron: "*/10 * * * *",
  run({ waitUntil }) {
    waitUntil(runningLongTick());
  },
});
