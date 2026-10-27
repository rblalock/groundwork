// Emails members forward to their business's inbox (AgentMail, core/agentmail.ts). Each one is
// handled like a text from that member, in a thread of its own (a job, core/jobs.ts) under their
// main conversation: later emails about the same thing (same original sender and subject) join it. Its
// reply is texted to them (agents/assistant/agent/hooks/email-relay.ts), and the thread shows under Email on the web.
//
// `intakeAgentMailWebhook` (the webhook route, app/api/webhooks/agentmail) verifies the signature, finds
// the business by the inbox and the member by the sender's address, and stores the email in the inbound
// queue (core/deliveries.ts) before AgentMail gets its 200. Anything else (an unknown inbox, a
// paused business, spam, an automatic message, a sender who isn't an active member) is dropped and
// recorded, and nobody is ever emailed or texted about it: no backscatter. The queue's worker then calls
// `handleEmail` from the Photon channel (core/photon-inbound.ts), under the same order, retries,
// and usage limits as texts, and it starts the email's turn in its thread.
//
// The turn is marked `origin: "email"` on its auth (through the job token), so tools refuse money and
// team actions on it (`refuseFromEmail`), and its body is framed as information, never instructions
// (core/forwarded-email.ts).
import type { TextPart, UserContent } from "ai";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { deliveries, events, memberPhones, messages, organization } from "../schema/schema";
import { AgentMailError, agentMailGateway, agentMailWebhookSecret, emailResolver, inboxDisplayName, ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyAgentMailSignature } from "./agentmail";
import { storeEmailAttachment } from "./blob";
import {
  ATTACHMENT_LIMIT_BYTES,
  claimedRow,
  handOff,
  hold,
  kindOf,
  loadSource,
  logInbound,
  memberAuth,
  seen,
  emailTurnLines,
  type DispatchDeps,
  type Loaded,
} from "./channel-dispatch";
import { db } from "./db";
import { recordDelivery, type Delivery } from "./deliveries";
import { RAW_EMAIL_LIMITS, verifySender, type SenderAuth } from "./email-auth";
import { recordEvent } from "./events";
import { cleanEmailBody, emailDataBlock, forwardedEmailText, forwardedOriginal, htmlToText, parseAddress, type ForwardedOriginal } from "./forwarded-email";
import type { EmailDropReason, InboundDecision } from "./inbound";
import { confirmClaim, pendingClaimFor, subjectCode, type EmailClaim } from "./email-claims";
import { queueNotice } from "./followups";
import { createHash } from "node:crypto";
import { threadFor } from "./conversations";
import { emailThreadFor, emailThreadKey, openJob, startEmailTurn } from "./jobs";
import { callerForMember, findMemberByEmail, findMemberById, normalizeEmail, privilegedMembers, type Member, type MemberPhone } from "./members";
import { reservationOf } from "./usage";
import { postToMember } from "./outbound";
import { emailConfirmedOwnerText, emailConfirmedText } from "./team";
import { getOrganization, isSuspended } from "./organizations";

export const EMAIL_LIMITS = {
  /** AgentMail's event carries the text and HTML bodies, never attachment bytes. */
  webhookBytes: 5 * 1024 * 1024,
  /** Attachments read per email; the rest are named to the model as not read. */
  attachments: 10,
  subjectChars: 300,
} as const;

/** The message on a `message.received` event, as AgentMail sends it. Anything else on it is ignored. */
const agentMailMessage = z
  .object({
    inbox_id: z.string().min(1),
    message_id: z.string().min(1),
    thread_id: z.string().optional(),
    labels: z.array(z.string()).default([]),
    timestamp: z.string().optional(),
    from: z.string().min(1),
    to: z.array(z.string()).default([]),
    subject: z.string().optional(),
    text: z.string().optional(),
    html: z.string().optional(),
    headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    attachments: z
      .array(z.object({ attachment_id: z.string().min(1), filename: z.string().optional(), content_type: z.string().optional(), size: z.number().optional() }))
      .optional(),
  })
  .passthrough();
