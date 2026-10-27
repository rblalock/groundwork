// Proactive messages: the follow-up nudge on an approved quote, the nudge about invoices past due, the
// morning line, and notices that quiet hours held back. Everything here is deterministic code. No model turn runs, and quiet hours
// are enforced by `postToMember`.
import { and, asc, count, eq, inArray, lte } from "drizzle-orm";
import { conversations, events, followups, memberPhones, members, ownerRequests, quotes } from "../schema/schema";
import { db, newId, type Db, type Tx } from "./db";
import { recordEvent } from "./events";
import { isLanguage, type Language } from "./language";
import { invoiceNudgeText, invoiceTotals, overdueInvoices, type InvoiceView } from "./invoices";
import { findMemberById, isPrivileged, privilegedMembers, type Member } from "./members";
import { formatCents } from "./money";
import { listOrganizations } from "./organizations";
import { postToMember } from "./outbound";
import { getProfile, type Profile } from "./profile";
import { loadSummary, type QuoteSummary } from "./quotes";
import { timeText } from "./scheduling-time";
import { visitsOnDay, type VisitView } from "./scheduling";
import { localParts, nextAllowedTime } from "./time";

export type Followup = typeof followups.$inferSelect;
export type NoticePayload = NonNullable<Followup["payload"]>;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKLY_DAYS = 7;
const MORNING_HOUR = 8;

/** `from` plus `days`, moved to the end of the profile's quiet hours when it lands inside them. */
export function computeDueAt(from: Date, days: number, profile: Profile): Date {
  return nextAllowedTime(
    new Date(from.getTime() + days * DAY_MS),
    profile.timeZone,
    profile.quietStartHour,
    profile.quietEndHour,
  );
}

/** Pass `executor` to run inside an open transaction. `db()` is single-connection, so nesting would deadlock. */
export async function scheduleFollowup(
  input: {
    orgId: string;
    quoteId: string | null;
    memberId: string;
    kind: Followup["kind"];
    dueAt: Date;
    payload?: NoticePayload;
  },
  executor: Db | Tx = db(),
): Promise<Followup> {
  const [row] = await executor
    .insert(followups)
    .values({
      id: newId("fu"),
      orgId: input.orgId,
      quoteId: input.quoteId,
      memberId: input.memberId,
      kind: input.kind,
      dueAt: input.dueAt,
      payload: input.payload ?? null,
    })
    .returning();
  return row;
}

/**
 * Queues a proactive notice that quiet hours held back, for the end of quiet hours. A notice about a
 * quote replaces a pending notice to the same member about the same quote; one about no quote (a
 * crew member's suggested rule) is kept alongside the others.
 */
export async function queueNotice(input: {
  orgId: string;
  memberId: string;
  quoteId: string | null;
  payload: NoticePayload;
  now: Date;
}): Promise<Followup> {
  const profile = await getProfile(input.orgId);
  return db().transaction(async (tx) => {
    if (input.quoteId) {
      await tx
        .update(followups)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(followups.orgId, input.orgId),
            eq(followups.kind, "notice"),
            eq(followups.status, "pending"),
            eq(followups.memberId, input.memberId),
            eq(followups.quoteId, input.quoteId),
          ),
        );
    }
    const dueAt = nextAllowedTime(input.now, profile.timeZone, profile.quietStartHour, profile.quietEndHour);
    return scheduleFollowup({ ...input, kind: "notice", dueAt }, tx);
  });
}

/** Cancels every pending follow-up on the quote; returns how many. */
export async function cancelFollowups(orgId: string, quoteId: string, executor: Db | Tx = db()): Promise<number> {
  const rows = await executor
    .update(followups)
    .set({ status: "cancelled" })
    .where(and(eq(followups.orgId, orgId), eq(followups.quoteId, quoteId), eq(followups.status, "pending")))
    .returning({ id: followups.id });
  return rows.length;
}

/**
 * Cancels the quote's queued notices; returns how many. A new revision makes them stale: a held-back
 * "please approve" would otherwise go out in the morning and a 👍 on it would approve a revision the
 * owner never saw.
 */
export async function cancelNotices(orgId: string, quoteId: string, executor: Db | Tx = db()): Promise<number> {
  const rows = await executor
    .update(followups)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(followups.orgId, orgId),
        eq(followups.quoteId, quoteId),
        eq(followups.kind, "notice"),
        eq(followups.status, "pending"),
      ),
    )
    .returning({ id: followups.id });
  return rows.length;
}

