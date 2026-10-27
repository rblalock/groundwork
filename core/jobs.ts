import { createHash } from "node:crypto";
import type { UserContent } from "ai";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { Client, ClientError } from "eve/client";
import { conversations, customers, events, invoices, members, quotes } from "../schema/schema";
import type { AgentName } from "./agent-name";
import { memberConversationForSession, threadFor, upsertThread, type Conversation } from "./conversations";
import { db, newId } from "./db";
import { recordEvent } from "./events";
import { jobToken, type JobClaims } from "./job-token";
import type { Language } from "./language";
import { APP_JOB, isPrivileged, type Caller } from "./members";

// Jobs: side conversations the assistant opens from a member's thread for one piece of work (a quote,
// a customer issue), so the thread stays a clean index. Each job is a `conversations` row of kind `job`
// under the member's thread, with its own eve session. The assistant drives it server-side through the
// agent's own eve channel, signed as the member for that one job (job-token.ts); the member can also
// open it in the web app and chat in it directly. Jobs never open jobs. Members call them threads, and
// can start one from the web too (`startWebThread`), on its own or about a quote or customer.

export type Job = Conversation;
export type JobStatus = Job["status"];
/** `limited`: the business's usage limits refused the turn (core/usage-limits.ts); nothing ran. */
export type JobOutcome = { status: "replied" | "failed" | "limited"; reply: string | null };

const OPEN: JobStatus[] = ["active", "running", "failed"];
const TURN_TIMEOUT_MS = 8 * 60 * 1000;
const REPLY_EXCERPT = 280;

type Auth = { authenticator: string; attributes?: Record<string, unknown> } | null | undefined;

/** True when a turn runs inside a job: the assistant driving it, or the member chatting in it on the web. */
export function isJobAuth(auth: Auth): boolean {
  return auth?.authenticator === APP_JOB || auth?.attributes?.conversationKind === "job";
}

/** A job id that a retried tool call maps to the same job, instead of opening a second one. */
export function jobIdFor(sessionId: string, callId: string): string {
  return `job_${createHash("sha256").update(`job:${sessionId}:${callId}`).digest("hex").slice(0, 20)}`;
}

/**
 * The member's thread that this turn runs in: the conversation on this session, or (for a session no
 * thread tracks yet, like a local-dev one) the member's thread, made on this session if they have none.
 * Throws `JOB_IN_JOB` inside a job: a job can't open, list, or drive jobs.
 */
export async function callingThread(caller: Caller, auth: Auth, sessionId: string): Promise<Conversation> {
  if (isJobAuth(auth)) throw new Error("JOB_IN_JOB");
  const here = await memberConversationForSession(caller.orgId, caller.memberId, sessionId);
  if (here?.kind === "job") throw new Error("JOB_IN_JOB");
  if (here) return here;
  return (await threadFor(caller.orgId, caller.memberId)) ?? (await upsertThread(caller.orgId, caller.memberId, sessionId)).conversation;
}

/** The member's own job, or null: another member's or business's job is nobody's here. */
export async function getOwnJob(orgId: string, memberId: string, jobId: string): Promise<Job | null> {
  const [row] = await db()
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.orgId, orgId),
        eq(conversations.memberId, memberId),
        eq(conversations.kind, "job"),
        eq(conversations.id, jobId),
      ),
    );
  return row ?? null;
}

/** A job in this business, whoever's it is. For the web app's read-only views, which check who may look. */
export async function getJob(orgId: string, jobId: string): Promise<Job | null> {
  const [row] = await db()
    .select()
    .from(conversations)
    .where(and(eq(conversations.orgId, orgId), eq(conversations.kind, "job"), eq(conversations.id, jobId)));
  return row ?? null;
}

/** The job in this business on an eve session, whoever's it is, or null. */
export async function jobForSession(orgId: string, eveSessionId: string): Promise<Job | null> {
  const [row] = await db()
    .select()
    .from(conversations)
    .where(and(eq(conversations.orgId, orgId), eq(conversations.kind, "job"), eq(conversations.eveSessionId, eveSessionId)));
  return row ?? null;
}

