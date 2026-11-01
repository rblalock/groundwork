import { and, asc, desc, eq, gte } from "drizzle-orm";
import { memberPhones, messages } from "../schema/schema";
import type { InboundAttachment } from "../schema/types";
import { db, newId } from "./db";
import { chunkText, openThread, postFile, postText, type OutboundFile } from "./imessage";
import { privilegedMembers, type Member } from "./members";
import { isSuspended } from "./organizations";
import { getProfile, type Profile } from "./profile";
import type { Poster } from "./quotes";
import { isQuietHours } from "./time";

type Reason = "no_verified_phone" | "never_texted" | "quiet_hours" | "stopped" | "send_failed" | "suspended";
type Payload = {
  text?: string;
  file?: OutboundFile;
  /** Where `file` is stored: logged on the file's row, so the web thread can link it. */
  fileUrl?: string;
  /** More files, each posted on its own after `file`, in order, with where each is stored. */
  files?: Array<{ file: OutboundFile; fileUrl?: string }>;
  quoteId?: string;
  asksApproval?: boolean;
  /** What the `messages` log records instead of `text`, for a post that mustn't be stored (a sign-in code). */
  logText?: string;
};

/** Logs one outbound `messages` row per chunk. Shared by `postToMember` and the channel's reply handler. */
export async function logOutbound(input: {
  orgId: string;
  memberId: string;
  phoneE164: string;
  threadId: string;
  providerMessageIds: string[];
  chunks: string[];
  kind: "assistant" | "proactive" | "system";
  quoteId?: string | null;
  /** The post asks the member to approve `quoteId`. */
  asksApproval?: boolean;
  /** A file post: the file, with its stored URL when there is one (empty when not). */
  attachments?: InboundAttachment[];
}): Promise<void> {
  if (input.chunks.length === 0) return;
  await db()
    .insert(messages)
    .values(
      input.chunks.map((body, i) => ({
        id: newId("msg"),
        orgId: input.orgId,
        memberId: input.memberId,
        phoneE164: input.phoneE164,
        direction: "outbound" as const,
        kind: input.kind,
        providerMessageId: input.providerMessageIds[i] ?? null,
        threadId: input.threadId,
        body,
        quoteId: input.quoteId ?? null,
        asksApproval: input.asksApproval ?? false,
        attachments: input.attachments ?? [],
      })),
    )
    .onConflictDoNothing({ target: messages.providerMessageId });
}

/**
 * Texts a member on the thread they last wrote to us from. Never to a phone that has not texted
 * first or has stopped, and never for a paused business. `proactive` posts also wait out quiet hours; `system` posts (a quote PDF,
 * a crew notice after an approval) go any time.
 */
