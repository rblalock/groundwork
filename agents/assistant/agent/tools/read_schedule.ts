import { defineTool } from "eve/tools";
import { z } from "zod";
import { planForTool, plansIn } from "../../../../core/day-plan";
import { isPrivileged } from "../../../../core/members";
import { getProfile } from "../../../../core/profile";
import { openProposals, proposalForTool } from "../../../../core/proposals";
import { recurrenceText } from "../../../../core/recurrence";
import { readSchedule, timeOffText, toSchedule, visitForTool } from "../../../../core/scheduling";
import { dayText, wallClock } from "../../../../core/scheduling-time";
import { plain, requireCaller, toolError } from "../../../../core/tool-context";
import { scheduleWeather } from "../../../../core/weather";

export default defineTool({
  description:
    "Read the schedule: the visits (and time off) from a day for a number of days, in the business's time zone, earliest first. Use it for \"what's on today?\", \"what's Carlos doing Tuesday?\", \"when is Oak St?\", and before moving or cancelling a visit, for its visitId. day is YYYY-MM-DD, today, tomorrow, or a weekday name, resolved by the code. query keeps visits whose title, customer, or address match. Crew see only their own visits. For owners and admins it also lists work waiting to be scheduled. Each visit's line is ready to send; recurring says how its work repeats (\"Every week on Tuesdays at 9 AM\"). routes (for up to 7 days) is each crew member's day as a route, worked out by the code: when they leave the yard and are back, minutes driving and on site, how full the day is against the business's capacity, stops they'd reach late, and a shorter order when one saves driving; crew get only their own. For one person's day, send the route's line. For owners and admins, proposals lists the open proposals to move stops off a day running long or off a day of rain or heat, numbered as their text was, for apply_proposal or drop_proposal. weather is the forecast's line for each day within the next two (\"Tomorrow: rain 70% 10 AM–2 PM, high 84°F\"), from the code: send it as it is, and say nothing of the weather beyond it.",
  inputSchema: z.object({
    day: z.string().default("today").describe("YYYY-MM-DD, today, tomorrow, or a weekday name, as the member said it."),
    days: z.number().int().min(1).max(42).default(1),
    memberId: z.string().optional().describe("Only this member's visits."),
    query: z.string().optional(),
    includeCancelled: z.boolean().default(false),
  }),
  async execute({ day, days, memberId, query, includeCancelled }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const schedule = await readSchedule(caller, { from: day, days, memberId, includeCancelled });
      const { timeZone } = schedule;
      const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const visits = schedule.visits.filter((v) =>
        words.every((w) => [v.title, v.customerName, v.address].some((field) => field?.toLowerCase().includes(w))),
      );
      const waiting = isPrivileged(caller.role) ? await toSchedule(caller.orgId) : [];
      const profile = await getProfile(caller.orgId);
      const routes = days <= 7 ? plansIn(caller, schedule, profile) : [];
      const weather = await scheduleWeather(profile, { from: schedule.from, to: schedule.to, today: schedule.today, language: caller.language });
      const open = isPrivileged(caller.role) ? (await openProposals(caller)).proposals : [];
      return plain({
        timeZone,
        today: `${dayText(schedule.today, caller.language)} (${schedule.today})`,
        now: wallClock(new Date(), timeZone).time,
        from: schedule.from,
        days,
        visits: visits.map((v) => visitForTool(v, timeZone, caller.language)),
        timeOff: schedule.timeOff.map((b) => ({
          timeOffId: b.id,
          who: b.memberName ?? "the whole business",
          when: timeOffText(b, timeZone, caller.language),
          reason: b.reason,
        })),
        crew: schedule.crew.map((c) => ({ memberId: c.memberId, name: c.name, hours: c.hours, ownHours: c.ownHours })),
        routes: routes.map((plan) => planForTool(plan, timeZone, caller.language)),
        ...(weather.length ? { weather: weather.map((w) => w.line) } : {}),
        ...(isPrivileged(caller.role)
          ? {
              proposals: open.map((p) => proposalForTool(p, timeZone, caller.language)),
              toSchedule: waiting.slice(0, 10).map((w) =>
                w.kind === "quote"
                  ? { quoteId: w.quoteId, title: w.title, customerName: w.customerName, why: "won, no visit yet" }
                  : {
                      jobId: w.jobId,
                      quoteId: w.quoteId,
                      title: w.title,
                      customerName: w.customerName,
                      why: "open, no visit booked",
                      ...(w.recurrence ? { recurring: recurrenceText(w.recurrence, caller.language) } : {}),
                    },
              ),
            }
          : {}),
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
