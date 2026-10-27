import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { customers, invoices, notes, properties, quoteRevisions, quotes } from "../schema/schema";
import { fold, foldedSql, searchCustomers } from "./customers";
import { db } from "./db";
import { invoiceLabel } from "./invoices";
import { isPrivileged } from "./members";
import type { NoteViewer } from "./notes";

// One search over what a business has on record: notes and documents, customers, quotes, and invoices.
// Postgres full-text search with the `simple` configuration (no stemming, so English and Spanish read the
// same) over accent-folded text, every word as a prefix. Everyone on the team finds every note, customer,
// and quote; invoices are for owners and admins.

export type RecordKind = "note" | "customer" | "quote" | "invoice";
export const RECORD_KINDS: readonly RecordKind[] = ["note", "customer", "quote", "invoice"];

export type RecordHit = {
  kind: RecordKind;
  id: string;
  title: string;
  /** A short line about it: the start of a note, a customer's contacts, a quote's or invoice's status. */
  snippet: string | null;
  customerId: string | null;
  customerName: string | null;
  address: string | null;
  status: string | null;
  totalCents: number | null;
  updatedAt: Date;
  rank: number;
};

export type RecordSearch = {
  results: RecordHit[];
  /** `all`: every word matched; `any`: nothing had every word, so these match some of them. */
  matched: "all" | "any" | "none";
};

const PER_KIND = 10;

/** The query's words, folded, letters and digits only: safe inside a tsquery. */
export function searchTokens(query: string): string[] {
  return [...new Set(fold(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean))].slice(0, 12);
}

const vector = (text: SQL, weight: "A" | "B" | "C") => sql`setweight(to_tsvector('simple', ${foldedSql(sql`coalesce(${text}, '')`)}), ${sql.raw(`'${weight}'`)})`;

type Matcher = { tsquery: SQL; tokens: string[] };
type KindQuery = (viewer: NoteViewer, match: Matcher, limit: number) => Promise<RecordHit[]>;

/**
 * How well a record matches: how many of the query's words it has, then Postgres's rank (weighted by
 * where they are: a title counts more than a body) as the tiebreak below one word.
 */
function rankOf(doc: SQL, match: Matcher): SQL<number> {
  const coverage = sql.join(
    match.tokens.map((t) => sql`(${doc} @@ to_tsquery('simple', ${`${t}:*`}))::int`),
    sql` + `,
  );
  return sql<number>`((${coverage}) + ts_rank(${doc}, ${match.tsquery}) / (1 + ts_rank(${doc}, ${match.tsquery})))`.mapWith(Number);
}

const searchNotes: KindQuery = async (viewer, match, limit) => {
  const doc = sql`(
    ${vector(sql`${notes.title}`, "A")} || ${vector(sql`array_to_string(${notes.tags}, ' ')`, "A")}
    || ${vector(sql`${notes.body}`, "B")}
    || ${vector(sql`(select string_agg(f->>'name', ' ') from jsonb_array_elements(${notes.files}) f)`, "B")}
    || ${vector(sql`concat_ws(' ', ${customers.name}, ${properties.address}, ${quotes.title})`, "C")}
  )`;
  const rows = await db()
    .select({
      id: notes.id,
      kind: notes.kind,
      title: notes.title,
      body: notes.body,
      customerId: notes.customerId,
      customerName: customers.name,
      address: properties.address,
      updatedAt: notes.updatedAt,
      rank: rankOf(doc, match),
    })
    .from(notes)
    .leftJoin(customers, and(eq(customers.orgId, viewer.orgId), eq(customers.id, notes.customerId)))
    .leftJoin(properties, and(eq(properties.orgId, viewer.orgId), eq(properties.id, notes.propertyId)))
    .leftJoin(quotes, and(eq(quotes.orgId, viewer.orgId), eq(quotes.id, notes.quoteId)))
    .where(and(eq(notes.orgId, viewer.orgId), isNull(notes.archivedAt), sql`${doc} @@ ${match.tsquery}`))
    .orderBy(desc(rankOf(doc, match)), desc(notes.updatedAt))
    .limit(limit);
  return rows.map((r) => ({
    kind: "note",
    id: r.id,
    title: r.title,
    snippet: r.body ? (r.body.length > 160 ? `${r.body.slice(0, 160)}…` : r.body) : r.kind === "document" ? "(document)" : null,
    customerId: r.customerId,
    customerName: r.customerName,
    address: r.address,
    status: r.kind,
    totalCents: null,
    updatedAt: r.updatedAt,
    rank: r.rank,
  }));
};

