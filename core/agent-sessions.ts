import { and, eq } from "drizzle-orm";
import { agentSessions } from "../schema/schema";
import type { AgentName } from "./agent-name";
import { db } from "./db";

// A member's conversation with one of the app's agents other than the assistant, one per subject (the
// designer's for each customer page). Its eve session is created on first use; the agent's eve channel
// lets a member into a session only when it's recorded here as theirs.

export type AgentSession = typeof agentSessions.$inferSelect;
type Who = { orgId: string; memberId: string };

/** The member's session with `agent` about `subject`, or null before it's been started. */
export async function agentSessionFor(who: Who, agent: AgentName, subject: string): Promise<AgentSession | null> {
  const [row] = await db()
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.orgId, who.orgId),
        eq(agentSessions.memberId, who.memberId),
        eq(agentSessions.agent, agent),
        eq(agentSessions.subject, subject),
      ),
    );
  return row ?? null;
}

/** The session `eveSessionId` with `agent`, when it's this member's; null for anyone else's. */
export async function ownAgentSession(who: Who, agent: AgentName, eveSessionId: string): Promise<AgentSession | null> {
  const [row] = await db()
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.orgId, who.orgId),
        eq(agentSessions.memberId, who.memberId),
        eq(agentSessions.agent, agent),
        eq(agentSessions.eveSessionId, eveSessionId),
      ),
    );
  return row ?? null;
}

/**
 * The member's session with `agent` about `subject`, created with `create` when there's none. Two
 * creates at once both make an eve session; the one recorded first is kept, the other is left unused.
 */
export async function ensureAgentSession(who: Who, agent: AgentName, subject: string, create: () => Promise<string>): Promise<string> {
  const existing = await agentSessionFor(who, agent, subject);
  if (existing) return existing.eveSessionId;
  const created = await create();
  await db()
    .insert(agentSessions)
    .values({ orgId: who.orgId, memberId: who.memberId, agent, subject, eveSessionId: created })
    .onConflictDoNothing({ target: [agentSessions.orgId, agentSessions.memberId, agentSessions.agent, agentSessions.subject] });
  const kept = await agentSessionFor(who, agent, subject);
  if (!kept) throw new Error("AGENT_SESSION_FAILED");
  return kept.eveSessionId;
}

/** Forgets a session of the member's that eve no longer has, so the next open starts a fresh one. */
export async function forgetAgentSession(who: Who, agent: AgentName, eveSessionId: string): Promise<void> {
  await db()
    .delete(agentSessions)
    .where(
      and(
        eq(agentSessions.orgId, who.orgId),
        eq(agentSessions.memberId, who.memberId),
        eq(agentSessions.agent, agent),
        eq(agentSessions.eveSessionId, eveSessionId),
      ),
    );
}
