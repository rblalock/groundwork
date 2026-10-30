"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/ui/components/dialog";
import { cn } from "@/ui/lib/utils";
import type { Language } from "@/core/language";
import type { WorkingInterval } from "@/core/scheduling-time";
import { pageCopyFor } from "@/lib/page-copy";
import type { CrewJson, SlotJson, ToScheduleJson, VisitJson } from "@/lib/pages/schedule";
import { localDateTime } from "@/lib/schedule-presentation";
import { ErrorLine, Field, NativeSelect, inputClass } from "../pages/client-kit";
import { dayLabel } from "./calendar";

// The Schedule page's forms. Each sends one change to a route handler, which applies the same rules
// as the assistant's tools, then refreshes the page's server data.

type Result<T> = { ok: true; data: T } | { ok: false; code?: string; error: string };

/** One request to the schedule's routes; the error is the route's words, already in the member's language. */
export function useScheduleRequest(fallback: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();
  async function send<T>(url: string, method: string, body?: unknown, refresh = true): Promise<Result<T>> {
    setBusy(true);
    try {
      const response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await response.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
      if (!response.ok) return { ok: false, code: data?.code, error: data?.error ?? fallback };
      if (refresh) startTransition(() => router.refresh());
      return { ok: true, data: data as T };
    } catch {
      return { ok: false, error: fallback };
    } finally {
      setBusy(false);
    }
  }
  return { send, busy };
}

const DURATIONS = [30, 45, 60, 90, 120, 180, 240, 360, 480];

