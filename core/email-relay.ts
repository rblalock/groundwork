import { and, eq } from "drizzle-orm";
import { conversations } from "../schema/schema";
import { db } from "./db";
import { recordEvent } from "./events";
import { getOwnJob } from "./jobs";
import { isLanguage, type Language } from "./language";
import { APP_JOB, findMemberById } from "./members";
import { queueNotice } from "./followups";
import { postToMember } from "./outbound";

// An email's turn runs in its own thread (core/email-intake.ts), where no channel posts the reply.
// This texts it to the member, as a reply in their main conversation would have been: once per reply,
// headed with the thread it's from. A turn that fails says so instead, so the email isn't lost quietly.
// Forwards can be automatic, so in quiet hours the text waits as a notice until they end, unless the
// member reads the thread on the web first.

type Session = { id: string; auth: { current?: { authenticator?: string; attributes?: Record<string, unknown> } | null }; parent?: unknown };
type Event = { type: string; meta: { id: string }; data?: unknown };

const str = (value: unknown) => (typeof value === "string" && value ? value : null);

/** The heading on an email thread's texts: which thread the reply is about. */
export function emailReplyText(title: string, reply: string, language: Language): string {
  return `${language === "es" ? "Correo" : "Email"} · ${title}\n${reply}`;
}

export function emailFailedText(title: string, language: Language): string {
  return language === "es"
    ? `No terminé con el correo "${title}". Está en Correo en la web; vuelve a intentarlo ahí.`
    : `I couldn't finish with the email "${title}". It's under Email on the web; try it again there.`;
}

/** Texts an email thread's reply (`message.completed`) or that its turn failed (`turn.failed`). Never throws. */
export async function relayEmailTurn(event: Event, session: Session): Promise<{ posted: boolean }> {
  try {
    const auth = session.auth.current;
    if (session.parent || auth?.authenticator !== APP_JOB || auth.attributes?.origin !== "email") return { posted: false };
    const orgId = str(auth.attributes.orgId);
    const memberId = str(auth.attributes.memberId);
    const conversationId = str(auth.attributes.conversationId);
    if (!orgId || !memberId || !conversationId) return { posted: false };
    const data = (event.data ?? {}) as Record<string, unknown>;
    let reply: string | null = null;
    if (event.type === "message.completed") {
      // A message that ends in tool calls is the model thinking aloud; only replies are texted.
      if (data.finishReason === "tool-calls") return { posted: false };
      reply = str(typeof data.message === "string" ? data.message.trim() : null);
      if (!reply) return { posted: false };
    } else if (event.type !== "turn.failed") {
      return { posted: false };
    }
    // Once per event, however many times eve delivers it.
    const { inserted } = await recordEvent({ orgId, kind: "email.relayed", key: `email.relay:${event.meta.id}`, refId: conversationId, memberId });
    if (!inserted) return { posted: false };
    const [job, member] = await Promise.all([getOwnJob(orgId, memberId, conversationId), findMemberById(orgId, memberId)]);
    if (!job || !member) return { posted: false };
    const language: Language = isLanguage(member.language) ? member.language : "en";
    const title = job.title ?? "";
    // News in the thread: it counts as unread on the web until they open it.
    await db().update(conversations).set({ updatedAt: new Date() }).where(and(eq(conversations.orgId, orgId), eq(conversations.id, job.id)));
    const text = reply ? emailReplyText(title, reply, language) : emailFailedText(title, language);
    const now = new Date();
    const result = await postToMember(orgId, memberId, { text }, "proactive", { now });
    if (!result.posted && result.reason === "quiet_hours") {
      await queueNotice({ orgId, memberId, quoteId: null, payload: { text, asksApproval: false, conversationId: job.id }, now });
    }
    return { posted: result.posted };
  } catch (error) {
    console.error("email relay: a reply was not texted", { eveSessionId: session.id, error });
    return { posted: false };
  }
}