/**
 * Pending nudges that have come due on a quote that is still approved or sent, oldest first. A quote
 * whose summary can't be loaded is logged and skipped, so it never holds up the others.
 */
export async function dueNudges(
  orgId: string,
  now: Date,
): Promise<Array<Followup & { quote: QuoteSummary; approvedAt: Date | null }>> {
  const rows = await db()
    .select({ followup: followups, approvedAt: quotes.approvedAt })
    .from(followups)
    .innerJoin(quotes, and(eq(quotes.orgId, orgId), eq(quotes.id, followups.quoteId)))
    .where(
      and(
        eq(followups.orgId, orgId),
        eq(followups.kind, "nudge"),
        eq(followups.status, "pending"),
        lte(followups.dueAt, now),
        inArray(quotes.status, ["approved", "sent"]),
      ),
    )
    .orderBy(asc(followups.dueAt), asc(followups.id));
  const out = [];
  for (const row of rows) {
    try {
      out.push({ ...row.followup, approvedAt: row.approvedAt, quote: await loadSummary(orgId, row.followup.quoteId ?? "") });
    } catch (error) {
      console.error("followups: nudge skipped, its quote could not be loaded", { followupId: row.followup.id, error });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Copy

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const NUDGE: Record<Language, (what: string, days: number | undefined) => string> = {
  en: (what, days) =>
    `${what} was approved${days === undefined ? "" : ` ${plural(days, "day", "days")} ago`} and I haven't heard how it went. Want me to draft a follow-up, or mark it won or lost?`,
  es: (what, days) =>
    `${what} fue aprobada${days === undefined ? "" : ` hace ${plural(days, "día", "días")}`} y no he sabido cómo le fue. ¿Quieres que redacte un seguimiento, o la marco como ganada o perdida?`,
};

/** `daysAgo` is whole days since approval; left out, the sentence just says it was approved. */
export function nudgeText(quote: QuoteSummary, language: Language, daysAgo?: number): string {
  const what = `${quote.title} (${formatCents(quote.totalCents, language, { concise: true })})`;
  return NUDGE[language](what, daysAgo);
}

type MorningCounts = {
  waitingOnCustomers: number;
  waitingOnOwner: number;
  drafts: number;
  /** Owners and admins only: sent invoices past due, and what they still owe. */
  overdueInvoices?: number;
  overdueCents?: number;
};

/** Today's visits for the morning line: a crew member's own (`mine`), or the whole business's. */
export type MorningDay = { visits: VisitView[]; timeZone: string; mine: boolean };

const MORNING_VISITS_LISTED = 4;

const MORNING: Record<
  Language,
  { greeting: string; parts: (c: MorningCounts) => string[]; day: (items: string[], total: number, mine: boolean) => string }
> = {
  en: {
    greeting: "Good morning.",
    parts: (c) => [
      c.waitingOnCustomers > 0 && `${plural(c.waitingOnCustomers, "quote", "quotes")} waiting on customers`,
      c.waitingOnOwner > 0 && `${plural(c.waitingOnOwner, "crew draft", "crew drafts")} waiting on you`,
      c.drafts > 0 && `${plural(c.drafts, "draft", "drafts")} in progress`,
      (c.overdueInvoices ?? 0) > 0 &&
        `${plural(c.overdueInvoices ?? 0, "invoice", "invoices")} overdue (${formatCents(c.overdueCents ?? 0, "en", { concise: true })})`,
    ].filter((p): p is string => Boolean(p)),
    day: (items, total, mine) =>
      `${mine ? "Your day" : `${plural(total, "visit", "visits")} today`}: ${items.join(", ")}${total > items.length ? `, and ${total - items.length} more` : ""}.`,
  },
  es: {
    greeting: "Buenos días.",
    parts: (c) => [
      c.waitingOnCustomers > 0 &&
        `${plural(c.waitingOnCustomers, "cotización", "cotizaciones")} esperando a los clientes`,
      c.waitingOnOwner > 0 &&
        `${plural(c.waitingOnOwner, "borrador del equipo", "borradores del equipo")} esperando por ti`,
      c.drafts > 0 && `${plural(c.drafts, "borrador", "borradores")} en progreso`,
      (c.overdueInvoices ?? 0) > 0 &&
        `${plural(c.overdueInvoices ?? 0, "factura vencida", "facturas vencidas")} (${formatCents(c.overdueCents ?? 0, "es", { concise: true })})`,
    ].filter((p): p is string => Boolean(p)),
    day: (items, total, mine) =>
      `${mine ? "Tu día" : `${plural(total, "visita", "visitas")} hoy`}: ${items.join(", ")}${total > items.length ? ` y ${total - items.length} más` : ""}.`,
  },
};

/** "9 AM 12 Oak St", with the crew in parentheses on the business's list. */
function morningVisit(visit: VisitView, day: MorningDay, language: Language): string {
  const crew = !day.mine && visit.crew.length ? ` (${visit.crew.map((c) => c.name.split(/\s+/)[0]).join(", ")})` : "";
  return `${timeText(visit.startAt, day.timeZone, language)} ${visit.title}${crew}`;
}

/** The morning line, or null on a quiet day: today's visits first, then what's waiting on quotes. */
export function morningLineText(counts: MorningCounts, language: Language, day?: MorningDay): string | null {
  const copy = MORNING[language];
  const parts = copy.parts(counts);
  const visits = day?.visits ?? [];
  const sentences: string[] = [];
  if (day && visits.length > 0) {
    const items = visits.slice(0, MORNING_VISITS_LISTED).map((v) => morningVisit(v, day, language));
    sentences.push(copy.day(items, visits.length, day.mine));
  }
  if (parts.length > 0) sentences.push(`${parts.join(", ")}.`);
  return sentences.length === 0 ? null : `${copy.greeting} ${sentences.join(" ")}`;
}

// ---------------------------------------------------------------------------------------------
// The hourly tick

const wholeDaysBetween = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));

/** Marks one follow-up row; scoped to its business like every other write. */
async function setFollowupStatus(orgId: string, id: string, status: Followup["status"]): Promise<void> {
  await db()
    .update(followups)
    .set({ status })
    .where(and(eq(followups.orgId, orgId), eq(followups.id, id)));
}

/** Claims a pending row so two overlapping ticks cannot both send it. */
async function claimFollowup(orgId: string, id: string): Promise<boolean> {
  const claimed = await db()
    .update(followups)
    .set({ status: "sent" })
    .where(and(eq(followups.orgId, orgId), eq(followups.id, id), eq(followups.status, "pending")))
    .returning({ id: followups.id });
  return claimed.length > 0;
}

async function sendDueNudges(orgId: string, now: Date, profile: Profile): Promise<number> {
  let nudges = 0;
  for (const due of await dueNudges(orgId, now)) {
    try {
      const member = await findMemberById(orgId, due.memberId);
      if (!member || member.status !== "active") {
        await setFollowupStatus(orgId, due.id, "cancelled");
        continue;
      }
      if (!(await claimFollowup(orgId, due.id))) continue;

      const language = isLanguage(member.language) ? member.language : "en";
      const days = due.approvedAt ? wholeDaysBetween(due.approvedAt, now) : undefined;
      const result = await postToMember(
        orgId,
        member.id,
        { text: nudgeText(due.quote, language, days), quoteId: due.quote.quoteId, asksApproval: true },
        "proactive",
        { now, profile },
      );
      if (!result.posted) {
        // Quiet hours, a phone that cannot be texted yet, or a send failure: try again next tick.
        await setFollowupStatus(orgId, due.id, "pending");
        continue;
      }
      await scheduleFollowup({
        orgId,
        quoteId: due.quoteId,
        memberId: due.memberId,
        kind: "nudge",
        dueAt: computeDueAt(now, WEEKLY_DAYS, profile),
      });
      nudges++;
    } catch (error) {
      console.error("followups: nudge failed", error);
    }
  }
  return nudges;
}

/** Whether the member opened this thread on the web after `since`. */
async function threadSeenSince(orgId: string, conversationId: string, since: Date): Promise<boolean> {
  const [row] = await db()
    .select({ seenAt: conversations.seenAt })
    .from(conversations)
    .where(and(eq(conversations.orgId, orgId), eq(conversations.id, conversationId)));
  return Boolean(row?.seenAt && row.seenAt > since);
}

/**
 * Queued notices that have come due. A notice asking to approve a quote that is no longer waiting is
 * dropped, and so is an email thread's reply its member has read on the web since.
 */
async function sendDueNotices(orgId: string, now: Date, profile: Profile): Promise<number> {
  const rows = await db()
    .select({ followup: followups, quoteStatus: quotes.status })
    .from(followups)
    .leftJoin(quotes, and(eq(quotes.orgId, orgId), eq(quotes.id, followups.quoteId)))
    .where(
      and(
        eq(followups.orgId, orgId),
        eq(followups.kind, "notice"),
        eq(followups.status, "pending"),
        lte(followups.dueAt, now),
      ),
    )
    .orderBy(asc(followups.dueAt), asc(followups.id));
  let notices = 0;
  for (const { followup: due, quoteStatus } of rows) {
    try {
      const member = await findMemberById(orgId, due.memberId);
      // An email thread's reply the member has since read on the web is old news.
      const read = due.payload?.conversationId ? await threadSeenSince(orgId, due.payload.conversationId, due.createdAt) : false;
      const stale = read || (due.payload?.asksApproval && quoteStatus !== "draft" && quoteStatus !== "needs_owner");
      if (!member || member.status !== "active" || !due.payload || stale) {
        await setFollowupStatus(orgId, due.id, "cancelled");
        continue;
      }
      if (!(await claimFollowup(orgId, due.id))) continue;

      const result = await postToMember(
        orgId,
        member.id,
        { text: due.payload.text, quoteId: due.quoteId ?? undefined, asksApproval: due.payload.asksApproval },
        "proactive",
        { now, profile },
      );
      if (!result.posted) {
        // Quiet hours or a send failure: try again next tick. A phone that can't be texted: drop it.
        const retry = result.reason === "quiet_hours" || result.reason === "send_failed";
        await setFollowupStatus(orgId, due.id, retry ? "pending" : "cancelled");
        continue;
      }
      notices++;
    } catch (error) {
      console.error("followups: notice failed", error);
    }
  }
  return notices;
}

/** What is open for this member: the whole book for owners and admins, their own quotes for crew. */
async function morningCounts(member: Member, now: Date): Promise<MorningCounts> {
  const { orgId } = member;
  const total = async (status: Array<typeof quotes.$inferSelect["status"]>) => {
    const scope = isPrivileged(member.role) ? [] : [eq(quotes.createdByMemberId, member.id)];
    const [row] = await db()
      .select({ n: count() })
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), inArray(quotes.status, status), ...scope));
    return row.n;
  };
  if (isPrivileged(member.role)) {
    const [waiting] = await db()
      .select({ n: count() })
      .from(ownerRequests)
      .innerJoin(quotes, eq(quotes.id, ownerRequests.quoteId))
      .where(
        and(
          eq(ownerRequests.orgId, orgId),
          eq(quotes.orgId, orgId),
          eq(ownerRequests.status, "pending"),
          inArray(quotes.status, ["draft", "needs_owner"]),
        ),
      );
    const invoices = await invoiceTotals(orgId, { now });
    return {
      waitingOnCustomers: await total(["approved", "sent"]),
      waitingOnOwner: waiting.n,
      drafts: await total(["draft"]),
      overdueInvoices: invoices.counts.overdue,
      overdueCents: invoices.overdueCents,
    };
  }
  // Crew never see "waiting on you": their needs-owner quotes count with their other drafts.
  return {
    waitingOnCustomers: await total(["approved", "sent"]),
    waitingOnOwner: 0,
    drafts: await total(["draft", "needs_owner"]),
  };
}