type AgentMailMessage = z.infer<typeof agentMailMessage>;

/** A forwarded email as the queue keeps it: what the turn needs, and no HTML or headers. */
export type ForwardedEmail = {
  inboxId: string;
  messageId: string;
  from: { name: string | null; address: string };
  subject: string;
  /** The cleaned body: the member's note and the forwarded message, without quoted replies or their signature. */
  body: string;
  truncated: boolean;
  /** Who wrote the message the member forwarded, when it is a forward. */
  original: ForwardedOriginal | null;
  attachments: Array<{ attachmentId: string; filename: string; contentType: string; size: number | null }>;
  /** Attachments past the per-email limit: named to the model, never read. */
  skipped: string[];
  /** How the raw message's sender was verified (core/email-auth.ts). */
  authenticated: Extract<SenderAuth, { ok: true }>;
  receivedAt: string;
};

/** Unique across businesses, like a Photon id: the same email sent to two businesses' inboxes is two deliveries. */
export const emailProviderId = (inboxId: string, messageId: string) => `agentmail:${inboxId}:${messageId}`;

/** What an email becomes in the queue, from AgentMail's message. */
export function toForwardedEmail(
  message: AgentMailMessage,
  sender: { name: string | null; address: string },
  authenticated: ForwardedEmail["authenticated"],
): ForwardedEmail {
  const subject = (message.subject ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, EMAIL_LIMITS.subjectChars);
  const raw = message.text?.trim() ? message.text : message.html ? htmlToText(message.html) : "";
  const { text, truncated } = cleanEmailBody(raw, subject);
  const attachments = (message.attachments ?? []).map((a) => ({
    attachmentId: a.attachment_id,
    filename: (a.filename ?? "attachment").replace(/[\r\n]+/g, " ").slice(0, 200),
    contentType: a.content_type ?? "application/octet-stream",
    size: typeof a.size === "number" ? a.size : null,
  }));
  return {
    inboxId: message.inbox_id,
    messageId: message.message_id,
    from: sender,
    subject,
    body: text,
    truncated,
    original: forwardedOriginal(raw),
    attachments: attachments.slice(0, EMAIL_LIMITS.attachments),
    skipped: attachments.slice(EMAIL_LIMITS.attachments).map((a) => a.filename),
    authenticated,
    receivedAt: message.timestamp && !Number.isNaN(Date.parse(message.timestamp)) ? new Date(message.timestamp).toISOString() : new Date().toISOString(),
  };
}

const lower = (headers: Record<string, string | string[]> | undefined): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value[0] : value]));

/**
 * Why an email isn't one to act on, before its sender is looked up: AgentMail didn't file it as received
 * mail, or marked it spam, blocked, or failing sender authentication (SPF, DKIM, DMARC); it's automatic
 * (an auto-reply, a mailing list, a bounce), which must never start a loop; or it's from the inbox itself.
 */
export function screenEmail(message: Pick<AgentMailMessage, "labels" | "headers">, sender: string | null, inboxAddress: string | null): EmailDropReason | null {
  const labels = new Set(message.labels.map((label) => label.toLowerCase()));
  if (!labels.has("received")) return "not_received";
  if (["spam", "blocked", "unauthenticated", "bounced", "trash"].some((label) => labels.has(label))) return "spam";
  const headers = lower(message.headers);
  const auto = headers["auto-submitted"]?.trim().toLowerCase();
  if ((auto && auto !== "no") || headers["list-id"] || /^(bulk|junk|list|auto_reply)$/i.test(headers.precedence?.trim() ?? "")) return "automatic";
  if (!sender || /^(mailer-daemon|postmaster)@/i.test(sender)) return "automatic";
  if (inboxAddress && sender === inboxAddress.toLowerCase()) return "own_inbox";
  return null;
}

/**
 * The member's phone whose iMessage thread a forwarded email's turn runs in: the same one their texts
 * reach (verified, texted from, not stopped). Null for a member who hasn't texted the line yet.
 */