export const postToMember = (async (
  orgId: string,
  memberId: string,
  payload: Payload,
  kind: "proactive" | "system",
  deps?: { now?: Date; profile?: Profile },
): Promise<{ posted: boolean; reason?: Reason }> => {
  // A paused business texts nobody: no nudges, notices, sign-in codes, or payment notices.
  if (await isSuspended(orgId)) return { posted: false, reason: "suspended" };
  const phones = await db()
    .select()
    .from(memberPhones)
    .where(and(eq(memberPhones.orgId, orgId), eq(memberPhones.memberId, memberId)))
    .orderBy(asc(memberPhones.createdAt), asc(memberPhones.id));
  const live = phones.filter((p) => p.status !== "stopped");
  if (live.length === 0) return { posted: false, reason: phones.length > 0 ? "stopped" : "no_verified_phone" };
  const phone = live.find((p) => p.status === "verified" && p.threadId && p.lastInboundAt);
  if (!phone?.threadId) return { posted: false, reason: "never_texted" };

  if (kind === "proactive") {
    const profile = deps?.profile ?? (await getProfile(orgId));
    if (isQuietHours(deps?.now ?? new Date(), profile.timeZone, profile.quietStartHour, profile.quietEndHour)) {
      return { posted: false, reason: "quiet_hours" };
    }
  }

  const threadId = phone.threadId;
  const text = payload.text?.trim() ?? "";
  const { quoteId, asksApproval } = payload;
  const files = [...(payload.file ? [{ file: payload.file, fileUrl: payload.fileUrl }] : []), ...(payload.files ?? [])];
  const log = (chunks: string[], ids: string[], attachments?: InboundAttachment[]) =>
    logOutbound({ orgId, memberId, phoneE164: phone.e164, threadId, providerMessageIds: ids, chunks, kind, quoteId, asksApproval, attachments });
  let sentAny = false;
  try {
    // The text goes first and each file alone (the adapter returns only a post's first bubble id), so
    // each file bubble's own id is logged and a tapback on it resolves the quote. The first file's row
    // repeats the text so the tapback turn can quote it; the rest carry their names.
    for (const chunk of chunkText(text)) {
      const ids = await postText(threadId, chunk);
      await log([payload.logText ?? chunk], ids);
      sentAny = true;
    }
    for (const [i, { file, fileUrl }] of files.entries()) {
      const id = await postFile(threadId, file);
      await log([(i === 0 && text) || file.filename], id ? [id] : [], [{ type: "file", url: fileUrl ?? "", name: file.filename, mimeType: file.mimeType }]);
      sentAny = true;
    }
  } catch (error) {
    console.error("outbound: send failed", error);
    return { posted: false, reason: "send_failed" };
  }
  return sentAny ? { posted: true } : { posted: false, reason: "send_failed" };
}) satisfies Poster;

/**
 * Texts a phone that has never texted us, on a 1:1 thread opened to its number. Only for a sign-in code
 * to a phone an admin verified at provisioning; everything else waits for the member's first text.
 */
export async function postToPhone(
  orgId: string,
  memberId: string,
  e164: string,
  payload: { text: string; logText?: string },
): Promise<{ posted: boolean; reason?: Reason }> {
  if (await isSuspended(orgId)) return { posted: false, reason: "suspended" };
  try {
    const threadId = await openThread(e164);
    for (const chunk of chunkText(payload.text)) {
      const ids = await postText(threadId, chunk);
      await logOutbound({ orgId, memberId, phoneE164: e164, threadId, providerMessageIds: ids, chunks: [payload.logText ?? chunk], kind: "system" });
    }
  } catch (error) {
    console.error("outbound: could not text a phone that has no thread yet", { memberId, error });
    return { posted: false, reason: "send_failed" };
  }
  return { posted: true };
}

/**
 * Texts every active owner and admin of the business. `text` may be a function of the member, for their language.
 * A text held by quiet hours is queued for when they end. Returns who got it now and who will then.
 */
export async function notifyOwners(
  orgId: string,
  text: string | ((member: Member) => string),
  kind: "proactive" | "system" = "proactive",
  deps?: { now?: Date },
): Promise<{ notified: string[]; queued: string[] }> {
  const now = deps?.now ?? new Date();
  const notified: string[] = [];
  const queued: string[] = [];
  for (const member of await privilegedMembers(orgId)) {
    const body = typeof text === "function" ? text(member) : text;
    const result = await postToMember(orgId, member.id, { text: body }, kind, { now });
    if (result.posted) notified.push(member.name);
    else if (result.reason === "quiet_hours") {
      // Imported here: followups.ts imports this module.
      const { queueNotice } = await import("./followups");
      await queueNotice({ orgId, memberId: member.id, quoteId: null, payload: { text: body, asksApproval: false }, now });
      queued.push(member.name);
    }
  }
  return { notified, queued };
}

/** The newest proactive text we sent the member since `since`, for the model's context. */
export async function lastProactiveFor(
  orgId: string,
  memberId: string,
  since: Date,
): Promise<{ text: string; at: Date } | null> {
  const [row] = await db()
    .select({ body: messages.body, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.memberId, memberId),
        eq(messages.direction, "outbound"),
        eq(messages.kind, "proactive"),
        gte(messages.createdAt, since),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return row ? { text: row.body, at: row.createdAt } : null;
}
