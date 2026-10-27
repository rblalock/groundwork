import { and, asc, eq, inArray } from "drizzle-orm";
import { approvals, events, members, ownerRequests, quoteRevisions, quotes } from "../schema/schema";
import { db } from "./db";

export type TimelineEntry = {
  at: Date;
  kind:
    | "created"
    | "revised"
    | "owner_requested"
    | "approved"
    | "sent"
    | "won"
    | "lost"
    | "void"
    | "emailed"
    | "customer_approved"
    | "deposit";
  /** Who did it; null when no member is on record. */
  by: string | null;
  revision?: number;
  /** For `emailed`: the address it went to. */
  to?: string;
  /** For `customer_approved`: the name the customer signed with. */
  name?: string;
  /** For `deposit`: how much came in. */
  amountCents?: number;
};

const OUTCOMES = new Set(["sent", "won", "lost", "void"]);

/**
 * What happened to a quote, oldest first: its revisions, a crew request for the owner, approvals,
 * outcomes, and emails. Null when the quote isn't this business's.
 */
export async function quoteTimeline(orgId: string, quoteId: string): Promise<TimelineEntry[] | null> {
  const [quote] = await db()
    .select()
    .from(quotes)
    .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)));
  if (!quote) return null;

  const [revisions, requests, approved, logged] = await Promise.all([
    db()
      .select({ number: quoteRevisions.number, at: quoteRevisions.createdAt, memberId: quoteRevisions.createdByMemberId })
      .from(quoteRevisions)
      .where(and(eq(quoteRevisions.orgId, orgId), eq(quoteRevisions.quoteId, quoteId))),
    db()
      .select({ at: ownerRequests.createdAt, memberId: ownerRequests.requestedByMemberId })
      .from(ownerRequests)
      .where(and(eq(ownerRequests.orgId, orgId), eq(ownerRequests.quoteId, quoteId))),
    db()
      .select({ at: approvals.createdAt, memberId: approvals.memberId, revision: quoteRevisions.number })
      .from(approvals)
      .innerJoin(quoteRevisions, and(eq(quoteRevisions.orgId, orgId), eq(quoteRevisions.id, approvals.quoteRevisionId)))
      .where(and(eq(approvals.orgId, orgId), eq(quoteRevisions.quoteId, quoteId))),
    db()
      .select({ at: events.createdAt, kind: events.kind, memberId: events.memberId, data: events.data })
      .from(events)
      .where(
        and(eq(events.orgId, orgId), eq(events.refId, quoteId), inArray(events.kind, ["quote.touched", "quote.emailed", "quote.customer_approved", "quote.deposit"])),
      )
      .orderBy(asc(events.createdAt), asc(events.id)),
  ]);

  const memberIds = new Set<string>();
  for (const row of [...revisions, ...requests, ...approved, ...logged]) if (row.memberId) memberIds.add(row.memberId);
  const names = new Map(
    memberIds.size
      ? (
          await db()
            .select({ id: members.id, name: members.name })
            .from(members)
            .where(and(eq(members.orgId, orgId), inArray(members.id, [...memberIds])))
        ).map((m) => [m.id, m.name])
      : [],
  );
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);

  const entries: TimelineEntry[] = [
    ...revisions.map((r): TimelineEntry => ({
      at: r.at,
      kind: r.number === 1 ? "created" : "revised",
      by: nameOf(r.memberId),
      revision: r.number,
    })),
    ...requests.map((r): TimelineEntry => ({ at: r.at, kind: "owner_requested", by: nameOf(r.memberId) })),
    ...approved.map((a): TimelineEntry => ({ at: a.at, kind: "approved", by: nameOf(a.memberId), revision: a.revision })),
  ];
  for (const event of logged) {
    if (event.kind === "quote.emailed") {
      entries.push({
        at: event.at,
        kind: "emailed",
        by: nameOf(event.memberId),
        to: typeof event.data.to === "string" ? event.data.to : undefined,
      });
      continue;
    }
    if (event.kind === "quote.customer_approved") {
      entries.push({ at: event.at, kind: "customer_approved", by: null, revision: Number(event.data.revision) || undefined, name: quote.customerApprovedName ?? undefined });
      continue;
    }
    if (event.kind === "quote.deposit") {
      entries.push({ at: event.at, kind: "deposit", by: null, amountCents: Number(event.data.amountCents) || undefined });
      continue;
    }
    const outcome = event.data.outcome;
    if (typeof outcome === "string" && OUTCOMES.has(outcome)) {
      entries.push({ at: event.at, kind: outcome as TimelineEntry["kind"], by: nameOf(event.memberId) });
    }
  }
  // Outcomes recorded before events carried them still show, from the quote's own timestamp.
  if (
    quote.outcomeAt &&
    (quote.status === "won" || quote.status === "lost" || quote.status === "void") &&
    !entries.some((e) => e.kind === quote.status || (quote.status === "won" && e.kind === "customer_approved"))
  ) {
    entries.push({ at: quote.outcomeAt, kind: quote.status, by: null });
  }
  return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
}