/** Who goes: a toggle per crew member. */
function CrewPicker({ crew, value, onChange, label }: { crew: CrewJson[]; value: string[]; onChange: (ids: string[]) => void; label: string }) {
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1.5 text-[13px] font-medium">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {crew.map((member) => {
          const on = value.includes(member.memberId);
          return (
            <button
              aria-pressed={on}
              className={cn(
                "h-7 rounded-full px-3 text-[13px] shadow-hairline transition-colors",
                on ? "bg-ink text-canvas" : "bg-surface text-ink hover:bg-hover",
              )}
              key={member.memberId}
              onClick={() => onChange(on ? value.filter((id) => id !== member.memberId) : [...value, member.memberId])}
              type="button"
            >
              {member.name}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export type VisitFormTarget =
  | { kind: "book"; work?: string }
  | { kind: "move"; visit: VisitJson };

/**
 * Book a visit (for won or approved work, more visits on open work, or new work) or move one. "Find
 * open times" asks the server for times everyone picked is free; booking checks again. A time outside
 * working hours is refused with the chance to book it anyway.
 */
export function VisitForm({
  target,
  crew,
  toSchedule,
  timeZone,
  defaultDate,
  language,
  onDone,
}: {
  target: VisitFormTarget;
  crew: CrewJson[];
  toSchedule: ToScheduleJson[];
  timeZone: string;
  defaultDate: string;
  language: Language;
  onDone: (visit: VisitJson | null) => void;
}) {
  const copy = pageCopyFor(language);
  const f = copy.schedule.form;
  const { send, busy } = useScheduleRequest(copy.common.failed);
  const moving = target.kind === "move" ? target.visit : null;
  const [work, setWork] = useState(target.kind === "book" ? (target.work ?? toScheduleKey(toSchedule[0]) ?? "new") : "");
  const [title, setTitle] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>(moving ? moving.crew.map((c) => c.memberId) : crew.length === 1 ? [crew[0].memberId] : []);
  const [date, setDate] = useState(moving ? localDateTime(moving.startAt, timeZone).slice(0, 10) : defaultDate);
  const [time, setTime] = useState(moving ? localDateTime(moving.startAt, timeZone).slice(11) : "09:00");
  const [duration, setDuration] = useState(moving ? Math.round((Date.parse(moving.endAt) - Date.parse(moving.startAt)) / 60_000) : 60);
  const [notes, setNotes] = useState(moving?.notes ?? "");
  const [tentative, setTentative] = useState(false);
  const [error, setError] = useState<string>();
  const [outside, setOutside] = useState(false);
  const [slots, setSlots] = useState<SlotJson[] | null>(null);
  const durations = DURATIONS.includes(duration) ? DURATIONS : [...DURATIONS, duration].sort((a, b) => a - b);

  async function findTimes() {
    setError(undefined);
    // The work's place sets the drive held around each time.
    const [kind, id] = work.split(":");
    const about = moving ? { visitId: moving.visitId } : kind === "quote" ? { quoteId: id } : kind === "job" ? { jobId: id } : {};
    const result = await send<{ slots: SlotJson[] }>(
      "/api/schedule/availability",
      "POST",
      { memberIds, date, days: 5, durationMinutes: duration, ...about },
      false,
    );
    if (result.ok) setSlots(result.data.slots);
    else setError(result.error);
  }

  async function submit(event: FormEvent, allowOutsideHours = false) {
    event.preventDefault();
    setError(undefined);
    setOutside(false);
    const [kind, id] = work.split(":");
    const body = moving
      ? { date, time, durationMinutes: duration, memberIds, notes, ...(allowOutsideHours ? { allowOutsideHours } : {}) }
      : {
          ...(kind === "quote" ? { quoteId: id } : kind === "job" ? { jobId: id } : { title: title.trim() || undefined }),
          memberIds,
          date,
          time,
          durationMinutes: duration,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(tentative ? { tentative } : {}),
          ...(allowOutsideHours ? { allowOutsideHours } : {}),
        };
    const result = await send<{ visit: VisitJson }>(moving ? `/api/schedule/visits/${moving.visitId}` : "/api/schedule/visits", moving ? "PATCH" : "POST", body);
    if (result.ok) return onDone(result.data.visit);
    setError(result.error);
    setOutside(result.code === "OUTSIDE_HOURS");
  }

  // A week of slots reads better grouped by day, a few per day.
  const byDay = new Map<string, SlotJson[]>();
  for (const slot of slots ?? []) byDay.set(slot.date, [...(byDay.get(slot.date) ?? []), slot]);

  return (
    <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
      <DialogTitle>{moving ? f.moveTitle : f.bookTitle}</DialogTitle>
      {moving ? (
        <DialogDescription>{moving.title}</DialogDescription>
      ) : (
        <div className="grid gap-3">
          <Field id="work" label={f.work}>
            <NativeSelect id="work" onChange={(event) => setWork(event.target.value)} value={work}>
              {toSchedule.map((item) => (
                <option key={toScheduleKey(item)} value={toScheduleKey(item)}>
                  {item.title}
                  {item.customerName ? ` · ${item.customerName}` : ""}
                </option>
              ))}
              {target.kind === "book" && target.work && !toSchedule.some((item) => toScheduleKey(item) === target.work) ? (
                <option value={target.work}>{f.work}</option>
              ) : null}
              <option value="new">{f.newWork}</option>
            </NativeSelect>
          </Field>
          {work === "new" ? (
            <Field id="title" label={f.workTitle} onChange={(event) => setTitle(event.target.value)} placeholder={f.workTitlePlaceholder} required value={title} />
          ) : null}
        </div>
      )}
      <CrewPicker crew={crew} label={f.crew} onChange={setMemberIds} value={memberIds} />
      <div className="grid grid-cols-[1fr_7rem] gap-3 sm:grid-cols-[1fr_7rem_8rem]">
        <Field id="date" label={f.date} onChange={(event) => setDate(event.target.value)} required type="date" value={date} />
        <Field id="time" label={f.time} onChange={(event) => setTime(event.target.value)} required step={900} type="time" value={time} />
        <Field className="col-span-2 sm:col-span-1" id="duration" label={f.duration}>
          <NativeSelect id="duration" onChange={(event) => setDuration(Number(event.target.value))} value={duration}>
            {durations.map((minutes) => (
              <option key={minutes} value={minutes}>
                {f.minutes(minutes)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <div className="grid gap-2">
        <div>
          <Button disabled={busy || memberIds.length === 0} onClick={() => void findTimes()} size="sm" type="button" variant="ghost">
            {busy && slots === null ? f.finding : f.findTime}
          </Button>
        </div>
        {slots !== null ? (
          slots.length === 0 ? (
            <p className="text-[12px] text-ink-3">{f.noTimes}</p>
          ) : (
            <div aria-label={f.pickTime} className="grid max-h-40 gap-2 overflow-y-auto rounded-[10px] bg-inset p-2" role="group">
              {[...byDay.entries()].map(([day, list]) => (
                <div className="flex flex-wrap items-center gap-1.5" key={day}>
                  <span className="w-20 shrink-0 text-[12px] text-ink-2">{dayLabel(day, language)}</span>
                  {spread(list).map((slot) => (
                    <button
                      aria-pressed={date === slot.date && time === slot.start}
                      className={cn(
                        "h-6 rounded-full px-2 text-[12px] tabular-nums shadow-hairline",
                        date === slot.date && time === slot.start ? "bg-ink text-canvas" : "bg-surface hover:bg-hover",
                      )}
                      key={slot.start}
                      onClick={() => {
                        setDate(slot.date);
                        setTime(slot.start);
                      }}
                      type="button"
                    >
                      {slot.start}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )
        ) : null}
      </div>
      <Field id="notes" label={f.notes}>
        <textarea className={cn(inputClass, "h-16 py-1.5")} id="notes" onChange={(event) => setNotes(event.target.value)} value={notes} />
      </Field>
      {!moving ? (
        <label className="flex items-center gap-2 text-[13px]">
          <input checked={tentative} className="size-4 accent-[var(--color-accent)]" onChange={(event) => setTentative(event.target.checked)} type="checkbox" />
          {f.tentative}
        </label>
      ) : null}
      <ErrorLine>{error}</ErrorLine>
      {outside ? (
        <div>
          <Button disabled={busy} onClick={(event) => void submit(event, true)} size="sm" type="button">
            {f.bookAnyway}
          </Button>
        </div>
      ) : null}
      <p className="text-[12px] text-ink-3">{f.crewTexted}</p>
      <DialogFooter>
        <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
        <Button disabled={busy || memberIds.length === 0} size="sm" type="submit" variant="primary">
          {busy ? f.saving : moving ? f.submitMove : f.submitBook}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A day's open times, on the hour where there are many, so a whole day shows instead of its first two hours. */
function spread(list: SlotJson[]): SlotJson[] {
  const hourly = list.filter((slot) => slot.start.endsWith(":00"));
  return (list.length > 10 && hourly.length ? hourly : list).slice(0, 10);
}

export function toScheduleKey(item: ToScheduleJson | undefined): string | undefined {
  if (!item) return undefined;
  return item.kind === "quote" ? `quote:${item.quoteId}` : `job:${item.jobId}`;
}

/** Time off: crew add their own; owners and admins anyone's, or the whole business's. */
export function TimeOffForm({
  crew,
  me,
  canManage,
  defaultDate,
  language,
  onDone,
}: {
  crew: CrewJson[];
  me: string | null;
  canManage: boolean;
  defaultDate: string;
  language: Language;
  onDone: () => void;
}) {
  const copy = pageCopyFor(language);
  const f = copy.schedule.form;
  const { send, busy } = useScheduleRequest(copy.common.failed);
  const [who, setWho] = useState(canManage ? (crew[0]?.memberId ?? "") : (me ?? ""));
  const [date, setDate] = useState(defaultDate);
  const [endDate, setEndDate] = useState(defaultDate);
  const [allDay, setAllDay] = useState(true);
  const [start, setStart] = useState("12:00");
  const [end, setEnd] = useState("17:00");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await send("/api/schedule/time-off", "POST", {
      memberId: who === "business" ? null : who,
      date,
      ...(endDate && endDate !== date ? { endDate } : {}),
      ...(allDay ? {} : { start, end }),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
    if (result.ok) onDone();
    else setError(result.error);
  }

  return (
    <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
      <DialogTitle>{f.timeOffTitle}</DialogTitle>
      {canManage ? (
        <Field id="who" label={f.who}>
          <NativeSelect id="who" onChange={(event) => setWho(event.target.value)} value={who}>
            {crew.map((member) => (
              <option key={member.memberId} value={member.memberId}>
                {member.name}
              </option>
            ))}
            <option value="business">{copy.schedule.wholeBusiness}</option>
          </NativeSelect>
        </Field>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Field id="off-from" label={f.from} onChange={(event) => setDate(event.target.value)} required type="date" value={date} />
        <Field id="off-to" label={f.to} min={date} onChange={(event) => setEndDate(event.target.value)} type="date" value={endDate} />
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <input checked={allDay} className="size-4 accent-[var(--color-accent)]" onChange={(event) => setAllDay(event.target.checked)} type="checkbox" />
        {f.allDay}
      </label>
      {!allDay ? (
        <div className="grid grid-cols-2 gap-3">
          <Field id="off-start" label={f.start} onChange={(event) => setStart(event.target.value)} step={900} type="time" value={start} />
          <Field id="off-end" label={f.end} onChange={(event) => setEnd(event.target.value)} step={900} type="time" value={end} />
        </div>
      ) : null}
      <Field id="off-reason" label={f.reason} maxLength={200} onChange={(event) => setReason(event.target.value)} value={reason} />
      <ErrorLine>{error}</ErrorLine>
      <DialogFooter>
        <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
        <Button disabled={busy || !who} size="sm" type="submit" variant="primary">
          {busy ? f.saving : f.submitTimeOff}
        </Button>
      </DialogFooter>
    </form>
  );
}

type DayHours = { on: boolean; start: string; end: string };

/** One stretch a day, the way most businesses say their hours. A day with several keeps its first start and last end. */
function toDays(hours: WorkingInterval[]): DayHours[] {
  return Array.from({ length: 7 }, (_, day) => {
    const today = hours.filter((h) => h.day === day).sort((a, b) => a.start.localeCompare(b.start));
    return today.length ? { on: true, start: today[0].start, end: today.at(-1)!.end } : { on: false, start: "08:00", end: "17:00" };
  });
}

const fromDays = (days: DayHours[]): WorkingInterval[] => days.flatMap((d, day) => (d.on ? [{ day, start: d.start, end: d.end }] : []));

/** The business's working hours, or one member's own. Owners and admins. */
export function HoursForm({ language, onDone }: { language: Language; onDone: () => void }) {
  const copy = pageCopyFor(language);
  const f = copy.schedule.form;
  const { send, busy } = useScheduleRequest(copy.common.failed);
  const [data, setData] = useState<{ business: WorkingInterval[]; crew: CrewJson[] } | null>(null);
  const [who, setWho] = useState("business");
  const [own, setOwn] = useState(true);
  const [days, setDays] = useState<DayHours[]>(toDays([]));
  const [error, setError] = useState<string>();

  useEffect(() => {
    void send<{ business: WorkingInterval[]; crew: CrewJson[] }>("/api/schedule/hours", "GET", undefined, false).then((result) => {
      if (!result.ok) return setError(result.error);
      setData(result.data);
      setDays(toDays(result.data.business));
    });
    // Loads once, when the dialog opens.
  }, []);

  function pick(value: string) {
    setWho(value);
    if (!data) return;
    const member = data.crew.find((c) => c.memberId === value);
    setOwn(member ? member.ownHours : true);
    setDays(toDays(member ? member.hours : data.business));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await send("/api/schedule/hours", "PUT", {
      memberId: who === "business" ? null : who,
      hours: who !== "business" && !own ? null : fromDays(days),
    });
    if (result.ok) onDone();
    else setError(result.error);
  }

  return (
    <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
      <DialogTitle>{f.hoursTitle}</DialogTitle>
      <DialogDescription>{f.hoursIntro}</DialogDescription>
      <Field id="hours-for" label={f.hoursFor}>
        <NativeSelect disabled={!data} id="hours-for" onChange={(event) => pick(event.target.value)} value={who}>
          <option value="business">{f.businessHours}</option>
          {data?.crew.map((member) => (
            <option key={member.memberId} value={member.memberId}>
              {member.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {who !== "business" ? (
        <label className="flex items-center gap-2 text-[13px]">
          <input
            checked={!own}
            className="size-4 accent-[var(--color-accent)]"
            onChange={(event) => {
              setOwn(!event.target.checked);
              if (event.target.checked && data) setDays(toDays(data.business));
            }}
            type="checkbox"
          />
          {f.useBusiness}
        </label>
      ) : null}
      <div className={cn("grid gap-1.5", who !== "business" && !own && "pointer-events-none opacity-50")}>
        {days.map((day, index) => (
          <div className="grid grid-cols-[4.5rem_1fr_1fr] items-center gap-2" key={copy.schedule.weekdays[index]}>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                checked={day.on}
                className="size-4 accent-[var(--color-accent)]"
                onChange={(event) => setDays(days.map((d, i) => (i === index ? { ...d, on: event.target.checked } : d)))}
                type="checkbox"
              />
              {copy.schedule.weekdays[index]}
            </label>
            {day.on ? (
              <>
                <input
                  aria-label={`${copy.schedule.weekdays[index]} ${f.start}`}
                  className={inputClass}
                  onChange={(event) => setDays(days.map((d, i) => (i === index ? { ...d, start: event.target.value } : d)))}
                  step={900}
                  type="time"
                  value={day.start}
                />
                <input
                  aria-label={`${copy.schedule.weekdays[index]} ${f.end}`}
                  className={inputClass}
                  onChange={(event) => setDays(days.map((d, i) => (i === index ? { ...d, end: event.target.value } : d)))}
                  step={900}
                  type="time"
                  value={day.end}
                />
              </>
            ) : (
              <span className="col-span-2 text-[13px] text-ink-3">{f.closed}</span>
            )}
          </div>
        ))}
      </div>
      <ErrorLine>{error}</ErrorLine>
      <DialogFooter>
        <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
        <Button disabled={busy || !data} size="sm" type="submit" variant="primary">
          {busy ? f.saving : f.submitHours}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A dialog that holds one of the forms; wide enough for the visit form. */
export function FormDialog({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: React.ReactNode }) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg" showCloseButton={false}>
        {children}
      </DialogContent>
    </Dialog>
  );
}
