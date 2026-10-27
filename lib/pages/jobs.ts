import { and, count, eq, gt } from "drizzle-orm";
import { conversations } from "../../schema/schema";
import { db } from "../../core/db";
import {
  getJob,
  jobListing,
  jobWithSession,
  jobsAbout,
  listJobs,
  markThreadSeen,
  mayReadJob,
  setJobStatus,
  startWebThread,
  topicOfTitle,
  type Job,
  type JobListing,
  type ThreadTopic,
  unreadEmailThreads,
} from "../../core/jobs";
import { HttpError, memberCaller, type AppCaller } from "../guards";
import { notFound, refuse } from "./access";

// Who may see and do what with jobs on the web. A job is its member's: only they write in it or close
// it. An owner or admin may read a crew member's job about a quote or customer (they see all of
// those). Crew see only their own. A super admin's look-only view sees no one's conversations.

export const JOB_STATUSES_SET_FROM_APP = ["done", "archived", "active"] as const;
export type JobStatusFromApp = (typeof JOB_STATUSES_SET_FROM_APP)[number];

/** The signed-in member's threads, open ones first by recency, then done ones; or only their email threads. Nobody's for a super admin. */
export async function myJobs(caller: AppCaller, options: { source?: "email" } = {}): Promise<JobListing[]> {
  if (!caller.memberId) return [];
  return listJobs(caller.orgId, caller.memberId, { include: "all", limit: 100, source: options.source });
}

export type JobPage = {
  job: Job;
  /** Its title, status, member, and the quote and customer it's about. */
  listing: JobListing;
  /** The viewer's own job: they can chat in it and close it. Otherwise they only read it. */
  mine: boolean;
};

/** One job, for its member or an owner or admin allowed to read it; a 404 for anyone else. Its member opening it reads it. */
export async function jobFor(caller: AppCaller, jobId: string): Promise<JobPage> {
  if (!caller.memberId) throw notFound();
  const job = await getJob(caller.orgId, jobId);
  if (!job || job.status === "archived" && job.memberId !== caller.memberId) throw notFound();
  if (!mayReadJob({ ...caller, memberId: caller.memberId }, job)) throw notFound();
  const mine = job.memberId === caller.memberId;
  // Their own thread, open with no session (its old one was retired), gets one to talk in, before it's
  // marked seen: starting one counts as news.
  const ready = mine ? await jobWithSession(job) : job;
  const [listing] = await Promise.all([jobListing(caller.orgId, job.id), mine ? markThreadSeen(caller.orgId, caller.memberId, job.id) : null]);
  if (!listing) throw notFound();
  return { job: ready, listing, mine };
}

/** The jobs about a quote or customer the caller may see. The page checks the quote or customer first. */
export async function jobsOn(caller: AppCaller, about: { quoteId: string } | { customerId: string }): Promise<JobListing[]> {
  if (!caller.memberId) return [];
  return jobsAbout({ ...caller, memberId: caller.memberId }, about);
}

/** The member marks their own job done or archived, or reopens it. Anyone else's is a 404. */
export async function setJobStatusFromApp(caller: AppCaller, jobId: string, status: JobStatusFromApp): Promise<Job> {
  const actor = memberCaller(caller);
  try {
    return await setJobStatus(actor, jobId, status);
  } catch (error) {
    refuse(error, { JOB_NOT_FOUND: [404, "That isn't here."] });
  }
}

/** A thread as the web app's chat panel and sidebar show it. */
export type ThreadJson = {
  id: string;
  title: string;
  status: Job["status"];
  /** Its eve session; null only for a job the assistant opened that hasn't started. */
  sessionId: string | null;
  quote: { id: string; title: string } | null;
  customer: { id: string; name: string } | null;
  memberName: string;
  /** The viewer's own thread: they write in it. Otherwise they only read it. */
  mine: boolean;
  /** What it was started for, while it still has the title it started with: the empty thread prompts for it. */
  topic: ThreadTopic | null;
  updatedAt: string;
};

function threadJson(listing: JobListing, sessionId: string | null, mine: boolean): ThreadJson {
  return {
    id: listing.jobId,
    title: listing.title,
    status: listing.status,
    sessionId,
    quote: listing.quoteId ? { id: listing.quoteId, title: listing.quoteTitle ?? "" } : null,
    customer: listing.customerId ? { id: listing.customerId, name: listing.customerName ?? "" } : null,
    memberName: listing.memberName,
    mine,
    topic: topicOfTitle(listing.title),
    updatedAt: listing.updatedAt.toISOString(),
  };
}

const RECENT_THREADS = 8;

/**
 * The member's open threads, most recent first, for the sidebar, and how many of their email threads
 * have news. Email threads aren't among the recent ones: they have their own place, so a busy inbox
 * doesn't push the member's own work out. Nothing for a super admin.
 */
export async function recentThreads(caller: AppCaller): Promise<{ threads: ThreadJson[]; emailUnread: number }> {
  if (!caller.memberId) return { threads: [], emailUnread: 0 };
  const [jobs, emailUnread] = await Promise.all([
    listJobs(caller.orgId, caller.memberId, { limit: RECENT_THREADS, source: "not_email" }),
    unreadEmailThreads(caller.orgId, caller.memberId),
  ]);
  return { threads: jobs.map((job) => threadJson(job, null, true)), emailUnread };
}

/** One thread for the chat panel, for whoever may read it (`jobFor`); a 404 for anyone else. */
export async function threadView(caller: AppCaller, jobId: string): Promise<ThreadJson> {
  const { job, listing, mine } = await jobFor(caller, jobId);
  return threadJson(listing, job.eveSessionId, mine);
}

/** How many threads one member may start from the web in an hour: plenty for people, not for a script. */
const STARTS_PER_HOUR = 30;

/**
 * The member starts a thread from the web: on its own, for a new quote or customer, or about a quote
 * or customer they can see. "Ask about this" (`reuse`) reopens their latest open thread on that record.
 */
export async function startThreadFromApp(
  caller: AppCaller,
  input: { topic?: ThreadTopic; quoteId?: string; customerId?: string; invoiceId?: string; reuse?: boolean },
): Promise<ThreadJson> {
  const actor = memberCaller(caller);
  const [recent] = await db()
    .select({ n: count() })
    .from(conversations)
    .where(
      and(
        eq(conversations.orgId, actor.orgId),
        eq(conversations.memberId, actor.memberId),
        eq(conversations.kind, "job"),
        gt(conversations.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
      ),
    );
  if ((recent?.n ?? 0) >= STARTS_PER_HOUR) throw new HttpError(429, "TOO_MANY_THREADS", "That's a lot of new threads this hour. Try again later.");
  try {
    const job = await startWebThread(actor, input);
    return await threadView(caller, job.id);
  } catch (error) {
    refuse(error, {
      NO_THREAD: [409, "Text the assistant first. Your threads hang off that conversation."],
      QUOTE_NOT_FOUND: [404, "That isn't here."],
      CUSTOMER_NOT_FOUND: [404, "That isn't here."],
      INVOICE_NOT_FOUND: [404, "That isn't here."],
      JOB_SESSION_FAILED: [502, "The thread didn't start. Try again."],
    });
  }
}
