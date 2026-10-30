"use client";

import { Check, CircleDashed, Clock3, Moon } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { localeFor, type Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import type { CrewJson, TimeOffJson, VisitJson } from "@/lib/pages/schedule";
import { calendarDaySegment, clockMinutes, layoutCalendarSegments, localDateTime, workingSegments } from "@/lib/schedule-presentation";
import { cn } from "@/ui/lib/utils";
import { SNAP_MINUTES, draggable, moveRequest, snap, useVisitDrag, visitMinutes, type MoveRequest, type MoveTarget } from "./drag";

// The Schedule page's two views. Day: a time grid with a lane per crew member. Week: a row per crew
// member and a column per day, each visit a card in its day. Both only draw; booking is checked on
// the server. Owners and admins can drag a visit to another time or lane (day) or another day or lane
// (week); the board confirms the move and sends it like the Reschedule form (./drag.ts).

const HOUR = 56;

export function timeLabel(value: string, timeZone: string, language: Language): string {
  const minutes = clockMinutes(localDateTime(value, timeZone).slice(11)) % 60;
  return new Intl.DateTimeFormat(localeFor(language), { timeZone, hour: "numeric", ...(minutes ? { minute: "2-digit" } : {}) }).format(new Date(value));
}

/** "8:30–11:30 AM": the first time drops its AM or PM when both share it. */
export function rangeLabel(startAt: string, endAt: string, timeZone: string, language: Language): string {
  const start = timeLabel(startAt, timeZone, language);
  const end = timeLabel(endAt, timeZone, language);
  const period = /\s?[AP]M$/.exec(start)?.[0];
  return period && end.endsWith(period) ? `${start.slice(0, -period.length)}–${end}` : `${start}–${end}`;
}

export function clockLabel(minutes: number, language: Language): string {
  return new Intl.DateTimeFormat(localeFor(language), { timeZone: "UTC", hour: "numeric", ...(minutes % 60 ? { minute: "2-digit" } : {}) }).format(
    new Date(Date.UTC(2000, 0, 1, 0, minutes)),
  );
}

export function dayLabel(date: string, language: Language, options: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }): string {
  return new Intl.DateTimeFormat(localeFor(language), { timeZone: "UTC", ...options }).format(new Date(`${date}T12:00:00Z`));
}

/** How a visit's card looks by status: booked is solid, pencilled in is dashed, done is green, cancelled is struck. */
export const VISIT_TONES: Record<VisitJson["status"], string> = {
  scheduled: "bg-accent-tint text-accent-ink border-l-[3px] border-accent",
  proposed: "bg-surface text-ink border border-dashed border-accent",
  completed: "bg-green-tint text-green border-l-[3px] border-green",
  cancelled: "bg-inset text-ink-3 line-through border-l-[3px] border-line-strong",
};

const visitIcon = (status: VisitJson["status"]) =>
  status === "completed" ? <Check aria-hidden="true" className="size-3 shrink-0" /> : status === "proposed" ? <CircleDashed aria-hidden="true" className="size-3 shrink-0" /> : null;

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

type Shared = {
  timeZone: string;
  today: string;
  language: Language;
  crew: CrewJson[];
  visits: VisitJson[];
  timeOff: TimeOffJson[];
  selectedId: string | null;
  onVisit: (visit: VisitJson) => void;
  onTimeOff: (block: TimeOffJson) => void;
  /** Owners and admins: a visit was dragged somewhere; the board confirms it. Absent, nothing drags. */
  onMove?: (move: MoveRequest) => void;
  /** A dropped move waiting on its confirmation, drawn where it would go. */
  pending?: MoveTarget | null;
};

/** The visit being dragged, drawn where it would land. */
function Ghost({ visit, start, end, language, className, style }: { visit: VisitJson; start: number; end: number; language: Language; className?: string; style?: CSSProperties }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none rounded-[8px] border-2 border-dashed border-accent bg-accent-tint px-2 py-1 text-[12px] leading-tight text-accent-ink shadow-card",
        className,
      )}
      style={style}
    >
      <span className="block truncate font-medium">{visit.title}</span>
      <span className="block truncate tabular-nums">
        {clockLabel(start, language)}–{clockLabel(end % 1440, language)}
      </span>
    </div>
  );
}

