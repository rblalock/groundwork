// Wall-clock time for the schedule, in the business's time zone, never the server's. The rules:
// a local time in a clock-change gap doesn't exist, one in the repeated
// hour needs its UTC offset, and a visit fits working hours only if every minute of it does.
import { z } from "zod";
import type { WorkingInterval } from "../schema/types";
import { localeFor, type Language } from "./language";
import { addDays } from "./time";

export type { WorkingInterval };

export const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const MINUTE = 60_000;

export const clockSchema = z.string().regex(CLOCK, "Use 24-hour HH:MM, like 09:00 or 14:30.");

/** A week of working hours: each interval ends after it starts, and a day's intervals don't overlap. */
export const workHoursSchema = z
  .array(z.object({ day: z.number().int().min(0).max(6), start: clockSchema, end: clockSchema }).strict())
  .max(35)
  .superRefine((hours, ctx) => {
    hours.forEach((value, index) => {
      if (value.start >= value.end) ctx.addIssue({ code: "custom", message: "Each stretch must end after it starts, on the same day.", path: [index, "end"] });
      if (hours.some((other, i) => i < index && other.day === value.day && other.start < value.end && value.start < other.end)) {
        ctx.addIssue({ code: "custom", message: "A day's stretches must not overlap.", path: [index] });
      }
    });
  });

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let result = formatters.get(timeZone);
  if (!result) {
    result = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    if (formatters.size >= 100) formatters.clear();
    formatters.set(timeZone, result);
  }
  return result;
}

/** The instant's local date (`YYYY-MM-DD`) and clock (`HH:MM`) in `timeZone`. */
export function wallClock(instant: Date, timeZone: string): { date: string; time: string; second: number } {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, second: Number(parts.second) };
}

/** Minutes since local midnight for `HH:MM`. */
export const clockMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
export const minutesClock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Weekday of a calendar date, 0 (Sunday) to 6. */
export const weekdayOf = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

export function isYmd(value: string): boolean {
  const match = YMD.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2200 && date.toISOString().slice(0, 10) === value;
}

/** The UTC offset in minutes the instant has in `timeZone` (New York in summer: -240). */
export function offsetMinutesAt(instant: Date, timeZone: string): number {
  const { date, time } = wallClock(instant, timeZone);
  return (Date.parse(`${date}T${time}:00Z`) - Math.floor(instant.getTime() / MINUTE) * MINUTE) / MINUTE;
}

/**
 * The instant a local date and clock name in `timeZone`. Throws `INVALID_DATE` or `INVALID_TIME` for
 * malformed input, `NONEXISTENT_TIME` for a clock the spring-forward gap skips, and `AMBIGUOUS_TIME` for
 * one the fall-back hour repeats, unless `offsetMinutes` picks which.
 */
export function resolveLocalTime(ymd: string, clock: string, timeZone: string, offsetMinutes?: number): Date {
  if (!isYmd(ymd)) throw new Error(`INVALID_DATE: ${ymd}`);
  if (!CLOCK.test(clock)) throw new Error(`INVALID_TIME: ${clock}`);
  const wall = Date.parse(`${ymd}T${clock}:00Z`);
  const offsets = new Set<number>();
  // Probing either side of the day catches both sides of a clock change.
  for (let hours = -36; hours <= 36; hours += 6) offsets.add(offsetMinutesAt(new Date(wall + hours * 3_600_000), timeZone));
  const candidates = [...offsets]
    .map((offset) => ({ offset, instant: new Date(wall - offset * MINUTE) }))
    .filter(({ instant }) => {
      const local = wallClock(instant, timeZone);
      return local.date === ymd && local.time === clock;
    })
    .sort((a, b) => a.instant.getTime() - b.instant.getTime());
  if (candidates.length === 0) throw new Error(`NONEXISTENT_TIME: ${ymd} ${clock}`);
  if (offsetMinutes !== undefined) {
    const chosen = candidates.find((c) => c.offset === offsetMinutes);
    if (!chosen) throw new Error(`INVALID_TIME: ${ymd} ${clock} has no UTC offset ${offsetMinutes}`);
    return chosen.instant;
  }
  if (candidates.length > 1) {
    throw new Error(`AMBIGUOUS_TIME: ${ymd} ${clock} happens twice (UTC offsets ${candidates.map((c) => c.offset).join(" and ")})`);
  }
  return candidates[0].instant;
}

/** Every instant the local clock reads `clock` on `ymd`: none in a gap, two in a repeated hour. */
export function localTimeInstants(ymd: string, clock: string, timeZone: string): Date[] {
  try {
    return [resolveLocalTime(ymd, clock, timeZone)];
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("NONEXISTENT_TIME")) return [];
    if (!message.startsWith("AMBIGUOUS_TIME")) throw error;
    const offsets = [...new Set([-36, -30, -24, -18, -12, -6, 0, 6, 12, 18, 24, 30, 36].map((h) =>
      offsetMinutesAt(new Date(Date.parse(`${ymd}T${clock}:00Z`) + h * 3_600_000), timeZone),
    ))];
    return offsets
      .flatMap((offset) => {
        try {
          return [resolveLocalTime(ymd, clock, timeZone, offset)];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.getTime() - b.getTime());
  }
}

/** A day's working stretches in minutes, merged where they touch. */
export function workingSegments(ymd: string, hours: WorkingInterval[]): Array<{ start: number; end: number }> {
  const day = weekdayOf(ymd);
  const values = hours
    .filter((h) => h.day === day)
    .map((h) => ({ start: clockMinutes(h.start), end: clockMinutes(h.end) }))
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const value of values) {
    const previous = merged.at(-1);
    if (previous && value.start <= previous.end) previous.end = Math.max(previous.end, value.end);
    else merged.push({ ...value });
  }
  return merged;
}