export async function threadPhone(orgId: string, memberId: string): Promise<MemberPhone | null> {
  const phones = await db()
    .select()
    .from(memberPhones)
    .where(and(eq(memberPhones.orgId, orgId), eq(memberPhones.memberId, memberId)))
    .orderBy(asc(memberPhones.createdAt), asc(memberPhones.id));
  return phones.find((p) => p.status === "verified" && p.threadId && p.lastInboundAt) ?? null;
}

/** Records a dropped email once (a redelivery records nothing new). Nobody is told: no backscatter. */
async function recordDrop(
  orgId: string,
  email: { messageId: string; from: string | null; subject?: string; detail?: string },
  reason: EmailDropReason | "suspended",
  memberId?: string,
) {
  console.info("email: a forwarded email was dropped", { orgId, reason });
  await recordEvent({
    orgId,
    kind: "email.dropped",
    key: `email.dropped:${email.messageId}`,
    memberId,
    data: { reason, from: email.from, subject: (email.subject ?? "").slice(0, 120), ...(email.detail ? { detail: email.detail } : {}) },
  });
}

/**
 * The request body as text, or null past `max` bytes. A declared length over it is refused up front; the
 * body itself is counted as it streams in and dropped the moment it passes `max`, so a missing or lying
 * Content-Length can't make it buffer more.
 */
export async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const answer = (status: number, body: Record<string, unknown> | string | null = null): Response =>
  body === null ? new Response(null, { status }) : typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status });

export type EmailIntake = {
  response: Response;
  /** Set when a new delivery was stored: the member whose queue to run now. */
  queued?: { orgId: string; memberId: string; deliveryId: string };
};

/**
 * The webhook route's work, before it answers AgentMail. A bad, missing, or stale signature is refused
 * (replays past five minutes too; a redelivery inside them is the same message id, stored once).
 * Anything that isn't a member's email is acknowledged and dropped, including mail from a member's
 * address whose sender AgentMail didn't vouch for (core/email-auth.ts); a member's is stored and
 * acknowledged.
 */