const customerDoc = sql`(
  ${vector(sql`${customers.name}`, "A")}
  || ${vector(sql`(select string_agg(concat_ws(' ', cc.name, cc.role, array_to_string(cc.emails, ' ')), ' ') from customer_contacts cc where cc.org_id = ${customers.orgId} and cc.customer_id = ${customers.id})`, "B")}
  || ${vector(sql`(select string_agg(p.address, ' ') from properties p where p.org_id = ${customers.orgId} and p.customer_id = ${customers.id})`, "B")}
  || ${vector(sql`${customers.notes}`, "C")}
)`;

const searchCustomerRecords: KindQuery = async (viewer, match, limit) => {
  const rows = await db()
    .select({
      id: customers.id,
      name: customers.name,
      phones: customers.phones,
      emails: customers.emails,
      address: sql<string | null>`(select p.address from properties p where p.org_id = ${customers.orgId} and p.customer_id = ${customers.id} order by p.created_at limit 1)`,
      updatedAt: customers.updatedAt,
      rank: rankOf(customerDoc, match),
    })
    .from(customers)
    .where(
      and(
        eq(customers.orgId, viewer.orgId),
        isNull(customers.archivedAt),
        sql`${customerDoc} @@ ${match.tsquery}`,
      ),
    )
    .orderBy(desc(rankOf(customerDoc, match)), desc(customers.updatedAt))
    .limit(limit);
  return rows.map((r) => ({
    kind: "customer",
    id: r.id,
    title: r.name,
    snippet: [...r.phones, ...r.emails].join(", ") || null,
    customerId: r.id,
    customerName: r.name,
    address: r.address,
    status: null,
    totalCents: null,
    updatedAt: r.updatedAt,
    rank: r.rank,
  }));
};

const searchQuotes: KindQuery = async (viewer, match, limit) => {
  const doc = sql`(
    ${vector(sql`${quotes.title}`, "A")}
    || ${vector(sql`concat_ws(' ', ${customers.name}, ${properties.address})`, "B")}
    || ${vector(sql`(select string_agg(l->>'name', ' ') from jsonb_array_elements(${quoteRevisions.lines}) l)`, "C")}
    || ${vector(sql`${quoteRevisions.customerNotes}`, "C")}
  )`;
  const rows = await db()
    .select({
      id: quotes.id,
      title: quotes.title,
      status: quotes.status,
      state: quoteRevisions.state,
      totalCents: quoteRevisions.totalCents,
      customerId: quotes.customerId,
      customerName: customers.name,
      address: properties.address,
      updatedAt: quotes.updatedAt,
      rank: rankOf(doc, match),
    })
    .from(quotes)
    .innerJoin(quoteRevisions, and(eq(quoteRevisions.orgId, viewer.orgId), eq(quoteRevisions.id, quotes.currentRevisionId)))
    .leftJoin(customers, and(eq(customers.orgId, viewer.orgId), eq(customers.id, quotes.customerId)))
    .leftJoin(properties, and(eq(properties.orgId, viewer.orgId), eq(properties.id, quotes.propertyId)))
    .where(
      and(
        eq(quotes.orgId, viewer.orgId),
        sql`${doc} @@ ${match.tsquery}`,
      ),
    )
    .orderBy(desc(rankOf(doc, match)), desc(quotes.updatedAt))
    .limit(limit);
  return rows.map((r) => ({
    kind: "quote",
    id: r.id,
    title: r.title,
    snippet: null,
    customerId: r.customerId,
    customerName: r.customerName,
    address: r.address,
    status: r.status,
    totalCents: r.state === "ready" ? r.totalCents : null,
    updatedAt: r.updatedAt,
    rank: r.rank,
  }));
};

