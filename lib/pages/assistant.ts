import { and, desc, eq, inArray, notLike } from "drizzle-orm";
import { Client } from "eve/client";
import { messages } from "../../schema/schema";
import { memberConversationForSession, moveThreadSession, threadFor, type Conversation } from "../../core/conversations";
import { db } from "../../core/db";
import { agentHost, replaceJobSession } from "../../core/jobs";
import { memberCaller, type AppCaller } from "../guards";
import { CODE_MASK } from "../login-codes";
import { probeSaysLost } from "../session-recovery";

// The Assistant page's other half: what the assistant texted the member on its own (the morning line,
// nudges, booking notices, approval requests, quote and invoice PDFs, fixed replies). Those are logged
// in `messages` but aren't turns of the member's eve session, so the page shows them beside the session,
// by time. Read-only, and only the signed-in member's own, in the open business. Left out: the
// session's own replies (`assistant`, which the session already shows), what the member sent, and
// sign-in code notices, which never show on the web.

/** The newest texts the page loads. */
export const TEXTED_LIMIT = 200;

export type TextedJson = {
  id: string;
  /** ISO time it was sent. */
  at: string;
  kind: "proactive" | "system";
  /** The text, or empty for a file sent alone. */
  text: string;
  /** A file it carried: a PDF, linked where there's somewhere to open it. */
  file: { name: string; href: string | null } | null;
};

const squash = (value: string) => value.replace(/\s+/g, "");

/** A stored file's URL the browser can open. Local stand-ins (`fake://`, `file://`) can't be. */
function openable(url: string | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

type Row = Pick<typeof messages.$inferSelect, "id" | "body" | "kind" | "createdAt" | "quoteId" | "attachments">;

/**
 * Logged rows as the thread shows them. A text with a file is logged as its text's rows and then a
 * file row repeating the text: they show once, as the file with its text.
 */
export function presentTexted(rows: Row[]): TextedJson[] {
  const out: TextedJson[] = [];
  for (const row of rows) {
    if (row.kind !== "proactive" && row.kind !== "system") continue;
    const attached = row.attachments.find((a) => a.type === "file");
    // Rows from before files were logged with their URL: a quote's PDF sent alone logs its file name.
    const legacyPdf = !attached && row.quoteId !== null && /\.pdf$/i.test(row.body.trim());
    if (!attached && !legacyPdf) {
      out.push({ id: row.id, at: row.createdAt.toISOString(), kind: row.kind, text: row.body, file: null });
      continue;
    }
    const name = attached?.name ?? row.body.trim();
    const href = openable(attached?.url) ?? (row.quoteId ? `/api/quotes/${encodeURIComponent(row.quoteId)}/pdf` : null);
    const text = row.body.trim() === name ? "" : row.body;
    // Fold the text rows just before it that spell out this row's text.
    if (text) {
      const whole = squash(text);
      let joined = "";
      let take = 0;
      for (let i = out.length - 1; i >= 0 && !out[i].file; i--) {
        joined = squash(out[i].text) + joined;
        if (!whole.endsWith(joined)) break;
        if (joined === whole) {
          take = out.length - i;
          break;
        }
      }
      if (take) out.splice(out.length - take, take);
    }
    out.push({ id: row.id, at: row.createdAt.toISOString(), kind: row.kind, text, file: { name, href } });
  }
  return out;
}

/** The signed-in member's texts from the assistant, oldest first. Super admins have no thread here. */
export async function textedFor(caller: AppCaller, input: { limit?: number } = {}): Promise<TextedJson[]> {
  const member = memberCaller(caller);
  const rows = await db()
    .select({
      id: messages.id,
      body: messages.body,
      kind: messages.kind,
      createdAt: messages.createdAt,
      quoteId: messages.quoteId,
      attachments: messages.attachments,
    })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, member.orgId),
        eq(messages.memberId, member.memberId),
        eq(messages.direction, "outbound"),
        inArray(messages.kind, ["proactive", "system"]),
        notLike(messages.body, `%${CODE_MASK}%`),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(input.limit ?? TEXTED_LIMIT);
  rows.reverse();
  return presentTexted(rows);
}

/**
 * The signed-in member's thread, started on their first visit when they haven't texted yet. The agent
 * starts it on the Photon channel (agents/assistant/agent/channels/photon.ts), so a text from them later
 * joins it, and checks the member by their own sign-in (`cookie`). Null when it couldn't be started.
 */
export async function threadWithSession(caller: AppCaller, cookie: string): Promise<Conversation | null> {
  const member = memberCaller(caller);
  const thread = await threadFor(member.orgId, member.memberId);
  if (thread?.eveSessionId) return thread;
  try {
    const client = new Client({ host: agentHost(), redirect: "error", headers: { cookie } });
    const response = await client.fetch("/eve/v1/photon/thread", { method: "POST", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`the thread route answered ${response.status}`);
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    console.error("assistant: the member's thread did not start", { orgId: member.orgId, memberId: member.memberId, error });
    return null;
  }
  return threadFor(member.orgId, member.memberId);
}

/**
 * A fresh session for the member's thread or job on `lost`, after a send there was refused as if eve no
 * longer runs it (lib/session-recovery.ts). The old session is probed first, with the member's own
 * sign-in (`cookie`): one eve still runs is kept, and so is anything not one of their writable
 * conversations. Null when it's kept or can't be replaced.
 *
 * A job takes a fresh session as the assistant gives one (core/jobs.ts). The thread is the member's
 * iMessage session too, held at their address on the Photon channel, so it's only replaced in
 * development: there a run the dev server won't resume keeps that address, and the thread moves to a
 * session started here, for the web. Texts reach the old one again only once the dev store is cleared.
 * In production eve hands an idle session to each new deployment, so a redeploy loses none.
 */
export async function replaceLostSession(caller: AppCaller, lost: string, cookie: string): Promise<string | null> {
  const member = memberCaller(caller);
  const conversation = await memberConversationForSession(member.orgId, member.memberId, lost);
  if (!conversation || (conversation.kind === "job" && conversation.status === "archived")) return null;
  const development = process.env.NODE_ENV === "development";
  if (conversation.kind === "thread" && !development) return null;
  if (!(await sessionLost(lost, cookie, development))) return null;
  if (conversation.kind === "job") return replaceJobSession(conversation, lost);
  console.warn("assistant: the dev server no longer runs the member's thread; starting a fresh one", { memberId: member.memberId, sessionId: lost });
  // No cookie: eve's local-dev sign-in, which runs the thread's turns as its member (lib/eve-auth.ts).
  const { session } = await new Client({ host: agentHost(), redirect: "error" }).sessions.create({ signal: AbortSignal.timeout(20_000) });
  const thread = await moveThreadSession(member.orgId, member.memberId, lost, session.state.sessionId);
  return thread?.eveSessionId ?? null;
}

/** Cancels a turn the session never had: a session eve runs ignores it, and one it can't fails as a send did. */
async function sessionLost(sessionId: string, cookie: string, development: boolean): Promise<boolean> {
  const client = new Client({ host: agentHost(), redirect: "error", headers: { cookie } });
  const response = await client
    .fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId: "turn_none" }),
      signal: AbortSignal.timeout(10_000),
    })
    .catch(() => null);
  if (!response) return false;
  const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
  return probeSaysLost(response.status, typeof body?.code === "string" ? body.code : undefined, development);
}