async function sendMorningLines(orgId: string, now: Date, profile: Profile): Promise<number> {
  const local = localParts(now, profile.timeZone);
  if (local.hour !== MORNING_HOUR) return 0;
  const recipients = await db()
    .selectDistinct({ member: members })
    .from(members)
    .innerJoin(memberPhones, eq(memberPhones.memberId, members.id))
    .where(
      and(
        eq(members.orgId, orgId),
        eq(memberPhones.orgId, orgId),
        eq(members.status, "active"),
        eq(memberPhones.status, "verified"),
      ),
    )
    .orderBy(asc(members.createdAt), asc(members.id));
  let mornings = 0;
  for (const { member } of recipients) {
    try {
      const { inserted } = await recordEvent({
        orgId,
        kind: "morning",
        key: `morning:${member.id}:${local.ymd}`,
        memberId: member.id,
      });
      if (!inserted) continue;
      // Owners and admins hear the whole business's day; crew hear their own.
      const mine = !isPrivileged(member.role);
      const day: MorningDay = {
        visits: await visitsOnDay(orgId, local.ymd, profile.timeZone, mine ? member.id : undefined),
        timeZone: profile.timeZone,
        mine,
      };
      const text = morningLineText(await morningCounts(member, now), isLanguage(member.language) ? member.language : "en", day);
      if (!text) continue;
      const result = await postToMember(orgId, member.id, { text }, "proactive", { now, profile });
      if (result.posted) mornings++;
    } catch (error) {
      console.error("followups: morning line failed", error);
    }
  }
  return mornings;
}

