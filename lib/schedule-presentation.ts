// Calendar geometry for the Schedule page. It only
// draws: whether a time can be booked is always the scheduling library's call, on the server.
import { clockMinutes, wallClock, workingSegments } from "../core/scheduling-time";
import type { VisitJson } from "./pages/schedule";

export { clockMinutes, workingSegments };

/** `YYYY-MM-DDTHH:MM` of the instant in the business's time zone. */
export function localDateTime(value: Date | string, timeZone: string): string {
  const { date, time } = wallClock(new Date(value), timeZone);
  return `${date}T${time}`;
}

export type CalendarSegment = { start: number; end: number; continuesBefore: boolean; continuesAfter: boolean; clockChange: boolean };

/**
 * Where an interval falls on one local day, in minutes from midnight, or null when it doesn't touch
 * that day. A clock change inside it is flagged, and a visit across the repeated hour keeps its real
 * length instead of collapsing.
 */
export function calendarDaySegment(startAt: string, endAt: string, date: string, timeZone: string): CalendarSegment | null {
  if (Date.parse(endAt) <= Date.parse(startAt)) return null;
  const localStart = localDateTime(startAt, timeZone);
  const localEnd = localDateTime(endAt, timeZone);
  const startDate = localStart.slice(0, 10);
  const endDate = localEnd.slice(0, 10);
  if (startDate > date || endDate < date || (endDate === date && localEnd.slice(11) === "00:00")) return null;
  const start = startDate < date ? 0 : clockMinutes(localStart.slice(11));
  const wallEnd = endDate > date ? 1440 : clockMinutes(localEnd.slice(11));
  const elapsed = (Date.parse(endAt) - Date.parse(startAt)) / 60_000;
  const clockChange = startDate === endDate && Math.abs(wallEnd - start - elapsed) > 0.1;
  const end = wallEnd <= start && clockChange ? Math.min(1440, start + elapsed) : wallEnd;
  return end > start ? { start, end, continuesBefore: startDate < date, continuesAfter: endDate > date, clockChange } : null;
}

/** Side-by-side lanes for entries that overlap in time, like a calendar app does. */
export function layoutCalendarSegments<T extends { id: string; start: number; end: number }>(input: T[]): Array<T & { lane: number; lanes: number }> {
  const sorted = [...input].sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
  const result: Array<T & { lane: number; lanes: number }> = [];
  let group: Array<T & { lane: number; lanes: number }> = [];
  let laneEnds: number[] = [];
  let groupEnd = -1;
  const finish = () => {
    for (const item of group) item.lanes = laneEnds.length;
    result.push(...group);
    group = [];
    laneEnds = [];
  };
  for (const value of sorted) {
    if (group.length && value.start >= groupEnd) finish();
    let lane = laneEnds.findIndex((end) => end <= value.start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = value.end;
    group.push({ ...value, lane, lanes: 1 });
    groupEnd = Math.max(...laneEnds);
  }
  finish();
  return result;
}

/** Shifts a `YYYY-MM-DD` date by whole days. */
export function shiftDate(value: string, offset: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Dragging a visit (components/schedule/drag.ts): what a drop would ask the Reschedule route for.

/** Where a dragged visit would go: its day, the lane (crew member) it's dropped in, and its start, in minutes. */
export type MoveTarget = { visitId: string; date: string; memberId: string; minute: number };

/** A move to confirm: the visit, where it goes, and the crew it would have there. */
export type MoveRequest = MoveTarget & {
  visit: VisitJson;
  fromMemberId: string;
  /** `HH:MM` of `minute`. */
  time: string;
  memberIds: string[];
  durationMinutes: number;
};

export const SNAP_MINUTES = 15;

export const visitMinutes = (visit: VisitJson) => Math.round((Date.parse(visit.endAt) - Date.parse(visit.startAt)) / 60_000);

export const clockOf = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** Rounds to the nearest quarter hour. */
export const snap = (minute: number) => Math.round(minute / SNAP_MINUTES) * SNAP_MINUTES;

/** A visit that can be dragged: still open, its work open, and starting and ending on one day. */
export function draggable(visit: VisitJson, timeZone: string): boolean {
  if (visit.status !== "scheduled" && visit.status !== "proposed") return false;
  if (visit.jobStatus !== "open") return false;
  const start = localDateTime(visit.startAt, timeZone);
  const end = localDateTime(visit.endAt, timeZone);
  return start.slice(0, 10) === end.slice(0, 10) || end.slice(11) === "00:00";
}

/** The crew a visit would have after moving from one lane to another: that one person swaps. */
export function crewAfterMove(visit: VisitJson, fromMemberId: string, toMemberId: string): string[] {
  const ids = visit.crew.map((c) => c.memberId);
  if (fromMemberId === toMemberId || ids.includes(toMemberId)) return ids;
  return ids.map((id) => (id === fromMemberId ? toMemberId : id));
}

/** The request for dropping `visit`, dragged from `fromMemberId`'s lane, on `target`; null when it didn't move. */
export function moveRequest(visit: VisitJson, fromMemberId: string, target: MoveTarget, timeZone: string): MoveRequest | null {
  const local = localDateTime(visit.startAt, timeZone);
  const memberIds = crewAfterMove(visit, fromMemberId, target.memberId);
  const sameCrew = memberIds.every((id, i) => id === visit.crew[i]?.memberId);
  if (sameCrew && target.date === local.slice(0, 10) && target.minute === clockMinutes(local.slice(11))) return null;
  return { ...target, visit, fromMemberId, time: clockOf(target.minute), memberIds, durationMinutes: visitMinutes(visit) };
}
