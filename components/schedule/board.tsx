"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, MapPin, Moon, Plus, User, Users, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import { SegmentedControl } from "@/ui/beautiful/atoms/SegmentedControl";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import { DialogClose, DialogDescription, DialogFooter, DialogTitle } from "@/ui/components/dialog";
import { cn } from "@/ui/lib/utils";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import type { SchedulePage, TimeOffJson, ToScheduleJson, VisitJson } from "@/lib/pages/schedule";
import { localDateTime, shiftDate } from "@/lib/schedule-presentation";
import { ErrorLine, inputClass } from "../pages/client-kit";
import { DayGrid, WeekBoard, clockLabel, dayLabel, timeLabel } from "./calendar";
import type { MoveRequest } from "./drag";
import { FormDialog, HoursForm, TimeOffForm, VisitForm, toScheduleKey, useScheduleRequest, type VisitFormTarget } from "./forms";
import { CreateInvoiceButton } from "../invoices/actions";
import { InvoiceStatusPill } from "../invoices/kit";
import type { InvoiceStatus } from "@/core/invoices";

const PANEL =
  "absolute top-3 right-3 z-30 max-h-[calc(100%-1.5rem)] w-80 max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-card bg-surface p-4 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.35)] ring-1 ring-line outline-none focus-visible:outline-none focus-visible:ring-line";

const SIDE_PANEL = "rounded-card bg-surface p-4 shadow-card outline-none focus-visible:outline-none";

const STATUS_TONE = { proposed: "orange", scheduled: "accent", completed: "green", cancelled: "neutral" } as const;

type Dialogs =
  | { kind: "visit"; target: VisitFormTarget }
  | { kind: "timeOff" }
  | { kind: "hours" }
  | { kind: "cancel"; visit: VisitJson }
  | { kind: "done"; visit: VisitJson }
  | { kind: "close"; visit: VisitJson }
  | null;

/**
 * The Schedule page: a day (crew lanes on a time grid) or a week (a row per crew member), work waiting
 * to be booked, and a visit's details beside the calendar. Owners and admins book, move, and cancel
 * here; crew see their own lane and mark their visits done. The view, day, and open visit live in the
 * URL, so a link opens the same thing.
 */