/** The member's job to drive. Throws `JOB_NOT_FOUND` for anyone else's, `JOB_ARCHIVED` once put away. */
export async function requireOwnJob(caller: Caller, jobId: string): Promise<Job> {
  const job = await getOwnJob(caller.orgId, caller.memberId, jobId);
  if (!job) throw new Error("JOB_NOT_FOUND");
  if (job.status === "archived") throw new Error("JOB_ARCHIVED");
  return job;
}

async function checkLinks(caller: Caller, links: { quoteId?: string; customerId?: string; invoiceId?: string }): Promise<void> {
  // Invoices are owners' and admins' business.
  if (links.invoiceId && !isPrivileged(caller.role)) throw new Error("INVOICE_NOT_FOUND");
  if (links.quoteId) {
    const [quote] = await db()
      .select({ createdBy: quotes.createdByMemberId })
      .from(quotes)
      .where(and(eq(quotes.orgId, caller.orgId), eq(quotes.id, links.quoteId)));
    if (!quote) throw new Error("QUOTE_NOT_FOUND");
  }
  if (links.customerId) {
    const [customer] = await db()
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.orgId, caller.orgId), eq(customers.id, links.customerId)));
    if (!customer) throw new Error("CUSTOMER_NOT_FOUND");
  }
}

/**
 * Opens a job under the member's thread and records it in the thread's events. Idempotent by `id`
 * (from `jobIdFor`): a replay returns the job it opened before. Throws `QUOTE_NOT_FOUND` or
 * `CUSTOMER_NOT_FOUND` for a link outside what the member may see, and `TITLE_REQUIRED`.
 */
export async function openJob(
  caller: Caller,
  input: { id: string; thread: Conversation; title: string; quoteId?: string; customerId?: string; source?: "email"; emailKey?: string },
): Promise<Job> {
  if (input.thread.kind !== "thread" || input.thread.orgId !== caller.orgId || input.thread.memberId !== caller.memberId) {
    throw new Error("JOB_IN_JOB");
  }
  const title = input.title.trim().slice(0, 160);
  if (!title) throw new Error("TITLE_REQUIRED");
  await checkLinks(caller, input);
  await db()
    .insert(conversations)
    .values({
      id: input.id,
      orgId: caller.orgId,
      memberId: caller.memberId,
      kind: "job",
      parentId: input.thread.id,
      title,
      quoteId: input.quoteId ?? null,
      customerId: input.customerId ?? null,
      source: input.source ?? null,
      emailKey: input.emailKey ?? null,
    })
    .onConflictDoNothing({ target: conversations.id });
  const job = await getOwnJob(caller.orgId, caller.memberId, input.id);
  if (!job) throw new Error("JOB_NOT_FOUND");
  await recordEvent({
    orgId: caller.orgId,
    kind: "job.opened",
    key: `job.opened:${job.id}`,
    refId: job.id,
    memberId: caller.memberId,
    data: { threadId: job.parentId, title: job.title, quoteId: job.quoteId, customerId: job.customerId },
  });
  return job;
}

/** What a thread started on the web is for: it names the thread until there's something better. */
export type ThreadTopic = "new" | "quote" | "customer" | "pricebook" | "billing";

const TOPIC_TITLES: Record<Language, Record<ThreadTopic, string>> = {
  en: { new: "New thread", quote: "New quote", customer: "New customer", pricebook: "Price book", billing: "Billing" },
  es: { new: "Conversación nueva", quote: "Cotización nueva", customer: "Cliente nuevo", pricebook: "Precios", billing: "Cobros" },
};

/** The topic a thread was started for, read off the title it was given, while it still has that title. */
export function topicOfTitle(title: string | null): ThreadTopic | null {
  for (const titles of Object.values(TOPIC_TITLES)) {
    for (const [topic, stand] of Object.entries(titles)) if (stand === title) return topic as ThreadTopic;
  }
  return null;
}

/** A title only standing in until the thread's first message or quote names it. */
const STAND_IN_TITLES = new Set([TOPIC_TITLES.en.new, TOPIC_TITLES.es.new, TOPIC_TITLES.en.quote, TOPIC_TITLES.es.quote]);
const TITLE_FROM_MESSAGE = 60;

