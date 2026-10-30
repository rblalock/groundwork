// Recurring work: how often a job's visits repeat, and when the next one falls. Pure date math in the business's
// time zone, on local dates and clocks, so a 9 AM visit stays 9 AM across a clock change. Booking the next visit
// is `rollForward` in core/scheduling.ts; grouping recurring work by area is core/route-days.ts.
//
// Every week: the next one is the first `weekday` after the last visit's day (a week on when it's the same day).
// Every two weeks: the first `weekday` after the week following it. Every month: the same weekday of the month
// as the last visit's (its 2nd Tuesday gives next month's 2nd Tuesday), or the month's last such weekday when it
// has no 5th.
import type { Recurrence } from "../schema/types";
import type { Language } from "./language";
import { clockMinutes, localTimeInstants, minutesClock, timeText, wallClock, weekdayOf } from "./scheduling-time";
import { addDays } from "./time";

export type { Recurrence };

/** How a member says it, as the tools take it. */
export const RECURRING = ["weekly", "biweekly", "monthly"] as const;
export type Recurring = (typeof RECURRING)[number];

const EVERY: Record<Recurring, Recurrence["every"]> = { weekly: "week", biweekly: "two_weeks", monthly: "month" };
const SAID: Record<Recurrence["every"], Recurring> = { week: "weekly", two_weeks: "biweekly", month: "monthly" };

/** "weekly" as a recurrence's period. */
export const everyOf = (recurring: Recurring): Recurrence["every"] => EVERY[recurring];
/** A recurrence's period as the tools say it: "weekly". */
export const recurringOf = (recurrence: Pick<Recurrence, "every">): Recurring => SAID[recurrence.every];

/** The first date after `ymd` (never `ymd` itself) that falls on `weekday`. */
export function weekdayAfter(ymd: string, weekday: number): string {
  return addDays(ymd, (weekday - weekdayOf(ymd) + 7) % 7 || 7);
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const ymdOf = (year: number, month: number, day: number) =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/** Which of its month's weekdays a date is: 1 for the first Tuesday, up to 5. */
export const weekOfMonth = (ymd: string) => Math.ceil(Number(ymd.slice(8, 10)) / 7);

/** The `nth` `weekday` of the month after `ymd`'s, or that month's last one when it has fewer. */
function sameWeekdayNextMonth(ymd: string, weekday: number, nth: number): string {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(5, 7));
  const [y, m] = month === 12 ? [year + 1, 1] : [year, month + 1];
  const first = 1 + ((weekday - weekdayOf(ymdOf(y, m, 1)) + 7) % 7);
  let day = first + 7 * (nth - 1);
  while (day > daysInMonth(y, m)) day -= 7;
  return ymdOf(y, m, day);
}

/** The instant a local clock reads on a date: the earlier of a repeated hour, and an hour on in a skipped one. */
function instantAt(ymd: string, clock: string, timeZone: string): Date {
  const [first] = localTimeInstants(ymd, clock, timeZone);
  if (first) return first;
  const [later] = localTimeInstants(ymd, minutesClock(Math.min(clockMinutes(clock) + 60, 23 * 60 + 45)), timeZone);
  return later;
}

export type Occurrence = { date: string; time: string; startAt: Date };

/**
 * When the visit after the one at `after` falls: its local date and clock, and the instant they name in
 * `timeZone`. The weekday and clock are the recurrence's, else the visit's own.
 */
export function nextOccurrence(recurrence: Recurrence, after: Date, timeZone: string): Occurrence {
  const last = wallClock(after, timeZone);
  const weekday = recurrence.weekday ?? weekdayOf(last.date);
  const time = recurrence.time ?? last.time;
  const date =
    recurrence.every === "month"
      ? sameWeekdayNextMonth(last.date, weekday, weekOfMonth(last.date))
      : weekdayAfter(recurrence.every === "two_weeks" ? addDays(last.date, 7) : last.date, weekday);
  return { date, time, startAt: instantAt(date, time, timeZone) };
}

/** The first occurrence after the one at `after` that's still to come at `now`: occurrences missed are skipped. */
export function nextOccurrenceFrom(recurrence: Recurrence, after: Date, timeZone: string, now: Date): Occurrence {
  let next = nextOccurrence(recurrence, after, timeZone);
  for (let i = 0; i < 520 && next.startAt <= now; i++) next = nextOccurrence(recurrence, next.startAt, timeZone);
  return next;
}

// ---------------------------------------------------------------------------------------------
// Words

const WEEKDAYS: Record<Language, { one: string[]; many: string[] }> = {
  en: {
    one: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    many: ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"],
  },
  es: {
    one: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
    many: ["domingos", "lunes", "martes", "miércoles", "jueves", "viernes", "sábados"],
  },
};

const ORDINALS: Record<Language, string[]> = {
  en: ["1st", "2nd", "3rd", "4th", "5th"],
  es: ["1.er", "2.º", "3.er", "4.º", "5.º"],
};

/** A weekday's name, one or many: "Tuesday", "Tuesdays"; "martes". */
export const weekdayName = (weekday: number, language: Language, many = false) => WEEKDAYS[language][many ? "many" : "one"][weekday];

/** A local clock as a member reads it: "9 AM", "9:30 AM"; "9 a.m.". */
export const clockText = (clock: string, language: Language) => timeText(new Date(`2000-01-03T${clock}:00Z`), "UTC", language);

/**
 * The recurrence in a line: "Every week on Tuesdays at 9 AM", "Every two weeks on Fridays at 1:30 PM", "Every month
 * on the 2nd Tuesday at 9 AM" (the weekday of the month from `onDate`, one of its visits; else "on a Tuesday").
 */
export function recurrenceText(recurrence: Recurrence, language: Language, onDate?: string): string {
  const es = language === "es";
  const every = {
    week: es ? "Cada semana" : "Every week",
    two_weeks: es ? "Cada dos semanas" : "Every two weeks",
    month: es ? "Cada mes" : "Every month",
  }[recurrence.every];
  const { weekday, time } = recurrence;
  let day = "";
  if (weekday !== undefined) {
    if (recurrence.every !== "month") day = es ? `, los ${weekdayName(weekday, language, true)}` : ` on ${weekdayName(weekday, language, true)}`;
    else if (onDate && weekdayOf(onDate) === weekday) {
      const nth = ORDINALS[language][weekOfMonth(onDate) - 1];
      day = es ? `, el ${nth} ${weekdayName(weekday, language)}` : ` on the ${nth} ${weekdayName(weekday, language)}`;
    } else day = es ? `, un ${weekdayName(weekday, language)}` : ` on a ${weekdayName(weekday, language)}`;
  }
  const at = time ? (es ? ` a las ${clockText(time, language)}` : ` at ${clockText(time, language)}`) : "";
  return `${every}${day}${at}`;
}
