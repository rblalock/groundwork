export type LocalParts = { ymd: string; hour: number; minute: number; weekday: number };

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of `date` in `timeZone`. `weekday` is 0 (Sunday) to 6 (Saturday). */
export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** True when the local hour falls in the quiet window. A window with start > end wraps midnight. */
export function isQuietHours(date: Date, timeZone: string, startHour: number, endHour: number): boolean {
  const { hour } = localParts(date, timeZone);
  if (startHour === endHour) return false;
  return startHour > endHour ? hour >= startHour || hour < endHour : hour >= startHour && hour < endHour;
}

/** The input when not in quiet hours, otherwise the next local `endHour:00`. */
export function nextAllowedTime(date: Date, timeZone: string, startHour: number, endHour: number): Date {
  if (!isQuietHours(date, timeZone, startHour, endHour)) return date;
  const { ymd, hour } = localParts(date, timeZone);
  const wraps = startHour > endHour;
  const targetYmd = wraps && hour >= startHour ? addDays(ymd, 1) : ymd;
  return zonedTimeToDate(targetYmd, endHour, 0, timeZone);
}

/** Add whole days to a `YYYY-MM-DD` calendar date. */
export function addDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function todayYmd(timeZone: string, now: Date = new Date()): string {
  return localParts(now, timeZone).ymd;
}

/** The instant whose wall-clock time in `timeZone` is `ymd hour:minute`. */
function zonedTimeToDate(ymd: string, hour: number, minute: number, timeZone: string): Date {
  const [year, month, day] = ymd.split("-").map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), timeZone);
    const [py, pm, pd] = p.ymd.split("-").map(Number);
    const actual = Date.UTC(py, pm - 1, pd, p.hour, p.minute);
    if (actual === wanted) break;
    guess += wanted - actual;
  }
  return new Date(guess);
}
