import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { conversations } from "../schema/schema";
import { db, newId } from "./db";
import { findMemberById } from "./members";

export type Conversation = typeof conversations.$inferSelect;

/**
 * Records the member's iMessage session as their thread: creates the thread on their first text, and
 * moves it to a new session when Photon starts one (a new iMessage thread, say). A thread started on
 * the web keeps its session: texts join it (`handleInbound`). The web app resumes
 * whichever session the thread points at. `created` is true only for the call that made the thread.
 * Throws `MEMBER_NOT_FOUND` for a member outside this business.
 */
export async function upsertThread(
  orgId: string,
  memberId: string,
  eveSessionId: string,
): Promise<{ created: boolean; conversation: Conversation }> {
  if (!(await findMemberById(orgId, memberId))) throw new Error("MEMBER_NOT_FOUND");
  const [row] = await db()
    .insert(conversations)
    .values({ id: newId("conv"), orgId, memberId, kind: "thread", eveSessionId })
    .onConflictDoUpdate({
      target: [conversations.orgId, conversations.memberId],
      targetWhere: sql`${conversations.kind} = 'thread'`,
      set: { eveSessionId, updatedAt: new Date() },
    })
    .returning({ ...getTableColumns(conversations), created: sql<boolean>`(xmax = 0)` });
  const { created, ...conversation } = row;
  return { created, conversation };
}

/**
 * Records a session the web app started as the member's thread, unless they already have one (a text
 * that arrived meanwhile started it): the thread comes back either way, and its session is the one to
 * use. Throws `MEMBER_NOT_FOUND` for a member outside this business.
 */
export async function startThread(orgId: string, memberId: string, eveSessionId: string): Promise<Conversation> {
  if (!(await findMemberById(orgId, memberId))) throw new Error("MEMBER_NOT_FOUND");
  await db()
    .insert(conversations)
    .values({ id: newId("conv"), orgId, memberId, kind: "thread", eveSessionId })
    .onConflictDoNothing({ target: [conversations.orgId, conversations.memberId], where: sql`${conversations.kind} = 'thread'` });
  const thread = await threadFor(orgId, memberId);
  if (!thread) throw new Error("THREAD_NOT_STARTED");
  return thread;
}

/**
 * Moves the member's thread from `from`, a session eve no longer runs, to `to`, and returns the thread.
 * A thread that has meanwhile moved on (a text started a new session) keeps the session it has.
 */
export async function moveThreadSession(orgId: string, memberId: string, from: string, to: string): Promise<Conversation | null> {
  await db()
    .update(conversations)
    .set({ eveSessionId: to, updatedAt: new Date() })
    .where(
      and(
        eq(conversations.orgId, orgId),
        eq(conversations.memberId, memberId),
        eq(conversations.kind, "thread"),
        eq(conversations.eveSessionId, from),
      ),
    );
  return threadFor(orgId, memberId);
}

/** The member's thread, or null before it starts: their first text, or their first visit to Home. */
export async function threadFor(orgId: string, memberId: string): Promise<Conversation | null> {
  const [row] = await db()
    .select()
    .from(conversations)
    .where(and(eq(conversations.orgId, orgId), eq(conversations.memberId, memberId), eq(conversations.kind, "thread")));
  return row ?? null;
}

/** The member's own conversation on this eve session, or null when the session isn't theirs. */
export async function memberConversationForSession(
  orgId: string,
  memberId: string,
  eveSessionId: string,
): Promise<Conversation | null> {
  const [row] = await db()
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.orgId, orgId),
        eq(conversations.memberId, memberId),
        eq(conversations.eveSessionId, eveSessionId),
      ),
    );
  return row ?? null;
}

/**
 * Local development and evals only (`localDevThread` in lib/eve-auth.ts): whose thread this eve session
 * is, found by the session alone, so a local turn can run as that member. Production never calls it.
 */
export async function threadOwnerForLocalDev(eveSessionId: string): Promise<{ orgId: string; memberId: string } | null> {
  const [row] = await db()
    .select({ orgId: conversations.orgId, memberId: conversations.memberId })
    .from(conversations)
    .where(and(eq(conversations.eveSessionId, eveSessionId), eq(conversations.kind, "thread")));
  return row ?? null;
}