/** An invoice is first nudged this many days after it's due (the business's follow-up days), then weekly. */
const INVOICE_NUDGE_EVERY_DAYS = 7;
const INVOICE_NUDGE_LISTED = 3;

/**
 * A gentle nudge to the owner or admin who sent an invoice (or every owner and admin, when they're
 * gone) about invoices still unpaid `followUpDays` after they were due, then once a week. Never to the
 * customer. Each invoice and step is claimed with an event first, so overlapping ticks send it once; a
 * text that quiet hours or a failure held back gives its claims back for the next tick.
 */
async function sendInvoiceNudges(orgId: string, now: Date, profile: Profile): Promise<number> {
  const due = (await overdueInvoices(orgId, { now })).filter((i) => i.daysOverdue >= profile.followUpDays);
  if (due.length === 0) return 0;
  const owners = await privilegedMembers(orgId);
  const byMember = new Map<string, { member: Member; invoices: InvoiceView[] }>();
  for (const invoice of due) {
    const sender = owners.find((m) => m.id === invoice.sentByMemberId);
    for (const member of sender ? [sender] : owners) {
      const entry = byMember.get(member.id) ?? { member, invoices: [] };
      entry.invoices.push(invoice);
      byMember.set(member.id, entry);
    }
  }
  let sent = 0;
  for (const { member, invoices: list } of byMember.values()) {
    try {
      const claimed: Array<{ invoice: InvoiceView; key: string }> = [];
      for (const invoice of list) {
        const step = Math.floor((invoice.daysOverdue - profile.followUpDays) / INVOICE_NUDGE_EVERY_DAYS);
        const key = `invoice_nudge:${member.id}:${invoice.id}:${step}`;
        const { inserted } = await recordEvent({ orgId, kind: "invoice.nudge", key, refId: invoice.id, memberId: member.id });
        if (inserted) claimed.push({ invoice, key });
      }
      if (claimed.length === 0) continue;
      const language = isLanguage(member.language) ? member.language : "en";
      const text = invoiceNudgeText(claimed.slice(0, INVOICE_NUDGE_LISTED).map((c) => c.invoice), language);
      const result = await postToMember(orgId, member.id, { text }, "proactive", { now, profile });
      if (!result.posted) {
        await db().delete(events).where(and(eq(events.orgId, orgId), inArray(events.key, claimed.map((c) => c.key))));
        continue;
      }
      sent++;
    } catch (error) {
      console.error("followups: invoice nudge failed", error);
    }
  }
  return sent;
}