/**
 * Starts a thread from the web: a job under the member's thread, with its eve session made now so the
 * web can write in it straight away. About a quote, customer, or invoice, it's titled after it; `reuse`
 * returns the member's latest open thread about that same record instead, so "Ask about this" keeps one
 * going. Throws `NO_THREAD` before the member's first text (they have no assistant thread to hang it off),
 * and `QUOTE_NOT_FOUND` / `CUSTOMER_NOT_FOUND` / `INVOICE_NOT_FOUND` for a record outside what they may see.
 */
export async function startWebThread(
  caller: Caller,
  request: { topic?: ThreadTopic; quoteId?: string; customerId?: string; invoiceId?: string; reuse?: boolean },
): Promise<Job> {
  const thread = await threadFor(caller.orgId, caller.memberId);
  if (!thread) throw new Error("NO_THREAD");
  await checkLinks(caller, request);
  // About an invoice: titled after it ("INV-0003 · 1 Example St"), which tells the assistant which one,
  // and linked to its customer.
  const invoice = request.invoiceId ? await invoiceAbout(caller.orgId, request.invoiceId) : null;
  const input = invoice ? { ...request, invoiceId: undefined, customerId: invoice.customerId ?? undefined } : request;
  // "INV-0003", as invoices.ts labels it: importing that here makes an import cycle the agent build rejects.
  const invoiceTitle = invoice ? `INV-${String(invoice.number).padStart(4, "0")} · ${invoice.title}` : null;
  if (invoiceTitle && request.reuse) {
    const [latest] = await listing(
      and(
        eq(conversations.orgId, caller.orgId),
        eq(conversations.memberId, caller.memberId),
        eq(conversations.kind, "job"),
        inArray(conversations.status, OPEN),
        eq(conversations.title, invoiceTitle),
      ),
      1,
    );
    const job = latest ? await getOwnJob(caller.orgId, caller.memberId, latest.jobId) : null;
    if (job?.eveSessionId) return job;
  } else if (input.reuse && (input.quoteId || input.customerId)) {
    const [latest] = await listing(
      and(
        eq(conversations.orgId, caller.orgId),
        eq(conversations.memberId, caller.memberId),
        eq(conversations.kind, "job"),
        inArray(conversations.status, OPEN),
        input.quoteId ? eq(conversations.quoteId, input.quoteId) : eq(conversations.customerId, input.customerId!),
      ),
      1,
    );
    const job = latest ? await getOwnJob(caller.orgId, caller.memberId, latest.jobId) : null;
    if (job?.eveSessionId) return job;
  }
  const job = await openJob(caller, {
    id: newId("job"),
    thread,
    title: invoiceTitle ?? (await recordTitle(caller.orgId, input)) ?? TOPIC_TITLES[caller.language][input.topic ?? "new"],
    quoteId: input.quoteId,
    customerId: input.customerId,
  });
  const ready = await ensureSession(job, AbortSignal.timeout(30_000));
  return { ...job, eveSessionId: ready };
}

/** The invoice a thread is about, and the customer it's for (its own, or its quote's). Throws `INVOICE_NOT_FOUND`. */
async function invoiceAbout(orgId: string, invoiceId: string): Promise<{ number: number; title: string; customerId: string | null }> {
  const [row] = await db()
    .select({ number: invoices.number, title: invoices.title, customerId: invoices.customerId, quoteCustomerId: quotes.customerId })
    .from(invoices)
    .leftJoin(quotes, eq(quotes.id, invoices.quoteId))
    .where(and(eq(invoices.orgId, orgId), eq(invoices.id, invoiceId)));
  if (!row) throw new Error("INVOICE_NOT_FOUND");
  return { number: row.number, title: row.title, customerId: row.customerId ?? row.quoteCustomerId };
}

/** The quote's title or the customer's name, for a thread about one. */
async function recordTitle(orgId: string, about: { quoteId?: string; customerId?: string }): Promise<string | null> {
  if (about.quoteId) {
    const [quote] = await db().select({ title: quotes.title }).from(quotes).where(and(eq(quotes.orgId, orgId), eq(quotes.id, about.quoteId)));
    if (quote?.title) return quote.title;
  }
  if (about.customerId) {
    const [customer] = await db()
      .select({ name: customers.name })
      .from(customers)
      .where(and(eq(customers.orgId, orgId), eq(customers.id, about.customerId)));
    if (customer?.name) return customer.name;
  }
  return null;
}