/**
 * True when every minute from `startAt` to `endAt` is working time on one local day. Without a clock
 * change in between, the local clock runs straight, so the ends decide; across one, each minute is checked.
 */
export function withinWorkingHours(startAt: Date, endAt: Date, timeZone: string, hours: WorkingInterval[]): boolean {
  if (endAt <= startAt) return false;
  const start = wallClock(startAt, timeZone);
  const last = wallClock(new Date(endAt.getTime() - MINUTE), timeZone);
  if (start.date !== last.date) return false;
  const segments = workingSegments(start.date, hours);
  const inside = (minute: number) => segments.some((s) => minute >= s.start && minute < s.end);
  const startMinute = clockMinutes(start.time);
  const lastMinute = clockMinutes(last.time);
  const elapsed = (endAt.getTime() - startAt.getTime()) / MINUTE;
  if (lastMinute - startMinute === elapsed - 1) {
    return segments.some((s) => startMinute >= s.start && lastMinute < s.end);
  }
  for (let at = startAt.getTime(); at < endAt.getTime(); at += MINUTE) {
    const local = wallClock(new Date(at), timeZone);
    if (local.date !== start.date || !inside(clockMinutes(local.time))) return false;
  }
  return true;
}

export type Interval = { startAt: Date; endAt: Date };

/** A visit's time with its buffers: what it keeps its crew from doing. */
export function occupiedInterval(visit: { startAt: Date; endAt: Date; bufferBeforeMinutes: number; bufferAfterMinutes: number }): Interval {
  return {
    startAt: new Date(visit.startAt.getTime() - visit.bufferBeforeMinutes * MINUTE),
    endAt: new Date(visit.endAt.getTime() + visit.bufferAfterMinutes * MINUTE),
  };
}

export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.startAt < b.endAt && b.startAt < a.endAt;
}

const WEEKDAY_WORDS: Record<string, number> = {
  sunday: 0, sun: 0, domingo: 0,
  monday: 1, mon: 1, lunes: 1,
  tuesday: 2, tue: 2, tues: 2, martes: 2,
  wednesday: 3, wed: 3, miercoles: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, jueves: 4,
  friday: 5, fri: 5, viernes: 5,
  saturday: 6, sat: 6, sabado: 6,
};

/**
 * A day as a member says it, to a calendar date in the business's time zone: `YYYY-MM-DD`, "today",
 * "tomorrow", or a weekday ("Tuesday", "martes"), which is the next one to come; said on a Tuesday,
 * "Tuesday" is a week out. Throws `INVALID_DATE` for anything else.
 */
export function resolveDay(phrase: string, timeZone: string, now: Date = new Date()): string {
  const value = phrase.trim();
  if (isYmd(value)) return value;
  const word = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^(el proximo|this|next|el|este|proximo)\s+/, "")
    .replace(/[.,]$/, "")
    .trim();
  const today = wallClock(now, timeZone).date;
  if (word === "today" || word === "hoy") return today;
  if (word === "tomorrow" || word === "manana") return addDays(today, 1);
  const weekday = WEEKDAY_WORDS[word];
  if (weekday === undefined) throw new Error(`INVALID_DATE: ${phrase}`);
  const ahead = (weekday - weekdayOf(today) + 7) % 7 || 7;
  return addDays(today, ahead);
}

/** Monday of the week `ymd` is in. */
export function weekStart(ymd: string): string {
  return addDays(ymd, -((weekdayOf(ymd) + 6) % 7));
}

// ---------------------------------------------------------------------------------------------
// Words for times, in the member's language

/** "9 AM", "9:30 AM"; "9 a.m." in Spanish. */
export function timeText(instant: Date, timeZone: string, language: Language): string {
  const minutes = clockMinutes(wallClock(instant, timeZone).time) % 60;
  return new Intl.DateTimeFormat(localeFor(language), {
    timeZone,
    hour: "numeric",
    ...(minutes ? { minute: "2-digit" } : {}),
  }).format(instant);
}

/** "Tue, Oct 20"; "mar, 20 de oct" in Spanish. */
export function dayText(ymd: string, language: Language): string {
  return new Intl.DateTimeFormat(localeFor(language), { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(
    new Date(`${ymd}T12:00:00Z`),
  );
}

/** "Tue, Oct 20, 9 AM–11:30 AM". */
export function whenText(startAt: Date, endAt: Date, timeZone: string, language: Language): string {
  const day = dayText(wallClock(startAt, timeZone).date, language);
  return `${day}, ${timeText(startAt, timeZone, language)}–${timeText(endAt, timeZone, language)}`;
}

/** "1 hr 30 min". */
export function durationText(minutes: number, language: Language): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hr = language === "es" ? "h" : "hr";
  return h ? `${h} ${hr}${m ? ` ${m} min` : ""}` : `${m} min`;
}