export async function intakeAgentMailWebhook(request: Request, options: { secret?: string | null; now?: Date } = {}): Promise<EmailIntake> {
  const secret = options.secret === undefined ? agentMailWebhookSecret() : options.secret;
  if (!secret) {
    console.error("email: AGENTMAIL_WEBHOOK_SECRET is not set, so webhooks can't be verified");
    return { response: answer(503, "Webhook verification not configured") };
  }
  const rawBody = await readCapped(request, EMAIL_LIMITS.webhookBytes);
  if (rawBody === null) return { response: answer(413, "Webhook body too large") };
  const verified = verifyAgentMailSignature({
    rawBody,
    secret,
    id: request.headers.get(ID_HEADER),
    timestamp: request.headers.get(TIMESTAMP_HEADER),
    signature: request.headers.get(SIGNATURE_HEADER),
    nowSec: options.now ? Math.floor(options.now.getTime() / 1000) : undefined,
  });
  if (!verified.ok) {
    console.warn("email: rejected a webhook delivery", { reason: verified.reason });
    return { response: answer(verified.status, verified.reason) };
  }
  let event: { event_type?: unknown; message?: { inbox_id?: unknown; message_id?: unknown } };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return { response: answer(400, "Invalid JSON body") };
  }
  if (event?.event_type !== "message.received") return { response: answer(200, { ignored: "event" }) };
  // The event only says which message arrived. Its content is read back from AgentMail below, never taken
  // from the event.
  const inboxId = typeof event.message?.inbox_id === "string" ? event.message.inbox_id : null;
  const messageId = typeof event.message?.message_id === "string" ? event.message.message_id : null;
  if (!inboxId || !messageId || inboxId.length > 300 || messageId.length > 1000) {
    console.warn("email: a signed event had no readable message id");
    return { response: answer(200, { ignored: "malformed" }) };
  }

  // The inbox finds the business: the one lookup here without an org, like a phone for a text.
  const [org] = await db().select().from(organization).where(eq(organization.inboxId, inboxId));
  if (!org?.inboxAddress) {
    console.info("email: an email to an inbox no business has", { inboxId });
    return { response: answer(200, { ignored: "unknown_inbox" }) };
  }
  const providerMessageId = emailProviderId(inboxId, messageId);
  const [seen] = await db().select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.providerMessageId, providerMessageId));
  if (seen) return { response: answer(200, { duplicate: seen.id }) };
  const drop = async (reason: EmailDropReason | "suspended", ref: { from: string | null; subject?: string; memberId?: string; detail?: string }) => {
    await recordDrop(org.id, { messageId: providerMessageId, from: ref.from, subject: ref.subject, detail: ref.detail }, reason, ref.memberId);
    return { response: answer(200, { ignored: reason }) };
  };
  if (org.suspended) return drop("suspended", { from: null });

  // AgentMail's own copy of the message. A failure here is a 500, so AgentMail delivers the event again.
  let stored: unknown;
  try {
    stored = await agentMailGateway().getMessage({ inboxId, messageId });
  } catch (error) {
    if (error instanceof AgentMailError && error.status === 404) return { response: answer(200, { ignored: "not_found" }) };
    throw error;
  }
  const parsed = agentMailMessage.safeParse(stored);
  if (!parsed.success || parsed.data.inbox_id !== inboxId || parsed.data.message_id !== messageId) {
    console.warn("email: AgentMail's copy of a message didn't match its event");
    return { response: answer(200, { ignored: "malformed" }) };
  }
  const message = parsed.data;
  const from = parseAddress(message.from);
  const sender = from.address ? normalizeEmail(from.address) : null;
  const screened = screenEmail(message, sender, org.inboxAddress);
  if (screened) return drop(screened, { from: sender, subject: message.subject });
  // Only a member's confirmed address counts. A pending one (asked for, not yet proven) can only confirm.
  const member = await findMemberByEmail(org.id, sender!);
  const claim = member ? null : await pendingClaimFor(org.id, sender!, options.now);
  if (!member && !claim) return drop("unknown_sender", { from: sender, subject: message.subject });
  const memberId = member?.id ?? claim!.memberId;
  const phone = await threadPhone(org.id, memberId);
  if (member && !phone?.threadId) return drop("no_thread", { from: sender, subject: message.subject, memberId });

  // From is easy to forge: the email is the member's only when its original bytes verify for that address.
  let raw: Uint8Array;
  try {
    raw = await agentMailGateway().getRawMessage({ inboxId, messageId, maxBytes: RAW_EMAIL_LIMITS.bytes });
  } catch (error) {
    if (error instanceof Error && error.message === "RAW_TOO_LARGE") return drop("too_large", { from: sender, subject: message.subject, memberId });
    throw error;
  }
  const authenticated = await verifySender(raw, { sender: sender!, inbox: org.inboxAddress }, { resolver: emailResolver() });
  if (!authenticated.ok) {
    console.warn("email: an email's sender could not be verified", { orgId: org.id, reason: authenticated.reason });
    return drop("unauthenticated", { from: sender, subject: message.subject, memberId, detail: authenticated.reason });
  }
  if (claim) return confirmFromEmail(org.id, org.inboxAddress, claim, message, { from: sender!, providerMessageId, now: options.now });

  if (!member || !phone?.threadId) return drop("unknown_sender", { from: sender, subject: message.subject });
  const email = toForwardedEmail(message, { name: from.name, address: sender! }, authenticated);
  const queued = await recordDelivery({
    orgId: org.id,
    memberId: member.id,
    providerMessageId,
    webhookId: request.headers.get(ID_HEADER),
    kind: "email",
    threadId: phone.threadId,
    payload: email as unknown as Record<string, unknown>,
    sentAt: new Date(email.receivedAt),
    now: options.now,
  });
  if (queued.duplicate) return { response: answer(200, { duplicate: queued.id }) };
  return { response: answer(200, { queued: queued.id }), queued: { orgId: org.id, memberId: member.id, deliveryId: queued.id } };
}

