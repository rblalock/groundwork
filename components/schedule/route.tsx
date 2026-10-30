"use client";

import { AlertTriangle, Check, CloudSun, Home, MapPin, Truck } from "lucide-react";
import type { ReactNode } from "react";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import { cn } from "@/ui/lib/utils";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import type { DayPlanJson, VisitJson } from "@/lib/pages/schedule";
import { durationText } from "@/core/scheduling-time";
import { timeLabel } from "./calendar";

// The Schedule page's route view: each crew member's day as a list, from the yard and back, with the drive
// into each stop and the day's load against the business's capacity. Today's re-planned day shows when the
// crew got on site, the projected times of the stops they'd reach late, and whether the day is at risk. Above the
// routes, the day's weather in one line when the forecast reaches it. It only draws what the server worked out
// (`core/day-plan.ts`, `core/weather.ts`); nothing here changes a visit. A row opens
// the visit's details.

const STATUS_TONE = { proposed: "orange", scheduled: "accent", completed: "green", cancelled: "neutral" } as const;

export function RouteBoard({
  plans,
  visits,
  timeZone,
  language,
  selectedId,
  onVisit,
  weather,
}: {
  plans: DayPlanJson[];
  visits: VisitJson[];
  timeZone: string;
  language: Language;
  selectedId: string | null;
  onVisit: (visit: VisitJson) => void;
  /** The day's weather in one line; null when the forecast doesn't reach it. */
  weather: string | null;
}) {
  const s = pageCopyFor(language).schedule;
  return (
    <div className="divide-y divide-line">
      {weather ? (
        <p className="flex items-center gap-1.5 px-4 py-2 text-[12px] text-ink-2">
          <CloudSun aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
          <span className="sr-only">{s.routes.weather}: </span>
          {weather}
        </p>
      ) : null}
      {plans.length === 0 ? <p className="px-4 py-3 text-[13px] text-ink-3">{s.routes.empty}</p> : null}
      {plans.map((plan) => (
        <RouteCard key={plan.memberId} language={language} onVisit={onVisit} plan={plan} selectedId={selectedId} timeZone={timeZone} visits={visits} />
      ))}
    </div>
  );
}