/** The first line of what the member wrote, cut at a word, to name a thread by. */
export function titleFromMessage(text: string): string | null {
  const line = text.trim().split(/\r?\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (!line) return null;
  if (line.length <= TITLE_FROM_MESSAGE) return line;
  const cut = line.slice(0, TITLE_FROM_MESSAGE);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Names the member's thread after the first thing they write in it, while it still has a stand-in title
 * ("New thread", "Billing") and no quote. Never throws: the turn doesn't depend on it.
 */
export async function titleThreadFromMessage(caller: Caller, jobId: string, text: string): Promise<void> {
  try {
    const job = await getOwnJob(caller.orgId, caller.memberId, jobId);
    const renamed = [TOPIC_TITLES.en.new, TOPIC_TITLES.es.new, TOPIC_TITLES.en.billing, TOPIC_TITLES.es.billing];
    if (!job || job.quoteId || !job.title || !renamed.includes(job.title)) return;
    const title = titleFromMessage(text);
    if (!title) return;
    await db()
      .update(conversations)
      .set({ title })
      .where(and(eq(conversations.orgId, caller.orgId), eq(conversations.id, job.id), eq(conversations.title, job.title)));
  } catch (error) {
    console.error("jobs: naming a thread failed", error);
  }
}

// ---------------------------------------------------------------------------------------------
// Email threads: each email a member forwards gets a thread of its own (core/email-intake.ts)

const EMAIL_THREAD_DAYS = 60;

/** A subject without its "Re:" / "Fwd:" prefixes, spaces, or case: the same conversation's subject however it's replied to. */
export function baseSubject(subject: string): string {
  let text = subject.trim();
  for (;;) {
    const next = text.replace(/^\s*(re|fwd?|fw|rv|reenv(iar|iado)?|tr)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === text) break;
    text = next;
  }
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Which conversation an email belongs to: who wrote the original, and its subject (`baseSubject`). */
export function emailThreadKey(input: { senderAddress: string; subject: string }): string {
  return `${input.senderAddress.trim().toLowerCase()}|${baseSubject(input.subject)}`;
}

/**
 * The member's thread for this email's conversation (`emailThreadKey`) from the last 60 days, or null
 * for a new one. One they archived is left alone: the next email starts fresh.
 */
export async function emailThreadFor(caller: Caller, key: string, now: Date = new Date()): Promise<Job | null> {
  const [row] = await db()
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.orgId, caller.orgId),
        eq(conversations.memberId, caller.memberId),
        eq(conversations.kind, "job"),
        eq(conversations.source, "email"),
        eq(conversations.emailKey, key),
        sql`${conversations.status} <> 'archived'`,
        gt(conversations.createdAt, new Date(now.getTime() - EMAIL_THREAD_DAYS * 24 * 60 * 60 * 1000)),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Starts an email's turn in its thread and returns once eve has taken it: the reply arrives later, and
 * agents/assistant/agent/hooks/email-relay.ts texts it to the member. The turn carries the email's mark, the queue's
 * delivery, and the reservation it was admitted under (job-token.ts). The thread counts as unread again.
 */
export async function startEmailTurn(
  job: Job,
  content: string | UserContent,
  marks: { deliveryId?: string; reservationId?: string },
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const signal = options.signal ?? AbortSignal.timeout(60_000);
  const claims: JobClaims = { ...claimsFor(job), origin: "email", ...marks };
  // Done or not, the thread is open again and has news.
  await db()
    .update(conversations)
    .set({ status: "active", updatedAt: new Date() })
    .where(and(eq(conversations.orgId, job.orgId), eq(conversations.id, job.id), sql`${conversations.status} <> 'archived'`));
  const active = runner();
  if (!active.start) throw new Error("JOB_RUNNER_CANNOT_START");
  const start = active.start;
  await withLiveSession(job, signal, (sessionId) => start(claims, sessionId, content, { signal }));
}

/** The member opened their thread on the web: it isn't unread any more. Anyone else's is left alone. */
export async function markThreadSeen(orgId: string, memberId: string, jobId: string, now: Date = new Date()): Promise<void> {
  await db()
    .update(conversations)
    .set({ seenAt: now })
    .where(and(eq(conversations.orgId, orgId), eq(conversations.memberId, memberId), eq(conversations.kind, "job"), eq(conversations.id, jobId)));
}

/** How many of the member's email threads have news they haven't opened. */
export async function unreadEmailThreads(orgId: string, memberId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(conversations)
    .where(
      and(
        eq(conversations.orgId, orgId),
        eq(conversations.memberId, memberId),
        eq(conversations.kind, "job"),
        sql`${conversations.status} <> 'archived'`,
        unreadSql,
      ),
    );
  return row?.n ?? 0;
}

export type JobListing = {
  jobId: string;
  title: string;
  status: JobStatus;
  quoteId: string | null;
  quoteTitle: string | null;
  customerId: string | null;
  customerName: string | null;
  memberId: string;
  memberName: string;
  /** `email` for a thread a forwarded email started. */
  source: string | null;
  /** An email thread with news its member hasn't opened on the web. */
  unread: boolean;
  updatedAt: Date;
};

/** An email thread with something since its member last opened it. */
const unreadSql = sql<boolean>`(${conversations.source} = 'email' and (${conversations.seenAt} is null or ${conversations.seenAt} < ${conversations.updatedAt}))`;

function listing(where: ReturnType<typeof and>, limit: number) {
  return db()
    .select({
      jobId: conversations.id,
      title: sql<string>`coalesce(${conversations.title}, '')`,
      status: conversations.status,
      quoteId: conversations.quoteId,
      quoteTitle: quotes.title,
      customerId: conversations.customerId,
      customerName: customers.name,
      memberId: conversations.memberId,
      memberName: members.name,
      source: conversations.source,
      unread: sql<boolean>`coalesce(${unreadSql}, false)`,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .innerJoin(members, and(eq(members.orgId, conversations.orgId), eq(members.id, conversations.memberId)))
    .leftJoin(quotes, and(eq(quotes.orgId, conversations.orgId), eq(quotes.id, conversations.quoteId)))
    .leftJoin(customers, and(eq(customers.orgId, conversations.orgId), eq(customers.id, conversations.customerId)))
    .where(where)
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(limit);
}

/** One job in this business as a listing (with its quote's title and customer's name), whoever's it is. */
export async function jobListing(orgId: string, jobId: string): Promise<JobListing | null> {
  const [row] = await listing(and(eq(conversations.orgId, orgId), eq(conversations.kind, "job"), eq(conversations.id, jobId)), 1);
  return row ?? null;
}

/** The member's jobs, most recently active first: open ones by default, or every one but archived. */
export function listJobs(
  orgId: string,
  memberId: string,
  options: { include?: "open" | "all"; limit?: number; source?: "email" | "not_email" } = {},
): Promise<JobListing[]> {
  const statuses: JobStatus[] = options.include === "all" ? [...OPEN, "done"] : OPEN;
  return listing(
    and(
      eq(conversations.orgId, orgId),
      eq(conversations.memberId, memberId),
      eq(conversations.kind, "job"),
      inArray(conversations.status, statuses),
      options.source === "email"
        ? eq(conversations.source, "email")
        : options.source === "not_email"
          ? sql`${conversations.source} is distinct from 'email'`
          : undefined,
    ),
    options.limit ?? 25,
  );
}

/**
 * The jobs about one quote or customer that this caller may see: their own, and for an owner or admin
 * everyone's (to read). Crew see only their own. Archived jobs are left out.
 */
export function jobsAbout(caller: Pick<Caller, "orgId" | "memberId" | "role">, about: { quoteId: string } | { customerId: string }): Promise<JobListing[]> {
  const link = "quoteId" in about ? eq(conversations.quoteId, about.quoteId) : eq(conversations.customerId, about.customerId);
  return listing(
    and(
      eq(conversations.orgId, caller.orgId),
      eq(conversations.kind, "job"),
      link,
      inArray(conversations.status, [...OPEN, "done"]),
      isPrivileged(caller.role) ? undefined : eq(conversations.memberId, caller.memberId),
    ),
    25,
  );
}

/**
 * Whether this caller may read a job they don't own: an owner or admin, for a job in their business
 * about a quote or customer (both of which they see). Crew read only their own jobs.
 */
export function mayReadJob(caller: Pick<Caller, "orgId" | "memberId" | "role">, job: Job): boolean {
  if (job.orgId !== caller.orgId || job.kind !== "job") return false;
  if (job.memberId === caller.memberId) return true;
  return isPrivileged(caller.role) && (job.quoteId !== null || job.customerId !== null);
}

async function setStatus(job: Job, status: JobStatus): Promise<Job> {
  const [row] = await db()
    .update(conversations)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(conversations.orgId, job.orgId), eq(conversations.id, job.id)))
    .returning();
  return row ?? job;
}

/** Marks the member's job done or archived, or reopens it (`active`), and records it in the thread. */
export async function setJobStatus(caller: Caller, jobId: string, status: "done" | "archived" | "active"): Promise<Job> {
  const job = await getOwnJob(caller.orgId, caller.memberId, jobId);
  if (!job) throw new Error("JOB_NOT_FOUND");
  if (job.status === status) return job;
  const updated = await setStatus(job, status);
  await recordEvent({
    orgId: caller.orgId,
    kind: status === "active" ? "job.reopened" : `job.${status}`,
    refId: job.id,
    memberId: caller.memberId,
    data: { threadId: job.parentId, title: job.title },
  });
  return updated;
}

export type ThreadJobEvent = { kind: string; jobId: string; data: Record<string, unknown>; at: Date };

/** What the thread's jobs did, oldest first: opened, replied, done, archived, reopened. */
export async function threadJobEvents(orgId: string, threadId: string): Promise<ThreadJobEvent[]> {
  const rows = await db()
    .select({ kind: events.kind, refId: events.refId, data: events.data, at: events.createdAt })
    .from(events)
    .where(
      and(
        eq(events.orgId, orgId),
        sql`${events.kind} like 'job.%'`,
        sql`${events.data}->>'threadId' = ${threadId}`,
      ),
    )
    .orderBy(asc(events.createdAt), asc(events.id));
  return rows.map((row) => ({ kind: row.kind, jobId: row.refId ?? "", data: row.data, at: row.at }));
}

// ---------------------------------------------------------------------------------------------
// Running a job's turns

/** How a job's session is created and sent to. The default goes through the agent's own eve channel. */
export interface JobRunner {
  createSession(claims: JobClaims, options: { signal: AbortSignal }): Promise<string>;
  send(claims: JobClaims, sessionId: string, message: string, options: { signal: AbortSignal }): Promise<JobOutcome>;
  /** Hands a message to the session and returns once eve has it, without waiting for the reply. */
  start?(claims: JobClaims, sessionId: string, message: string | UserContent, options: { signal: AbortSignal }): Promise<void>;
}

/**
 * Where a client reaches an agent's eve routes. Under `eve dev` and `eve eval`, the assistant's own dev
 * server (eve's local workflow world sets `WORKFLOW_LOCAL_BASE_URL` to the server it runs in, so only
 * the assistant reaching itself ever sees it); otherwise the app's origin (`AGENT_URL` when set, then
 * `BETTER_AUTH_URL`, then the Vercel URL) and the agent's mount.
 */
export function agentHost(agent: AgentName = "assistant"): string {
  const pick = (value: string | undefined) => (value?.trim() ? new URL(value.trim()).origin : null);
  const own = agent === "assistant" && !process.env.AGENT_URL?.trim() ? pick(process.env.WORKFLOW_LOCAL_BASE_URL) : null;
  if (own) return own;
  const app =
    pick(process.env.AGENT_URL) ??
    pick(process.env.BETTER_AUTH_URL) ??
    (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000");
  return `${app}/eve/${agent}`;
}

/** The URL of one of an agent's own routes, written as eve writes them (`/eve/v1/...`). */
export function agentRoute(path: `/eve/v1/${string}`, agent: AgentName = "assistant"): string {
  const host = agentHost(agent);
  return host.endsWith(`/eve/${agent}`) ? `${host}${path.slice("/eve".length)}` : `${host}${path}`;
}

const FAILED_EVENTS = new Set(["turn.failed", "turn.cancelled", "session.failed"]);

function eveClient(claims: JobClaims): Client {
  // A fresh token per request: a long turn's stream reconnects outlive one token.
  return new Client({ host: agentHost(), redirect: "error", auth: { bearer: () => jobToken(claims) } });
}

export const eveJobRunner: JobRunner = {
  async createSession(claims, { signal }) {
    const { session } = await eveClient(claims).sessions.create({ signal });
    return session.state.sessionId;
  },
  async send(claims, sessionId, message, { signal }) {
    let response;
    try {
      response = await eveClient(claims).sessions.attach(sessionId).send(message, { turnPolicy: "queue", signal });
    } catch (error) {
      if (error instanceof ClientError && error.status === 429) return { status: "limited", reply: null };
      throw error;
    }
    const result = await response.result();
    const failed = result.status === "failed" || result.events.some((event) => FAILED_EVENTS.has(event.type));
    return { status: failed ? "failed" : "replied", reply: result.message?.trim() || null };
  },
  async start(claims, sessionId, message, { signal }) {
    // The POST returning means eve took the turn; its stream is read only by whoever asks for it.
    await eveClient(claims).sessions.attach(sessionId).send(message, { turnPolicy: "queue", signal });
  },
};

let runnerOverride: JobRunner | null = null;
/** Tests swap the runner for one that needs no eve server. Pass null to restore the default. */
export function setJobRunnerForTests(runner: JobRunner | null): void {
  runnerOverride = runner;
}
const runner = () => runnerOverride ?? eveJobRunner;

const claimsFor = (job: Job): JobClaims => ({ orgId: job.orgId, memberId: job.memberId, conversationId: job.id });

/** The job's eve session, created on first use. A concurrent create loses to the one recorded first. */
async function ensureSession(job: Job, signal: AbortSignal): Promise<string> {
  if (job.eveSessionId) return job.eveSessionId;
  const created = await runner().createSession(claimsFor(job), { signal });
  await db()
    .update(conversations)
    .set({ eveSessionId: created, updatedAt: new Date() })
    .where(and(eq(conversations.orgId, job.orgId), eq(conversations.id, job.id), isNull(conversations.eveSessionId)));
  const [row] = await db()
    .select({ eveSessionId: conversations.eveSessionId })
    .from(conversations)
    .where(and(eq(conversations.orgId, job.orgId), eq(conversations.id, job.id)));
  if (!row?.eveSessionId) throw new Error("JOB_SESSION_FAILED");
  return row.eveSessionId;
}

/**
 * The job, with an eve session to talk in: one it has, or a fresh one when it has none (a job whose old
 * session was retired). Archived jobs are left as they are.
 */
export async function jobWithSession(job: Job): Promise<Job> {
  if (job.eveSessionId || job.status === "archived") return job;
  return { ...job, eveSessionId: await ensureSession(job, AbortSignal.timeout(30_000)) };
}

/**
 * eve has no such session (404), it has ended (409 `session_not_active`), or no deployment can ever run
 * it (409 `session_stranded`: an agent or eve version that's gone built it).
 */
const GONE_CODES = new Set(["session_not_active", "session_stranded"]);
function sessionGone(error: unknown): boolean {
  if (!(error instanceof ClientError)) return false;
  return error.status === 404 || (error.status === 409 && GONE_CODES.has(error.code ?? ""));
}

/**
 * Runs `use` on the job's session. When eve no longer has it (sessions started before the assistant
 * became `agents/assistant` belong to an agent nothing runs, and a local dev store can be wiped), the job
 * takes a fresh session and `use` runs once more on that. The job's own record of what was said stays.
 */
async function withLiveSession<T>(job: Job, signal: AbortSignal, use: (sessionId: string) => Promise<T>): Promise<T> {
  const sessionId = await ensureSession(job, signal);
  try {
    return await use(sessionId);
  } catch (error) {
    if (!sessionGone(error)) throw error;
    console.warn("jobs: the job's eve session is gone; starting a fresh one", { jobId: job.id, sessionId });
    await db()
      .update(conversations)
      .set({ eveSessionId: null, updatedAt: new Date() })
      .where(and(eq(conversations.orgId, job.orgId), eq(conversations.id, job.id), eq(conversations.eveSessionId, sessionId)));
    return use(await ensureSession({ ...job, eveSessionId: null }, signal));
  }
}

/**
 * Links the job this turn runs in (if any) to a quote its member just created or revised there, unless
 * it's about a quote already, so the job shows on that quote's page. Also takes the quote's customer
 * when the job has none, and its title when the job's is only a stand-in ("New quote"). Never throws: a
 * quote tool's result doesn't depend on it.
 */
export async function linkJobToQuote(caller: Caller, auth: Auth, quoteId: string): Promise<void> {
  const conversationId = auth?.attributes?.conversationId;
  if (!isJobAuth(auth) || typeof conversationId !== "string") return;
  try {
    const job = await getOwnJob(caller.orgId, caller.memberId, conversationId);
    if (!job || job.quoteId) return;
    const [quote] = await db()
      .select({ customerId: quotes.customerId, title: quotes.title })
      .from(quotes)
      .where(and(eq(quotes.orgId, caller.orgId), eq(quotes.id, quoteId)));
    if (!quote) return;
    // A thread still called "New quote" (or "New thread") takes its quote's title.
    const retitle = STAND_IN_TITLES.has(job.title ?? "") && quote.title ? { title: quote.title } : {};
    await db()
      .update(conversations)
      .set({ quoteId, customerId: job.customerId ?? quote.customerId, ...retitle })
      .where(and(eq(conversations.orgId, caller.orgId), eq(conversations.id, job.id), isNull(conversations.quoteId)));
  } catch (error) {
    console.error("jobs: linking a job to its quote failed", error);
  }
}

/**
 * Sends one message into the member's job as them and waits for its reply. The job is `running`
 * meanwhile, then `active` again (a done job reopens), or `failed` when the turn failed. Each turn is
 * recorded in the thread's events, once per `operationId`. Throws only for a job the caller can't drive.
 */
export async function runJobTurn(
  caller: Caller,
  jobId: string,
  message: string,
  options: { operationId: string; signal?: AbortSignal },
): Promise<JobOutcome & { job: Job }> {
  let job = await requireOwnJob(caller, jobId);
  const text = message.trim();
  if (!text) throw new Error("MESSAGE_REQUIRED");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TURN_TIMEOUT_MS)]) : AbortSignal.timeout(TURN_TIMEOUT_MS);
  job = await setStatus(job, "running");
  let outcome: JobOutcome;
  try {
    outcome = await withLiveSession(job, signal, (sessionId) => runner().send(claimsFor(job), sessionId, text, { signal }));
  } catch (error) {
    console.error("jobs: a job turn failed", { jobId: job.id, error });
    outcome = { status: "failed", reply: null };
  }
  job = await setStatus(job, outcome.status === "failed" ? "failed" : "active");
  if (outcome.status === "limited") console.info("jobs: a job turn was held back by the usage limits", { jobId: job.id, orgId: caller.orgId });
  await recordEvent({
    orgId: caller.orgId,
    kind: "job.replied",
    key: `job.turn:${options.operationId}`,
    refId: job.id,
    memberId: caller.memberId,
    data: { threadId: job.parentId, title: job.title, status: outcome.status, reply: outcome.reply?.slice(0, REPLY_EXCERPT) ?? null },
  });
  return { ...outcome, job };
}

/** The context lines a job's turn gets on top of the member's usual ones. */
export function jobContextLines(job: Pick<Job, "title" | "quoteId" | "customerId">, from: "assistant" | "web" | "email"): string[] {
  const about = [job.quoteId ? `quote ${job.quoteId}` : null, job.customerId ? `customer ${job.customerId}` : null].filter(Boolean).join(" and ");
  return [
    `This is a thread (a job): a separate conversation for one piece of work, "${job.title ?? ""}"${about ? `, about ${about}` : ""}. Work only on that here. You can't open, list, or continue other threads from here. Members call these threads.`,
    job.quoteId
      ? "Read that quote with get_quote and change it with revise_quote; don't start a new quote for it."
      : topicOfTitle(job.title) === "quote"
        ? "The member started this thread for a new quote: make one with create_quote, even when the customer has other quotes. Change an existing quote only if they ask for that."
        : "If the work is on a quote that already exists (check list_quotes), change that one with revise_quote instead of starting another.",
    from === "assistant"
      ? "The member's assistant thread sent this message for them, and it relays your reply back to them by text. Answer in a line or two, and ask what you need in one message."
      : from === "email"
        ? "This thread is for an email the member forwarded, and every later email about the same thing comes here too."
        : "The member wrote this on the web, in the thread itself. Your reply shows only there, never by text.",
  ];
}