/** True when an email answers or forwards another: its threading headers, or a reply or forward prefix. */
function isReplyOrForward(message: AgentMailMessage): boolean {
  const headers = lower(message.headers);
  const raw = message as Record<string, unknown>;
  return Boolean(headers["in-reply-to"] || headers.references || raw.in_reply_to || raw.references);
}

/**
 * A verified email from an address waiting on its code (core/email-claims.ts). Its subject must be
 * exactly the code, and it must be neither a reply nor a forward: an email someone else wrote, with the
 * code in it, can't confirm the address by being forwarded. The body isn't read. The right code turns the
 * address on and texts the member and the business's owners; it starts no turn. Anything else is
 * recorded, and nobody is answered: a wrong code counts toward the claim's lock.
 */
async function confirmFromEmail(
  orgId: string,
  inbox: string,
  claim: EmailClaim,
  message: AgentMailMessage,
  ref: { from: string; providerMessageId: string; now?: Date },
): Promise<EmailIntake> {
  const now = ref.now ?? new Date();
  const code = isReplyOrForward(message) ? null : subjectCode(message.subject);
  const result = code ? await confirmClaim(claim, code, now) : "not_a_code";
  if (result !== "confirmed") {
    await recordDrop(orgId, { messageId: ref.providerMessageId, from: ref.from, detail: result }, "unconfirmed", claim.memberId);
    return { response: answer(200, { ignored: "unconfirmed" }) };
  }
  await recordEvent({ orgId, kind: "email.confirmed", key: `email.confirmed:${claim.id}`, refId: claim.id, memberId: claim.memberId, data: { address: ref.from } });
  console.info("email: a member's forwarding address was confirmed", { orgId, memberId: claim.memberId });
  const member = await findMemberById(orgId, claim.memberId);
  if (member) {
    const text = emailConfirmedText(claim.address, inbox, member.language === "es" ? "es" : "en");
    await postToMember(orgId, member.id, { text }, "system", { now }).catch((error) => console.error("email: confirmation text failed", error));
    // The owners hear of every address that turns on, so one turned on behind their back doesn't go unseen.
    for (const owner of (await privilegedMembers(orgId)).filter((m) => m.role === "owner" && m.id !== member.id)) {
      const notice = emailConfirmedOwnerText(member.name, claim.address, owner.language === "es" ? "es" : "en");
      const sent = await postToMember(orgId, owner.id, { text: notice }, "proactive", { now }).catch(() => ({ posted: false as const, reason: "send_failed" as const }));
      if (!sent.posted && sent.reason === "quiet_hours") {
        await queueNotice({ orgId, memberId: owner.id, quoteId: null, payload: { text: notice, asksApproval: false }, now });
      }
    }
  }
  return { response: answer(200, { confirmed: true }) };
}

// ---------------------------------------------------------------------------------------------
// A stored email → a turn in the member's thread


/** The per-turn facts an email's turn adds to a text's: what it is, how to treat it, and how to answer. */
/** An email thread's title: who wrote it and what about, like "Jane Sample: Gutter cleaning". */
export function emailThreadTitle(sender: { name: string | null; address: string }, subject: string): string {
  const who = sender.name?.trim() || sender.address;
  const what = subject.replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "").trim();
  return (what ? `${who}: ${what}` : who).slice(0, 160);
}

/** The email's rules for its turn (core/channel-dispatch.ts, `emailTurnLines`). */
export const emailContextLines = emailTurnLines;

