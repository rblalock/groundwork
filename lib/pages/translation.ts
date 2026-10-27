import { and, eq } from "drizzle-orm";
import { Client, defaultMessageReducer, type EveMessage } from "eve/client";
import { z } from "zod";
import { conversations } from "../../schema/schema";
import type { Conversation } from "../../core/conversations";
import { db } from "../../core/db";
import { agentHost } from "../../core/jobs";
import type { Language } from "../../core/language";
import { TRANSLATE_BATCH, translateTexts, TranslationLimitedError, type TranslationResult } from "../../core/translation";
import { copyFor } from "../copy";
import { HttpError, type AppCaller } from "../guards";
import { messageItems, textedItems, type TranslatableItem } from "../translatable";
import { notFound } from "./access";
import { textedFor } from "./assistant";
import { jobFor } from "./jobs";

// The translated view of a conversation the caller may already read: their own thread, their own job,
// or (owners and admins) a crew member's job about a quote or customer, by the same checks as the job
// page (`jobFor`). Anyone else's thread, and every conversation for a super admin's look-only view, is a
// 404.
//
// The browser asks by message id (lib/translatable.ts), never with text: the server reads the texts
// itself, from the conversation's eve session and, on a member's thread, from what the assistant texted
// them. The translation cache is shared by the business, so text a browser sent could plant a crafted
// translation that another member is shown for a real message with the same words. The session is read
// as the caller (their own cookie), so eve's channel auth (lib/eve-auth.ts) checks it is theirs to read
// as well. An id that isn't in the conversation refuses the whole request.

/** The conversation, when the caller may read it. */
export async function readableConversation(caller: AppCaller, conversationId: string): Promise<Conversation> {
  if (!caller.memberId) throw notFound();
  const [thread] = await db()
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.orgId, caller.orgId),
        eq(conversations.id, conversationId),
        eq(conversations.kind, "thread"),
        eq(conversations.memberId, caller.memberId),
      ),
    );
  if (thread) return thread;
  return (await jobFor(caller, conversationId)).job;
}

export const translateRequestSchema = z.object({
  target: z.enum(["en", "es"]),
  ids: z.array(z.string().min(1).max(200)).min(1).max(TRANSLATE_BATCH),
});

/** Reads an eve session's messages as the signed-in caller whose request `headers` are. */
export type SessionReader = (eveSessionId: string, headers: Headers) => Promise<readonly EveMessage[]>;

const eveSessionReader: SessionReader = async (eveSessionId, headers) => {
  const client = new Client({ host: agentHost(), redirect: "error", headers: { cookie: headers.get("cookie") ?? "" } });
  const reducer = defaultMessageReducer();
  let data = reducer.initial();
  const stream = client.sessions.attach(eveSessionId).stream({ startIndex: 0, follow: false, streamReconnectPolicy: { reconnect: false }, signal: AbortSignal.timeout(20_000) });
  for await (const event of stream) data = reducer.reduce(data, event);
  return data.messages;
};

let readerForTests: SessionReader | null = null;

/** Tests stand in for eve's session stream; null puts the real one back. */
export function setSessionReaderForTests(reader: SessionReader | null): void {
  readerForTests = reader;
}

/** Everything in the conversation the view can translate, by id, read on the server. */
async function conversationItems(caller: AppCaller, conversation: Conversation, headers: Headers): Promise<TranslatableItem[]> {
  const items: TranslatableItem[] = [];
  if (conversation.eveSessionId) items.push(...messageItems(await (readerForTests ?? eveSessionReader)(conversation.eveSessionId, headers)));
  if (conversation.kind === "thread") items.push(...textedItems(await textedFor(caller)));
  return items;
}

const unavailable = (language: Language) => new HttpError(503, "TRANSLATION_UNAVAILABLE", copyFor(language).translation.unavailable);

/**
 * Translates the conversation's texts with these ids for the caller. Throws `TranslationLimitedError`
 * over the business's hourly usage limit (the route answers 429), a 404 for an id the conversation
 * doesn't have, and a 503 when the conversation or the model can't be read.
 */
export async function translateForApp(
  caller: AppCaller,
  conversationId: string,
  body: unknown,
  headers: Headers,
): Promise<{ target: Language; translations: Array<TranslationResult & { id: string }> }> {
  const conversation = await readableConversation(caller, conversationId);
  const { target, ids } = translateRequestSchema.parse(body);
  const items = await conversationItems(caller, conversation, headers).catch((error: unknown) => {
    console.error("translation: the conversation could not be read", { conversationId, error: error instanceof Error ? error.message : String(error) });
    throw unavailable(caller.language);
  });
  const byId = new Map(items.map((item) => [item.id, item.text]));
  const unique = [...new Set(ids)];
  if (unique.some((id) => !byId.has(id))) throw new HttpError(404, "NOT_FOUND", "That isn't here.");
  try {
    const results = await translateTexts({
      orgId: caller.orgId,
      memberId: caller.memberId!,
      conversationId: conversation.id,
      target,
      texts: unique.map((id) => byId.get(id)!),
    });
    return { target, translations: unique.map((id, i) => ({ id, ...results[i] })) };
  } catch (error) {
    if (error instanceof Error && error.message === "TRANSLATION_UNAVAILABLE") throw unavailable(caller.language);
    throw error;
  }
}

export { TranslationLimitedError };