export type TickCounts = { nudges: number; mornings: number; notices: number };

/**
 * One business's pass of the hourly schedule, in its own time zone and quiet hours: notices held back
 * by quiet hours, due nudges, then the morning line when it is 8 o'clock there.
 */
export async function runOrgTick(orgId: string, now: Date = new Date()): Promise<TickCounts> {
  const profile = await getProfile(orgId);
  const notices = await sendDueNotices(orgId, now, profile);
  const nudges = (await sendDueNudges(orgId, now, profile)) + (await sendInvoiceNudges(orgId, now, profile));
  const mornings = await sendMorningLines(orgId, now, profile);
  return { nudges, mornings, notices };
}

/** One pass of the hourly schedule over every business. One that fails is logged and the rest still run. */
export async function runHourlyTick(now: Date = new Date()): Promise<TickCounts> {
  const totals: TickCounts = { nudges: 0, mornings: 0, notices: 0 };
  for (const org of await listOrganizations()) {
    // A paused business gets no nudges or morning line; its follow-ups wait until it's resumed.
    if (org.suspended) continue;
    try {
      const counts = await runOrgTick(org.id, now);
      totals.nudges += counts.nudges;
      totals.mornings += counts.mornings;
      totals.notices += counts.notices;
    } catch (error) {
      console.error("followups: hourly tick failed for a business", { orgId: org.id, error });
    }
  }
  return totals;
}

/** The hourly schedule's entry point: a tick that fails is logged, never left as an unhandled rejection. */
export async function hourlyTick(now: Date = new Date(), tick: (now: Date) => Promise<unknown> = runHourlyTick): Promise<void> {
  try {
    await tick(now);
  } catch (error) {
    console.error("followups: hourly tick failed", error);
  }
}