/** The turn's content: the framed email, what was read of its attachments (each framed too), and the files the model reads. */
export function emailContent(email: ForwardedEmail, loaded: Loaded[]): string | UserContent {
  const notes = [
    ...new Set([
      ...loaded.flatMap((l) => (l.note ? [l.note] : [])),
      ...email.skipped.map((name) => `(file ${name} was not read: an email carries at most ${EMAIL_LIMITS.attachments} attachments here.)`),
    ]),
  ];
  const body = forwardedEmailText({
    from: email.from,
    original: email.original,
    subject: email.subject,
    attachments: [...email.attachments.map((a) => a.filename), ...email.skipped],
    body: email.body,
    truncated: email.truncated,
    attachmentNotes: notes,
  });
  const documents = loaded.flatMap((l): TextPart[] => (l.text ? [{ type: "text", text: emailDataBlock("An attachment's text", l.text) }] : []));
  const files = loaded.flatMap((l) => (l.file ? [l.file] : []));
  if (documents.length === 0 && files.length === 0) return body;
  return [{ type: "text", text: body }, ...documents, ...files];
}

export interface EmailDeps extends DispatchDeps {
  /** The Chat SDK thread for a member's iMessage thread id: where the turn is handed over and replies post. */
  thread: (threadId: string) => unknown;
  /** One attachment's bytes from AgentMail; defaults to the gateway's. */
  download?: (input: { inboxId: string; messageId: string; attachmentId: string; maxBytes: number }) => Promise<Uint8Array>;
}

/**
 * Hands a stored email to the member's thread as their turn. Who it's from is checked again (the member
 * may have been removed, or their address changed, since it arrived), and so are the business's pause and
 * the member's thread. The email is logged as the member's inbound message with its stored attachments,
 * so a kept document or a quote's photos find it as they find a text's. From the queue, errors throw and
 * the queue retries, resuming past its own logged row.
 */
export async function handleEmail(delivery: Pick<Delivery, "id" | "orgId" | "memberId" | "providerMessageId" | "payload">, deps: EmailDeps): Promise<InboundDecision> {
  const email = delivery.payload as unknown as ForwardedEmail;
  const { orgId } = delivery;
  const ref = { messageId: delivery.providerMessageId, from: email.from.address, subject: email.subject };
  const member: Member | null = await findMemberById(orgId, delivery.memberId);
  if (!member || member.status !== "active" || member.email !== email.from.address) {
    await recordDrop(orgId, ref, "unknown_sender", member?.id);
    return { kind: "ignore", reason: "unknown_sender" };
  }
  if (await isSuspended(orgId)) {
    await recordDrop(orgId, ref, "suspended", member.id);
    return { kind: "ignore", reason: "suspended" };
  }
  const phone = await threadPhone(orgId, member.id);
  const main = await threadFor(orgId, member.id);
  const caller = await callerForMember(member);
  if (!phone?.threadId || !main || !caller) {
    await recordDrop(orgId, ref, "no_thread", member.id);
    return { kind: "ignore", reason: "no_thread" };
  }
  const threadId = phone.threadId;
  const step = deps.delivery;
  const resuming = Boolean(step && (step.attempt > 1 || step.progress.held) && (await seen(delivery.providerMessageId)));
  if (!resuming && (await seen(delivery.providerMessageId))) return { kind: "ignore", reason: "duplicate" };
  const rowId = resuming
    ? await claimedRow(delivery.providerMessageId)
    : await logInbound({
        member,
        phone,
        providerMessageId: delivery.providerMessageId,
        threadId,
        kind: "user",
        body: `Forwarded email: ${email.subject || "(no subject)"}`,
      });
  if (!rowId) return { kind: "ignore", reason: "duplicate" };

  try {
    const store = deps.storeAttachment ?? storeEmailAttachment;
    const download = deps.download ?? ((input) => agentMailGateway().downloadAttachment(input));
    const loaded: Loaded[] = [];
    for (const attachment of email.attachments) {
      loaded.push(
        await loadSource(
          {
            type: kindOf(attachment.contentType),
            name: attachment.filename,
            mimeType: attachment.contentType,
            size: attachment.size,
            rawKeys: [],
            load: () => download({ inboxId: email.inboxId, messageId: email.messageId, attachmentId: attachment.attachmentId, maxBytes: ATTACHMENT_LIMIT_BYTES }),
          },
          store,
        ),
      );
    }
    const stored = loaded.flatMap((l) => (l.attachment ? [l.attachment] : []));
    if (stored.length > 0) {
      await db().update(messages).set({ attachments: stored }).where(and(eq(messages.orgId, orgId), eq(messages.id, rowId)));
    }
    // Its thread: the one for this conversation (a retry finds the one its first try opened), or a new one.
    // A forward is about the message forwarded: its sender and subject name the thread.
    const sender = email.original?.address ? { name: email.original.name, address: email.original.address } : email.from;
    const subject = email.original?.subject?.trim() || email.subject;
    const key = emailThreadKey({ senderAddress: sender.address, subject });
    const job =
      (await emailThreadFor(caller, key, deps.now)) ??
      (await openJob(caller, {
        id: `job_${createHash("sha256").update(`email:${delivery.providerMessageId}`).digest("hex").slice(0, 20)}`,
        thread: main,
        title: emailThreadTitle(sender, subject),
        source: "email",
        emailKey: key,
      }));
    const auth = memberAuth(member, phone);
    // The queue admits the turn and records the hand-off; the turn itself runs in the email's thread.
    const handed = await handOff(
      { ...deps, send: (content, options) => startEmailTurn(job, content, { deliveryId: delivery.id, reservationId: reservationOf(options.auth) ?? undefined }) },
      emailContent(email, loaded),
      { thread: deps.thread(threadId), auth: { ...auth, attributes: { ...auth.attributes, origin: "email" } }, context: [], turnPolicy: "queue" },
    );
    if (handed) return await hold(deps, member, phone, threadId, handed.held);
  } catch (error) {
    if (step) throw error;
    console.error("email: a forwarded email was logged but its turn did not start", { orgId, error });
  }
  return { kind: "dispatch", welcome: false };
}