const DRAGGABLE = "cursor-grab active:cursor-grabbing";

/** One day as a time grid, a lane per crew member, with their working hours lit and the rest shaded. */
export function DayGrid({ date, ...shared }: Shared & { date: string }) {
  const { timeZone, today, language, crew, visits, timeOff, selectedId, onVisit, onTimeOff, onMove, pending } = shared;
  const copy = pageCopyFor(language).schedule;
  const now = useNow();
  const lanes = crew.map((member) => {
    const hours = workingSegments(date, member.hours);
    const entries = [
      ...visits
        .filter((v) => v.crew.some((c) => c.memberId === member.memberId))
        .flatMap((visit) => {
          const segment = calendarDaySegment(visit.startAt, visit.endAt, date, timeZone);
          return segment ? [{ ...segment, id: visit.visitId, visit, block: undefined }] : [];
        }),
      ...timeOff
        .filter((b) => !b.memberId || b.memberId === member.memberId)
        .flatMap((block) => {
          const segment = calendarDaySegment(block.startAt, block.endAt, date, timeZone);
          return segment ? [{ ...segment, id: `${block.id}:${member.memberId}`, visit: undefined, block }] : [];
        }),
    ];
    // Short visits get room for their label; the lane math uses the drawn size.
    const laid = layoutCalendarSegments(entries.map((e) => ({ ...e, real: e.end, end: Math.max(e.end, e.start + 30) }))).map((e) => ({ ...e, end: e.real }));
    return { member, hours, entries: laid };
  });
  const bounds = lanes.flatMap((lane) => [...lane.hours, ...lane.entries.filter((e) => e.visit || e.end - e.start < 1440)]);
  const first = Math.max(0, Math.floor(Math.min(7 * 60, ...bounds.map((b) => b.start)) / 60) * 60);
  const last = Math.min(1440, Math.ceil(Math.max(19 * 60, ...bounds.map((b) => b.end)) / 60) * 60);
  const height = ((last - first) / 60) * HOUR;
  const top = (minute: number) => ((Math.max(first, minute) - first) / 60) * HOUR;
  const span = (start: number, end: number) => ({ top: top(start), height: Math.max(18, ((Math.min(last, end) - Math.max(first, start)) / 60) * HOUR) });
  const nowMinute = clockMinutes(localDateTime(now, timeZone).slice(11));
  const axis = Array.from({ length: (last - first) / 60 + 1 }, (_, i) => first + i * 60);
  const grid: CSSProperties = { gridTemplateColumns: `3.5rem repeat(${Math.max(1, lanes.length)}, minmax(0, 1fr))`, minWidth: `${3.5 + Math.max(1, lanes.length) * 11}rem` };

  // Dragging: the lane under the pointer and the quarter hour the visit's top would snap to.
  const laneOf = (element: Element | null) => element?.closest<HTMLElement>("[data-lane]") ?? null;
  const minuteAt = (y: number, lane: HTMLElement) => first + ((y - lane.getBoundingClientRect().top) / HOUR) * 60;
  const { target, dragging, bind } = useVisitDrag({
    enabled: Boolean(onMove),
    grabAt: (event, visit) => {
      const lane = laneOf(event.currentTarget);
      return lane ? minuteAt(event.clientY, lane) - clockMinutes(localDateTime(visit.startAt, timeZone).slice(11)) : 0;
    },
    locate: (x, y, { visit, grab }) => {
      const lane = laneOf(document.elementFromPoint(x, y));
      if (!lane?.dataset.lane) return null;
      const length = Math.max(visitMinutes(visit), SNAP_MINUTES);
      const minute = Math.min(Math.max(snap(minuteAt(y, lane) - grab), first), Math.max(first, Math.min(last, 1440) - length));
      return { visitId: visit.visitId, date, memberId: lane.dataset.lane, minute };
    },
    onDrop: (visit, from, to) => {
      const move = moveRequest(visit, from, to, timeZone);
      if (move) onMove?.(move);
    },
  });
  const ghost = target ?? (pending?.date === date ? pending : null);
  const ghostVisit = ghost ? visits.find((v) => v.visitId === ghost.visitId) : undefined;

  if (lanes.length === 0) return <p className="px-4 py-10 text-center text-[13px] text-ink-3">{copy.noCrew}</p>;
  return (
    <div aria-label={dayLabel(date, language, { weekday: "long", month: "long", day: "numeric" })} className="min-w-0 overflow-x-auto overflow-y-hidden" role="region">
      <div className={cn("grid w-full", dragging && "select-none")} style={grid}>
        <div className="sticky left-0 z-20 flex items-end justify-center border-b border-line bg-surface pb-2 text-ink-3">
          <Clock3 aria-hidden="true" className="size-3.5" />
        </div>
        {lanes.map(({ member, hours }) => (
          <div className="border-b border-l border-line px-3 py-2" key={member.memberId}>
            <p className="truncate text-[13px] font-medium text-ink">{member.name}</p>
            <p className="truncate text-[12px] text-ink-3 tabular-nums">
              {hours.length ? hours.map((h) => `${clockLabel(h.start, language)}–${clockLabel(h.end, language)}`).join(", ") : copy.outsideHours}
            </p>
          </div>
        ))}
        <div className="sticky left-0 z-10 bg-surface" style={{ height }}>
          {axis.map((minute) => (
            <span
              className="absolute right-2 -translate-y-1/2 text-[11px] whitespace-nowrap text-ink-3 tabular-nums first:translate-y-0"
              key={minute}
              style={{ top: top(minute) }}
            >
              {minute < 1440 ? clockLabel(minute, language) : ""}
            </span>
          ))}
        </div>
        {lanes.map(({ member, hours, entries }) => (
          <div className="relative border-l border-line bg-inset" data-lane={member.memberId} key={member.memberId} style={{ height }}>
            {hours.map((h) => (
              <div aria-hidden="true" className="absolute inset-x-0 bg-surface" key={h.start} style={span(h.start, h.end)} />
            ))}
            {axis.slice(1, -1).map((minute) => (
              <div aria-hidden="true" className="absolute inset-x-0 border-t border-line/70" key={minute} style={{ top: top(minute) }} />
            ))}
            {entries.map((entry) => {
              const style = {
                ...span(entry.start, entry.end),
                left: `calc(${(entry.lane / entry.lanes) * 100}% + 3px)`,
                width: `calc(${100 / entry.lanes}% - 6px)`,
              };
              if (entry.block) {
                const block = entry.block;
                return (
                  <button
                    className="absolute flex flex-col justify-start overflow-hidden rounded-[8px] bg-[repeating-linear-gradient(135deg,var(--color-inset),var(--color-inset)_6px,var(--color-line)_6px,var(--color-line)_7px)] px-2 py-1 text-left text-[12px] text-ink-2 shadow-hairline"
                    key={entry.id}
                    onClick={() => onTimeOff(block)}
                    style={style}
                    type="button"
                  >
                    <span className="flex items-center gap-1 font-medium">
                      <Moon aria-hidden="true" className="size-3" />
                      {copy.off}
                    </span>
                    {block.reason ? <span className="block truncate">{block.reason}</span> : null}
                  </button>
                );
              }
              const visit = entry.visit!;
              const short = entry.end - entry.start < 45;
              const canDrag = Boolean(onMove) && !entry.continuesBefore && draggable(visit, timeZone);
              const label = `${visit.title} · ${timeLabel(visit.startAt, timeZone, language)}–${timeLabel(visit.endAt, timeZone, language)} · ${copy.status[visit.status]}`;
              return (
                <button
                  aria-label={label}
                  aria-pressed={selectedId === visit.visitId}
                  className={cn(
                    "absolute flex flex-col items-stretch justify-start overflow-hidden rounded-[8px] px-2 py-1 text-left text-[12px] leading-tight shadow-hairline transition-[box-shadow,transform] outline-none hover:shadow-card focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.99]",
                    VISIT_TONES[visit.status],
                    selectedId === visit.visitId && "ring-2 ring-accent",
                    canDrag && DRAGGABLE,
                    ghost?.visitId === visit.visitId && "opacity-40",
                  )}
                  key={entry.id}
                  onClick={() => onVisit(visit)}
                  style={style}
                  title={label}
                  type="button"
                  {...(canDrag ? bind(visit, member.memberId) : {})}
                >
                  <span className="flex items-center gap-1 font-medium">
                    {visitIcon(visit.status)}
                    <span className="truncate">{visit.title}</span>
                  </span>
                  <span className={cn("block truncate tabular-nums opacity-80", short && "sr-only")}>
                    {rangeLabel(visit.startAt, visit.endAt, timeZone, language)}
                    {entry.clockChange ? " ·  ±1h" : ""}
                  </span>
                  {!short && visit.customerName ? <span className="block truncate opacity-70">{visit.customerName}</span> : null}
                  {!short && visit.checklist ? (
                    <span className="block truncate tabular-nums opacity-70">{copy.checklistDone(visit.checklist.done, visit.checklist.total)}</span>
                  ) : null}
                </button>
              );
            })}
            {ghost && ghostVisit && ghost.memberId === member.memberId ? (
              <Ghost
                className="absolute inset-x-[3px] z-20"
                end={ghost.minute + visitMinutes(ghostVisit)}
                language={language}
                start={ghost.minute}
                style={span(ghost.minute, ghost.minute + visitMinutes(ghostVisit))}
                visit={ghostVisit}
              />
            ) : null}
            {date === today && nowMinute >= first && nowMinute < last ? (
              <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red" style={{ top: top(nowMinute) }}>
                <span className="absolute -top-[5px] -left-[5px] size-2 rounded-full bg-red" />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A week: a row per crew member, a column per day, each visit a card under its day. */
export function WeekBoard({ dates, ...shared }: Shared & { dates: string[] }) {
  const { timeZone, today, language, crew, visits, timeOff, selectedId, onVisit, onTimeOff, onMove, pending } = shared;
  const copy = pageCopyFor(language).schedule;
  // The names column narrows on a phone, so more of the week shows beside it.
  const grid: CSSProperties = { gridTemplateColumns: `var(--names) repeat(${dates.length}, minmax(0, 1fr))`, minWidth: `calc(var(--names) + ${dates.length * 7.25}rem)` };
  // Dragging keeps the visit's time of day: it moves to the day and person under the pointer.
  const { target, dragging, bind } = useVisitDrag({
    enabled: Boolean(onMove),
    locate: (x, y, { visit }) => {
      const cell = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-cell]");
      const { date, member } = cell?.dataset ?? {};
      if (!date || !member) return null;
      return { visitId: visit.visitId, date, memberId: member, minute: clockMinutes(localDateTime(visit.startAt, timeZone).slice(11)) };
    },
    onDrop: (visit, from, to) => {
      const move = moveRequest(visit, from, to, timeZone);
      if (move) onMove?.(move);
    },
  });
  const ghost = target ?? pending ?? null;
  const ghostVisit = ghost ? visits.find((v) => v.visitId === ghost.visitId) : undefined;
  if (crew.length === 0) return <p className="px-4 py-10 text-center text-[13px] text-ink-3">{copy.noCrew}</p>;
  return (
    <div aria-label={copy.week} className="min-w-0 overflow-x-auto" role="region">
      <div className={cn("grid w-full [--names:6.5rem] sm:[--names:9rem]", dragging && "select-none")} style={grid}>
        <div className="sticky left-0 z-10 border-b border-line bg-surface" />
        {dates.map((date) => (
          <div className={cn("border-b border-l border-line px-3 py-2", date === today && "bg-accent-tint/60")} key={date}>
            <p className={cn("text-[12px] text-ink-3", date === today && "text-accent-ink")}>{dayLabel(date, language, { weekday: "short" })}</p>
            <p className={cn("text-[15px] font-semibold tabular-nums text-ink", date === today && "text-accent-ink")}>{dayLabel(date, language, { day: "numeric" })}</p>
          </div>
        ))}
        {crew.map((member) => (
          <div className="contents" key={member.memberId}>
            <div className="sticky left-0 z-10 border-b border-line bg-surface px-3 py-2.5">
              <p className="truncate text-[13px] font-medium text-ink">{member.name}</p>
              <p className="text-[12px] text-ink-3">{pageCopyFor(language).team.roles[member.role]}</p>
            </div>
            {dates.map((date) => {
              const working = workingSegments(date, member.hours).length > 0;
              const cards = [
                ...timeOff
                  .filter((b) => (!b.memberId || b.memberId === member.memberId) && calendarDaySegment(b.startAt, b.endAt, date, timeZone))
                  .map((block) => ({ key: `off:${block.id}`, at: block.startAt, block, visit: undefined })),
                ...visits
                  .filter((v) => v.crew.some((c) => c.memberId === member.memberId) && calendarDaySegment(v.startAt, v.endAt, date, timeZone))
                  .map((visit) => ({ key: visit.visitId, at: visit.startAt, block: undefined, visit })),
              ].sort((a, b) => a.at.localeCompare(b.at));
              const dropHere = ghost && ghostVisit && ghost.date === date && ghost.memberId === member.memberId;
              return (
                <div
                  className={cn(
                    "min-h-24 space-y-1.5 border-b border-l border-line p-1.5",
                    working ? "bg-surface" : "bg-inset",
                    dropHere && "bg-accent-tint/40 ring-2 ring-accent ring-inset",
                  )}
                  data-cell=""
                  data-date={date}
                  data-member={member.memberId}
                  key={date}
                >
                  {dropHere ? (
                    <Ghost end={ghost.minute + visitMinutes(ghostVisit)} language={language} start={ghost.minute} visit={ghostVisit} />
                  ) : null}
                  {cards.map(({ key, block, visit }) =>
                    block ? (
                      <button
                        className="block w-full rounded-[8px] bg-[repeating-linear-gradient(135deg,var(--color-inset),var(--color-inset)_6px,var(--color-line)_6px,var(--color-line)_7px)] px-2 py-1 text-left text-[12px] text-ink-2 shadow-hairline"
                        key={key}
                        onClick={() => onTimeOff(block)}
                        type="button"
                      >
                        <span className="flex items-center gap-1 font-medium">
                          <Moon aria-hidden="true" className="size-3" />
                          {copy.off}
                        </span>
                        {block.reason ? <span className="block truncate">{block.reason}</span> : null}
                      </button>
                    ) : (
                      <button
                        aria-pressed={selectedId === visit!.visitId}
                        className={cn(
                          "block w-full rounded-[8px] px-2 py-1 text-left text-[12px] leading-tight shadow-hairline transition-shadow outline-none hover:shadow-card focus-visible:ring-3 focus-visible:ring-ring/50",
                          VISIT_TONES[visit!.status],
                          selectedId === visit!.visitId && "ring-2 ring-accent",
                          onMove && draggable(visit!, timeZone) && DRAGGABLE,
                          ghost?.visitId === visit!.visitId && "opacity-40",
                        )}
                        key={key}
                        onClick={() => onVisit(visit!)}
                        title={`${visit!.title} · ${copy.status[visit!.status]}`}
                        type="button"
                        {...(onMove && draggable(visit!, timeZone) && localDateTime(visit!.startAt, timeZone).slice(0, 10) === date ? bind(visit!, member.memberId) : {})}
                      >
                        <span className="block truncate tabular-nums opacity-80">{rangeLabel(visit!.startAt, visit!.endAt, timeZone, language)}</span>
                        <span className="flex items-center gap-1 font-medium">
                          {visitIcon(visit!.status)}
                          <span className="truncate">{visit!.title}</span>
                        </span>
                      </button>
                    ),
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