export function ScheduleBoard({
  page,
  language,
  selectedId,
  bookTarget,
}: {
  page: SchedulePage;
  language: Language;
  selectedId: string | null;
  /** From a quote's page: open the booking form for its work. */
  bookTarget: { key: string; label: string } | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const copy = pageCopyFor(language);
  const s = copy.schedule;
  const [dialog, setDialog] = useState<Dialogs>(bookTarget && page.canManage ? { kind: "visit", target: { kind: "book", work: bookTarget.key } } : null);
  const [timeOff, setTimeOff] = useState<TimeOffJson | null>(null);
  const selected = page.visits.find((v) => v.visitId === selectedId) ?? null;
  const panelRef = useRef<HTMLElement>(null);
  const [move, setMove] = useState<MoveRequest | null>(null);
  // The schedule as it was when a move saved: the ghost goes once the refreshed one comes in.
  const [movedFrom, setMovedFrom] = useState<VisitJson[] | null>(null);
  // A refused move puts the visit back while the toast says why.
  const [refused, setRefused] = useState(false);
  const closeMove = () => {
    setMove(null);
    setMovedFrom(null);
    setRefused(false);
  };

  const go = (next: Record<string, string | null>, mode: "push" | "replace" = "push") => {
    const query = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null) query.delete(key);
      else query.set(key, value);
    }
    const href = query.toString() ? `${pathname}?${query}` : pathname;
    if (mode === "replace") router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  };
  const select = (visit: VisitJson | null) => {
    setTimeOff(null);
    go({ visit: visit?.visitId ?? null }, "replace");
  };

  useEffect(() => {
    if (selected || timeOff) panelRef.current?.focus();
  }, [selected?.visitId, timeOff?.id]);

  const step = page.view === "day" ? 1 : 7;
  const heading =
    page.view === "day"
      ? dayLabel(page.date, language, { weekday: "long", month: "long", day: "numeric" })
      : `${dayLabel(page.dates[0], language, { month: "short", day: "numeric" })} – ${dayLabel(page.dates.at(-1)!, language, { month: "short", day: "numeric" })}`;
  const bookingDay = page.date < page.today ? page.today : page.date;
  const closeDialog = () => setDialog(null);
  const workLabel = bookTarget && !page.toSchedule.some((t) => toScheduleKey(t) === bookTarget.key) ? bookTarget : null;
  const empty = page.visits.length === 0;
  const shared = {
    timeZone: page.timeZone,
    today: page.today,
    language,
    crew: page.crew,
    visits: page.visits,
    timeOff: page.timeOff,
    selectedId,
    onVisit: (visit: VisitJson) => select(visit),
    onTimeOff: (block: TimeOffJson) => {
      go({ visit: null }, "replace");
      setTimeOff(block);
    },
    // Owners and admins drag visits; the toast below confirms each move.
    onMove: page.canManage
      ? (next: MoveRequest) => {
          closeMove();
          setMove(next);
        }
      : undefined,
    pending: move && !refused && !(movedFrom && movedFrom !== page.visits) ? move : null,
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          onChange={(view) => go({ view: view === s.day ? "day" : "week", visit: null })}
          options={[s.day, s.week] as const}
          value={page.view === "day" ? s.day : s.week}
        />
        <div className="flex items-center gap-1">
          <Button onClick={() => go({ date: page.today, visit: null })} size="sm">
            {s.today}
          </Button>
          <Button aria-label={page.view === "day" ? s.previousDay : s.previousWeek} onClick={() => go({ date: shiftDate(page.date, -step), visit: null })} size="sm" variant="quiet">
            <ChevronLeft aria-hidden="true" className="size-4" />
          </Button>
          <Button aria-label={page.view === "day" ? s.nextDay : s.nextWeek} onClick={() => go({ date: shiftDate(page.date, step), visit: null })} size="sm" variant="quiet">
            <ChevronRight aria-hidden="true" className="size-4" />
          </Button>
          <label className="relative flex size-[27px] cursor-pointer items-center justify-center rounded-full text-ink hover:bg-hover" title={s.pickDate}>
            <CalendarDays aria-hidden="true" className="size-4" />
            <input
              aria-label={s.pickDate}
              className="absolute inset-0 cursor-pointer opacity-0"
              onChange={(event) => event.target.value && go({ date: event.target.value, visit: null })}
              type="date"
              value={page.date}
            />
          </label>
        </div>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink max-sm:order-first max-sm:basis-full">
          {heading}
          <span className="ml-2 text-[12px] font-normal text-ink-3">{page.timeZone.replaceAll("_", " ")}</span>
        </h2>
        <div className="flex flex-wrap items-center gap-1.5">
          {page.canManage ? (
            <Button onClick={() => setDialog({ kind: "hours" })} size="sm" variant="quiet">
              <Clock aria-hidden="true" className="size-3.5" />
              {s.hours}
            </Button>
          ) : null}
          {page.me ? (
            <Button onClick={() => setDialog({ kind: "timeOff" })} size="sm" variant="quiet">
              <Moon aria-hidden="true" className="size-3.5" />
              {s.timeOff}
            </Button>
          ) : null}
          {page.canManage ? (
            <Button onClick={() => setDialog({ kind: "visit", target: { kind: "book" } })} size="sm" variant="primary">
              <Plus aria-hidden="true" className="size-3.5" />
              {s.book}
            </Button>
          ) : null}
        </div>
      </div>

      {page.toSchedule.length > 0 ? (
        <ToScheduleList
          items={page.toSchedule}
          language={language}
          onBook={page.canManage ? (item) => setDialog({ kind: "visit", target: { kind: "book", work: toScheduleKey(item) } }) : undefined}
        />
      ) : null}

      {/* A day's details sit beside its lanes; a week's float over its right edge, so the week keeps its width. */}
      <div
        className={cn(
          "relative",
          (selected || timeOff) && (page.view === "day" ? "grid items-start gap-4 @5xl:grid-cols-[minmax(0,1fr)_20rem]" : "min-h-[34rem]"),
        )}
      >
        <section className="min-w-0 overflow-hidden rounded-card bg-surface shadow-card">
          {page.view === "day" ? <DayGrid date={page.date} {...shared} /> : <WeekBoard dates={page.dates} {...shared} />}
          {empty ? <p className="border-t border-line px-4 py-3 text-[13px] text-ink-3">{page.view === "day" ? s.noVisitsDay : s.noVisitsWeek}</p> : null}
          {page.canManage ? (
            <p className="hidden border-t border-line px-4 py-2.5 text-[12px] text-ink-3 [@media(pointer:fine)]:block">{s.drag.hint}</p>
          ) : null}
        </section>

        {selected ? (
          <aside aria-label={selected.title} className={page.view === "day" ? SIDE_PANEL : PANEL} ref={panelRef} tabIndex={-1}>
            <VisitDetail
              canManage={page.canManage}
              invoice={page.invoices[selected.jobId] ?? null}
              language={language}
              me={page.me}
              onAction={(next) => setDialog(next)}
              onClose={() => select(null)}
              timeZone={page.timeZone}
              today={page.today}
              visit={selected}
            />
          </aside>
        ) : timeOff ? (
          <aside aria-label={s.off} className={page.view === "day" ? SIDE_PANEL : PANEL} ref={panelRef} tabIndex={-1}>
            <TimeOffDetail block={timeOff} canRemove={page.canManage || timeOff.memberId === page.me} language={language} onClose={() => setTimeOff(null)} timeZone={page.timeZone} />
          </aside>
        ) : null}
      </div>

      <FormDialog onOpenChange={(open) => !open && closeDialog()} open={dialog?.kind === "visit" || dialog?.kind === "timeOff" || dialog?.kind === "hours"}>
        {dialog?.kind === "visit" ? (
          <VisitForm
            crew={page.crew}
            defaultDate={bookingDay}
            language={language}
            onDone={(visit) => {
              closeDialog();
              if (visit) {
                const day = localDateTime(visit.startAt, page.timeZone).slice(0, 10);
                go({ date: day, visit: visit.visitId, book: null }, "replace");
              }
            }}
            target={dialog.target}
            timeZone={page.timeZone}
            toSchedule={workLabel ? [...page.toSchedule, extraWork(workLabel)] : page.toSchedule}
          />
        ) : dialog?.kind === "timeOff" ? (
          <TimeOffForm canManage={page.canManage} crew={page.crew} defaultDate={bookingDay} language={language} me={page.me} onDone={closeDialog} />
        ) : dialog?.kind === "hours" ? (
          <HoursForm language={language} onDone={closeDialog} />
        ) : null}
      </FormDialog>
      {move ? (
        <MoveToast
          crew={page.crew}
          key={`${move.visitId}:${move.date}:${move.memberId}:${move.minute}`}
          language={language}
          move={move}
          onClose={closeMove}
          onMoved={() => setMovedFrom(page.visits)}
          onRefused={() => setRefused(true)}
        />
      ) : null}
      {dialog?.kind === "cancel" || dialog?.kind === "done" || dialog?.kind === "close" ? (
        <FormDialog onOpenChange={(open) => !open && closeDialog()} open>
          <StatusDialog kind={dialog.kind} language={language} onDone={closeDialog} visit={dialog.visit} />
        </FormDialog>
      ) : null}
    </div>
  );
}