// ---------------------------------------------------------------------------------------------
// The business's inbox

/**
 * Makes the business's inbox, once: a business that has one keeps it (`created: false`). AgentMail makes
 * the address; the business's slug is asked for as its name. Super admins only (the admin route and
 * `npm run email:inbox` call it). Throws `NO_SUCH_BUSINESS`, or `AGENTMAIL_NOT_CONFIGURED`.
 */
export async function createBusinessInbox(orgId: string): Promise<{ inboxId: string; address: string; created: boolean }> {
  const org = await getOrganization(orgId);
  if (!org) throw new Error("NO_SUCH_BUSINESS");
  if (org.inboxId && org.inboxAddress) return { inboxId: org.inboxId, address: org.inboxAddress, created: false };
  // The client id makes a retried create return the same inbox, so a crash between here and the save
  // can't make a second one. After a super admin removed one (core/business-admin.ts), the next asks
  // under a new id, so AgentMail doesn't hand back the deleted inbox.
  const [{ removed }] = await db()
    .select({ removed: count() })
    .from(events)
    .where(and(eq(events.orgId, orgId), eq(events.kind, "email.inbox_removed")));
  const clientId = `gw-business-${org.id}${removed ? `-${removed + 1}` : ""}`;
  const inbox = await agentMailGateway().createInbox({ clientId, username: org.slug, displayName: inboxDisplayName(org.name) });
  const [saved] = await db()
    .update(organization)
    .set({ inboxId: inbox.inboxId, inboxAddress: inbox.address })
    .where(and(eq(organization.id, orgId), isNull(organization.inboxId)))
    .returning();
  if (!saved) {
    const current = await getOrganization(orgId);
    return { inboxId: current!.inboxId!, address: current!.inboxAddress!, created: false };
  }
  await recordEvent({ orgId, kind: "email.inbox_created", data: { address: inbox.address } });
  console.info("email: made a business's inbox", { orgId });
  return { inboxId: inbox.inboxId, address: inbox.address, created: true };
}