const searchInvoices: KindQuery = async (viewer, match, limit) => {
  if (!isPrivileged(viewer.role)) return [];
  const doc = sql`(
    ${vector(sql`concat_ws(' ', 'inv-' || lpad(${invoices.number}::text, 4, '0'), ${invoices.number}::text, ${invoices.title})`, "A")}
    || ${vector(sql`concat_ws(' ', ${customers.name}, ${properties.address})`, "B")}
    || ${vector(sql`(select string_agg(l->>'name', ' ') from jsonb_array_elements(${invoices.lines}) l)`, "C")}
    || ${vector(sql`${invoices.notes}`, "C")}
  )`;
  const rows = await db()
    .select({
      id: invoices.id,
      number: invoices.number,
      title: invoices.title,
      status: invoices.status,
      totalCents: invoices.totalCents,
      customerId: invoices.customerId,
      customerName: customers.name,
      address: properties.address,
      updatedAt: invoices.updatedAt,
      rank: rankOf(doc, match),
    })
    .from(invoices)
    .leftJoin(customers, and(eq(customers.orgId, viewer.orgId), eq(customers.id, invoices.customerId)))
    .leftJoin(properties, and(eq(properties.orgId, viewer.orgId), eq(properties.id, invoices.propertyId)))
    .where(and(eq(invoices.orgId, viewer.orgId), sql`${doc} @@ ${match.tsquery}`))
    .orderBy(desc(rankOf(doc, match)), desc(invoices.updatedAt))
    .limit(limit);
  return rows.map((r) => ({
    kind: "invoice",
    id: r.id,
    title: `${invoiceLabel(r.number)} ${r.title}`,
    snippet: null,
    customerId: r.customerId,
    customerName: r.customerName,
    address: r.address,
    status: r.status,
    totalCents: r.totalCents,
    updatedAt: r.updatedAt,
    rank: r.rank,
  }));
};

const BY_KIND: Record<RecordKind, KindQuery> = {
  note: searchNotes,
  customer: searchCustomerRecords,
  quote: searchQuotes,
  invoice: searchInvoices,
};

/**
 * Searches the viewer's business for `query`, best matches first, at most `limit` (default 10). Every
 * word must match (as a word or the start of one); when nothing has them all, results with any of them
 * come back, marked `any`. A query that is a phone number also finds the customer with it.
 */
export async function searchRecords(
  viewer: NoteViewer,
  query: string,
  options: { kinds?: readonly RecordKind[]; limit?: number } = {},
): Promise<RecordSearch> {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return { results: [], matched: "none" };
  const kinds = (options.kinds?.length ? options.kinds : RECORD_KINDS).filter((k) => k !== "invoice" || isPrivileged(viewer.role));
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 10), 1), 30);

  const run = async (joiner: " & " | " | ") => {
    const tsquery = sql`to_tsquery('simple', ${tokens.map((t) => `${t}:*`).join(joiner)})`;
    const lists = await Promise.all(kinds.map((kind) => BY_KIND[kind](viewer, { tsquery, tokens }, PER_KIND)));
    return lists.flat();
  };

  let hits = await run(" & ");
  let matched: RecordSearch["matched"] = "all";
  // A phone number: the customer who has it, by digits, whatever punctuation either side used.
  if (kinds.includes("customer") && /^[\d\s()+.-]+$/.test(query.trim()) && query.replace(/\D/g, "").length >= 4) {
    const byPhone = await searchCustomers(viewer.orgId, query, { limit: PER_KIND });
    for (const c of byPhone) {
      if (hits.some((h) => h.kind === "customer" && h.id === c.id)) continue;
      hits.push({
        kind: "customer",
        id: c.id,
        title: c.name,
        snippet: [...c.phones, ...c.emails].join(", ") || null,
        customerId: c.id,
        customerName: c.name,
        address: c.properties[0]?.address ?? null,
        status: null,
        totalCents: null,
        updatedAt: c.updatedAt,
        rank: tokens.length + 1,
      });
    }
  }
  if (hits.length === 0 && tokens.length > 1) {
    hits = await run(" | ");
    matched = hits.length ? "any" : "none";
  } else if (hits.length === 0) {
    matched = "none";
  }
  hits.sort((a, b) => b.rank - a.rank || b.updatedAt.getTime() - a.updatedAt.getTime());
  return { results: hits.slice(0, limit), matched };
}