/**
 * Confirms a dragged visit's move, or undoes it. Moving sends what the Reschedule form would (the day,
 * the time, and the crew), so the server's rules apply the same: a busy crew member or time off says
 * why and puts the visit back; outside working hours asks to move it anyway.
 */
function MoveToast({
  move,
  crew,
  language,
  onClose,
  onMoved,
  onRefused,
}: {
  move: MoveRequest;
  crew: SchedulePage["crew"];
  language: Language;
  onClose: () => void;
  onMoved: () => void;
  /** The server said no, and there's nothing to confirm instead. */
  onRefused: () => void;
}) {
  const s = pageCopyFor(language).schedule;
  const { send, busy } = useScheduleRequest(pageCopyFor(language).common.failed);
  const [state, setState] = useState<{ kind: "ask" } | { kind: "error"; error: string; outside: boolean } | { kind: "moved" }>({ kind: "ask" });
  const toastRef = useRef<HTMLDivElement>(null);

  // Keyboard users land on Move; Escape puts the visit back.
  useEffect(() => toastRef.current?.querySelector<HTMLButtonElement>("[data-confirm]")?.focus(), [state.kind]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Once moved, the toast says so for a moment.
  useEffect(() => {
    if (state.kind !== "moved") return;
    const timer = setTimeout(onClose, 2500);
    return () => clearTimeout(timer);
  }, [state.kind, onClose]);

  const names = move.memberIds.map((id) => crew.find((c) => c.memberId === id)?.name ?? "").filter(Boolean);
  const when = `${dayLabel(move.date, language, { weekday: "short", month: "short", day: "numeric" })}, ${clockLabel(move.minute, language)}–${clockLabel((move.minute + move.durationMinutes) % 1440, language)}`;
  const confirm = async (allowOutsideHours: boolean) => {
    const result = await send(`/api/schedule/visits/${move.visitId}`, "PATCH", {
      date: move.date,
      time: move.time,
      memberIds: move.memberIds,
      ...(allowOutsideHours ? { allowOutsideHours } : {}),
    });
    if (result.ok) onMoved();
    else if (result.code !== "OUTSIDE_HOURS") onRefused();
    setState(result.ok ? { kind: "moved" } : { kind: "error", error: result.error, outside: result.code === "OUTSIDE_HOURS" });
  };

  return (
    <div
      aria-label={s.detail.reschedule}
      className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] bg-surface p-3 pl-4 text-[13px] text-ink shadow-overlay ring-1 ring-line"
      ref={toastRef}
      role="dialog"
      style={{ animation: "pop-in 180ms var(--ease-out-strong) both" }}
    >
      <p aria-live="polite" className="min-w-0 flex-1 text-pretty">
        {state.kind === "moved" ? s.drag.moved : s.drag.confirm(move.visit.title, when, names.join(", "))}
        {state.kind === "error" ? (
          <span className="mt-0.5 block text-[12.5px] text-destructive" role="alert">
            {state.error}
          </span>
        ) : null}
      </p>
      {state.kind === "moved" ? null : (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button disabled={busy} onClick={onClose} size="sm" variant="quiet">
            {state.kind === "error" && !state.outside ? s.drag.dismiss : s.drag.undo}
          </Button>
          {state.kind === "ask" || (state.kind === "error" && state.outside) ? (
            <Button data-confirm disabled={busy} onClick={() => void confirm(state.kind === "error")} size="sm" variant="primary">
              {busy ? s.drag.moving : state.kind === "error" ? s.drag.moveAnyway : s.drag.move}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Work opened from a quote's page that isn't waiting (it has visits already): offered in the form all the same. */
function extraWork({ key, label }: { key: string; label: string }): ToScheduleJson {
  const [kind, id] = key.split(":");
  const base = { title: label, customerName: null, address: null, since: "" };
  return kind === "job" ? { kind: "job", jobId: id, quoteId: null, ...base } : { kind: "quote", quoteId: id, ...base };
}

function ToScheduleList({ items, language, onBook }: { items: ToScheduleJson[]; language: Language; onBook?: (item: ToScheduleJson) => void }) {
  const s = pageCopyFor(language).schedule;
  return (
    <section className="overflow-hidden rounded-card bg-surface shadow-card">
      <header className="flex items-baseline gap-2 border-b border-line px-4 py-2.5">
        <h3 className="text-[13px] font-medium text-ink">{s.toSchedule}</h3>
        <span className="text-[12px] text-ink-3 tabular-nums">{items.length}</span>
        <p className="ml-auto hidden text-[12px] text-ink-3 sm:block">{s.toScheduleHelp}</p>
      </header>
      <ul className="divide-y divide-line">
        {items.slice(0, 6).map((item) => (
          <li className="flex items-center gap-3 px-4 py-2" key={toScheduleKey(item)}>
            <StatusPill className="shrink-0" dot tone={item.kind === "quote" ? "green" : "accent"}>
              {item.kind === "quote" ? s.wonQuote : s.openWork}
            </StatusPill>
            <div className="min-w-0 flex-1">
              {item.quoteId ? (
                <Link className="block truncate text-[13px] font-medium text-ink hover:underline" href={`/quotes/${item.quoteId}`}>
                  {item.title}
                </Link>
              ) : (
                <p className="truncate text-[13px] font-medium text-ink">{item.title}</p>
              )}
              {item.customerName ? <p className="truncate text-[12px] text-ink-3">{item.customerName}</p> : null}
            </div>
            {onBook ? (
              <Button onClick={() => onBook(item)} size="sm">
                {s.bookIt}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <span aria-hidden="true" className="mt-0.5 text-ink-3">
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="sr-only">{label}</dt>
        <dd className="text-[13px] text-ink">{children}</dd>
      </div>
    </div>
  );
}

/** A visit's details: the work, customer, address, quote, crew, status, and notes, and what the viewer may do with it. */
function VisitDetail({
  visit,
  timeZone,
  today,
  language,
  canManage,
  invoice,
  me,
  onClose,
  onAction,
}: {
  visit: VisitJson;
  /** The job's invoice; only owners and admins get one. */
  invoice: SchedulePage["invoices"][string] | null;
  timeZone: string;
  today: string;
  language: Language;
  canManage: boolean;
  me: string | null;
  onClose: () => void;
  onAction: (dialog: Dialogs) => void;
}) {
  const s = pageCopyFor(language).schedule;
  const d = s.detail;
  const { send, busy } = useScheduleRequest(pageCopyFor(language).common.failed);
  const [error, setError] = useState<string>();
  const open = visit.status === "scheduled" || visit.status === "proposed";
  const day = localDateTime(visit.startAt, timeZone).slice(0, 10);
  // Anyone on the team marks a visit done: someone may finish another crew's job.
  const canFinish = open && day <= today && me !== null;
  const minutes = Math.round((Date.parse(visit.endAt) - Date.parse(visit.startAt)) / 60_000);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <StatusPill dot tone={STATUS_TONE[visit.status]}>
            {s.status[visit.status]}
          </StatusPill>
          <h3 className="text-[15px] font-semibold text-balance text-ink">{visit.title}</h3>
        </div>
        <Button aria-label={d.close} onClick={onClose} size="sm" variant="quiet">
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <dl className="space-y-2.5">
        <Row icon={<Clock className="size-3.5" />} label={d.when}>
          <span className="block">{dayLabel(day, language, { weekday: "long", month: "short", day: "numeric" })}</span>
          <span className="block text-ink-2 tabular-nums">
            {timeLabel(visit.startAt, timeZone, language)}–{timeLabel(visit.endAt, timeZone, language)} · {s.form.minutes(minutes)}
          </span>
        </Row>
        {visit.customerName ? (
          <Row icon={<User className="size-3.5" />} label={d.customer}>
            {visit.customerId ? (
              <Link className="font-medium text-accent-ink hover:underline" href={`/customers/${visit.customerId}`}>
                {visit.customerName}
              </Link>
            ) : (
              visit.customerName
            )}
          </Row>
        ) : null}
        {visit.address && visit.address !== visit.title ? (
          <Row icon={<MapPin className="size-3.5" />} label={d.address}>
            {visit.address}
          </Row>
        ) : null}
        {/* The drive in, on its own row: the title is often the address, which hides the row above. */}
        {visit.drive?.fromPrevious && visit.drive.fromPrevious.minutes > 0 ? (
          <Row icon={<Clock className="size-3.5" />} label={d.drive}>
            <span className="tabular-nums">{d.driveFrom(visit.drive.fromPrevious.minutes, visit.drive.fromPrevious.yard ? null : visit.drive.fromPrevious.label)}</span>
          </Row>
        ) : null}
        <Row icon={<Users className="size-3.5" />} label={d.crew}>
          {visit.crew.map((c) => c.name).join(", ")}
        </Row>
      </dl>
      {visit.quoteId ? (
        <Link className="block text-[13px] font-medium text-accent-ink hover:underline" href={`/quotes/${visit.quoteId}`}>
          {d.openQuote}
        </Link>
      ) : null}
      <div>
        <p className="text-[12px] text-ink-3">{d.notes}</p>
        <p className="text-[13px] whitespace-pre-wrap text-ink text-pretty">{visit.notes || <span className="text-ink-3">{d.noNotes}</span>}</p>
      </div>
      <Link className="block text-[13px] font-medium text-accent-ink hover:underline" href={`/work/${visit.jobId}`}>
        {d.work}: {s.workStatus[visit.jobStatus]}
        {visit.checklist ? ` · ${s.checklistDone(visit.checklist.done, visit.checklist.total)}` : ""}
      </Link>
      {invoice ? (
        <Link className="flex items-center gap-2 text-[13px] font-medium text-accent-ink hover:underline" href={`/invoices/${invoice.invoiceId}`}>
          {d.invoice} <span className="tabular-nums">{invoice.label}</span>
          <InvoiceStatusPill language={language} status={invoice.status as InvoiceStatus} />
        </Link>
      ) : canManage && visit.jobStatus === "completed" ? (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
          {d.notInvoiced}
          <CreateInvoiceButton about={{ serviceJobId: visit.jobId }} language={language} needsLines={!visit.quoteId} />
        </div>
      ) : null}
      <ErrorLine>{error}</ErrorLine>
      <div className="flex flex-wrap gap-1.5">
        {canFinish ? (
          <Button onClick={() => onAction({ kind: "done", visit })} size="sm" variant="primary">
            {d.markDone}
          </Button>
        ) : null}
        {canManage && visit.status === "proposed" ? (
          <Button
            disabled={busy}
            onClick={async () => {
              const result = await send(`/api/schedule/visits/${visit.visitId}/status`, "POST", { status: "scheduled" });
              if (!result.ok) setError(result.error);
            }}
            size="sm"
          >
            {d.confirm}
          </Button>
        ) : null}
        {canManage && open && visit.jobStatus === "open" ? (
          <Button onClick={() => onAction({ kind: "visit", target: { kind: "move", visit } })} size="sm">
            {d.reschedule}
          </Button>
        ) : null}
        {canManage && open ? (
          <Button onClick={() => onAction({ kind: "cancel", visit })} size="sm" variant="quiet">
            {d.cancel}
          </Button>
        ) : null}
        {canManage && visit.jobStatus === "open" ? (
          <Button onClick={() => onAction({ kind: "close", visit })} size="sm" variant="quiet">
            {d.closeWork}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function TimeOffDetail({ block, timeZone, language, canRemove, onClose }: { block: TimeOffJson; timeZone: string; language: Language; canRemove: boolean; onClose: () => void }) {
  const s = pageCopyFor(language).schedule;
  const { send, busy } = useScheduleRequest(pageCopyFor(language).common.failed);
  const [error, setError] = useState<string>();
  const start = localDateTime(block.startAt, timeZone);
  const end = localDateTime(block.endAt, timeZone);
  const allDay = start.endsWith("00:00") && end.endsWith("00:00");
  const lastDay = allDay ? shiftDate(end.slice(0, 10), -1) : end.slice(0, 10);
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <StatusPill tone="neutral">{s.off}</StatusPill>
          <h3 className="text-[15px] font-semibold text-ink">{block.memberName ?? s.wholeBusiness}</h3>
        </div>
        <Button aria-label={s.detail.close} onClick={onClose} size="sm" variant="quiet">
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <p className="text-[13px] text-ink">
        {dayLabel(start.slice(0, 10), language)}
        {lastDay !== start.slice(0, 10) ? ` – ${dayLabel(lastDay, language)}` : ""}
        <span className="block text-ink-2">{allDay ? s.allDay : `${timeLabel(block.startAt, timeZone, language)}–${timeLabel(block.endAt, timeZone, language)}`}</span>
      </p>
      {block.reason ? <p className="text-[13px] text-ink-2">{block.reason}</p> : null}
      <ErrorLine>{error}</ErrorLine>
      {canRemove ? (
        <Button
          disabled={busy}
          onClick={async () => {
            const result = await send(`/api/schedule/time-off/${block.id}`, "DELETE");
            if (result.ok) onClose();
            else setError(result.error);
          }}
          size="sm"
          variant="quiet"
        >
          {s.detail.removeTimeOff}
        </Button>
      ) : null}
    </div>
  );
}

/** Confirms a visit's cancellation, marks it done with notes, or closes its work. */
function StatusDialog({ kind, visit, language, onDone }: { kind: "cancel" | "done" | "close"; visit: VisitJson; language: Language; onDone: () => void }) {
  const copy = pageCopyFor(language);
  const d = copy.schedule.detail;
  const { send, busy } = useScheduleRequest(copy.common.failed);
  const [notes, setNotes] = useState(visit.notes ?? "");
  const [cancelUpcoming, setCancelUpcoming] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (url: string, body: unknown) => {
    const result = await send(url, "POST", body);
    if (result.ok) onDone();
    else setError(result.error);
  };
  return (
    <div className="grid gap-4">
      <DialogTitle>{kind === "cancel" ? d.confirmCancelTitle : kind === "done" ? d.markDone : d.closeTitle}</DialogTitle>
      <DialogDescription>{kind === "cancel" ? d.confirmCancelBody : kind === "close" ? d.closeBody : visit.title}</DialogDescription>
      {kind === "done" ? (
        <label className="grid gap-1.5 text-[13px]">
          {d.doneNotes}
          <textarea className={cn(inputClass, "h-20 py-1.5")} onChange={(event) => setNotes(event.target.value)} value={notes} />
        </label>
      ) : null}
      {kind === "close" ? (
        <label className="flex items-center gap-2 text-[13px]">
          <input checked={cancelUpcoming} className="size-4 accent-[var(--color-accent)]" onChange={(event) => setCancelUpcoming(event.target.checked)} type="checkbox" />
          {d.cancelUpcoming}
        </label>
      ) : null}
      <ErrorLine>{error}</ErrorLine>
      <DialogFooter>
        <DialogClose render={<Button size="sm" variant="quiet" />}>{kind === "cancel" ? d.keep : copy.common.cancel}</DialogClose>
        {kind === "close" ? (
          <Button disabled={busy} onClick={() => void run(`/api/schedule/jobs/${visit.jobId}/close`, { status: "cancelled", cancelUpcomingVisits: true })} size="sm" variant="quiet">
            {d.cancelWork}
          </Button>
        ) : null}
        <Button
          className={kind === "cancel" ? "bg-red text-white hover:opacity-90" : undefined}
          disabled={busy}
          onClick={() =>
            void (kind === "cancel"
              ? run(`/api/schedule/visits/${visit.visitId}/status`, { status: "cancelled" })
              : kind === "done"
                ? run(`/api/schedule/visits/${visit.visitId}/status`, { status: "completed", notes })
                : run(`/api/schedule/jobs/${visit.jobId}/close`, { status: "completed", cancelUpcomingVisits: cancelUpcoming }))
          }
          size="sm"
          variant={kind === "cancel" ? undefined : "primary"}
        >
          {kind === "cancel" ? d.cancel : kind === "done" ? d.markDone : d.complete}
        </Button>
      </DialogFooter>
    </div>
  );
}