function RouteCard({
  plan,
  visits,
  timeZone,
  language,
  selectedId,
  onVisit,
}: {
  plan: DayPlanJson;
  visits: VisitJson[];
  timeZone: string;
  language: Language;
  selectedId: string | null;
  onVisit: (visit: VisitJson) => void;
}) {
  const s = pageCopyFor(language).schedule;
  const r = s.routes;
  const time = (at: string) => timeLabel(at, timeZone, language);
  const percent = (bp: number) => Math.round(bp / 100);
  return (
    <section aria-label={plan.name} className="px-4 py-3">
      <h3 className="mb-2 text-[13px] font-semibold text-ink">{plan.name}</h3>
      <ol className="space-y-px">
        {plan.leaveYardAt ? (
          <YardRow icon={<Home className="size-3.5" />} label={r.leave} time={time(plan.leaveYardAt)} />
        ) : null}
        {plan.stops.map((stop) => {
          const visit = visits.find((v) => v.visitId === stop.visitId);
          const done = stop.status === "completed";
          // Re-planned, a stop under way says since when and, running over, about when it'll be done; one ahead
          // they'd reach late says about when they get there.
          const underWay = plan.replan && stop.startedAt && !done;
          const ahead = plan.replan && !stop.startedAt && !done && stop.lateMinutes > 0;
          return (
            <li key={stop.visitId}>
              <button
                className={cn(
                  "grid w-full grid-cols-[4.5rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-[10px] px-2 py-2 text-left hover:bg-hover",
                  selectedId === stop.visitId && "bg-accent-tint hover:bg-accent-tint",
                )}
                disabled={!visit}
                onClick={() => visit && onVisit(visit)}
                type="button"
              >
                <span className="pt-px text-[13px] text-ink tabular-nums">{time(stop.startAt)}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-ink">{stop.title}</span>
                  {stop.address && stop.address !== stop.title ? <span className="block truncate text-[12px] text-ink-3">{stop.address}</span> : null}
                  <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-ink-3">
                    {stop.legIn ? (
                      <span className="inline-flex items-center gap-1 tabular-nums">
                        <Truck aria-hidden="true" className="size-3" />
                        {r.drive(stop.legIn.minutes)}
                      </span>
                    ) : !stop.place ? (
                      <span className="inline-flex items-center gap-1 text-orange">
                        <MapPin aria-hidden="true" className="size-3" />
                        {r.noDrive}
                      </span>
                    ) : null}
                    {stop.checklist ? (
                      <span className="inline-flex items-center gap-1 tabular-nums">
                        <Check aria-hidden="true" className="size-3" />
                        {s.checklistDone(stop.checklist.done, stop.checklist.total)}
                      </span>
                    ) : null}
                    {underWay && stop.startedAt ? (
                      <span className="tabular-nums">
                        {r.onSite(time(stop.startedAt))}
                        {Date.parse(stop.plannedLeaveAt) > Date.parse(stop.endAt) ? <span className="text-orange"> · {r.ends(time(stop.plannedLeaveAt))}</span> : null}
                      </span>
                    ) : null}
                    {ahead ? <span className="text-orange tabular-nums">{r.arrives(time(stop.plannedArriveAt))}</span> : null}
                    {stop.lateMinutes > 0 && !underWay && !done ? <span className="text-orange tabular-nums">{r.late(stop.lateMinutes)}</span> : null}
                  </span>
                </span>
                <StatusPill className="shrink-0" dot tone={STATUS_TONE[stop.status]}>
                  {s.status[stop.status]}
                </StatusPill>
              </button>
            </li>
          );
        })}
        {plan.backAtYardAt && plan.legOut ? (
          <YardRow
            detail={r.drive(plan.legOut.minutes)}
            icon={<Home className="size-3.5" />}
            label={plan.replan && plan.replan.shiftMinutes !== 0 ? r.backProjected : r.back}
            time={time(plan.backAtYardAt)}
          />
        ) : null}
      </ol>
      <p className={cn("mt-2 px-2 text-[12px] tabular-nums", plan.overCapacity ? "font-medium text-orange" : "text-ink-2")}>
        {r.summary(durationText(plan.driveMinutes, language), durationText(plan.workMinutes, language))} · {plan.load === null ? r.noHours : r.load(percent(plan.load))}
        {plan.overCapacity ? ` · ${r.over(percent(plan.capacityBp))}` : ""}
      </p>
      {plan.atRisk && plan.replan?.dayEndAt ? (
        <p className="mt-1 flex items-center gap-1.5 px-2 text-[12px] font-medium text-orange tabular-nums" role="status">
          <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
          {r.atRisk(time(plan.backAtYardAt ?? plan.stops[plan.stops.length - 1].plannedLeaveAt), time(plan.replan.dayEndAt))}
        </p>
      ) : null}
      {plan.suggestedOrder && plan.savedDriveMinutes ? (
        <p className="mt-1 px-2 text-[12px] text-ink-3">{r.shorter(plan.suggestedOrder.map((o) => o.title).join(" → "), plan.savedDriveMinutes)}</p>
      ) : null}
      {!plan.yardPlaced ? <p className="mt-1 px-2 text-[12px] text-ink-3">{r.unplacedYard}</p> : null}
    </section>
  );
}

function YardRow({ icon, label, time, detail }: { icon: ReactNode; label: string; time: string; detail?: string }) {
  return (
    <li className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 px-2 py-1.5 text-[13px] text-ink-2">
      <span className="tabular-nums">{time}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden="true" className="text-ink-3">
          {icon}
        </span>
        {label}
        {detail ? <span className="text-[12px] text-ink-3 tabular-nums">({detail})</span> : null}
      </span>
    </li>
  );
}
