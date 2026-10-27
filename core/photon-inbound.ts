// The Photon webhook, made durable. `intakePhotonWebhook` verifies the signature, finds the member by
// the sender's phone, and stores the delivery (core/deliveries.ts) before Photon gets its 200.
// `photonDeliveryHandler` then turns a stored delivery into the Chat SDK message or tapback the
// channel always handled (core/channel-dispatch.ts) and hands its turn to the member's eve
// session, on the same thread continuation as before.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { UserContent } from "ai";
import { getEmoji } from "chat";
import {
  handleInbound,
  handleReaction,
  toInbound,
  toReaction,
  type DispatchDeps,
  type SessionAuthContext,
} from "./channel-dispatch";
import { threadFor } from "./conversations";
import { deliveryReachedEve, threadTurnRunning } from "./conversation-events";
import { previousHandOff, recordDelivery, type DeliveryHandler } from "./deliveries";
import { handleEmail, type EmailDeps } from "./email-intake";
import { findMemberByPhone, normalizeE164 } from "./members";
import { admitTurn } from "./usage-limits";

export const SIGNATURE_HEADER = "x-spectrum-signature";
export const TIMESTAMP_HEADER = "x-spectrum-timestamp";
export const EVENT_HEADER = "x-spectrum-event";
export const WEBHOOK_ID_HEADER = "x-spectrum-webhook-id";
const MESSAGES_EVENT = "messages";
/** Photon's own limit on a signed timestamp's age, as the adapter checks it. */
const TIMESTAMP_TOLERANCE_SEC = 5 * 60;
/** Webhooks carry ids, not file bytes; anything bigger than this isn't one of Photon's. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
/** Content types that are conversation events, not messages: the adapter drops them too. */
const EVENT_CONTENT_TYPES = new Set(["addMember", "removeMember", "leaveSpace", "rename", "avatar", "typing"]);

/** How long a hand-off to eve may go unconfirmed before it's sent again, and the most a running turn can stretch that. */
export const HANDOFF_GRACE_MS = 2 * 60_000;
export const HANDOFF_MAX_WAIT_MS = 15 * 60_000;
const HANDOFF_RECHECK_MS = 30_000;
/**
 * How long a text waits for the member's previous turn to start and end before it's handed over. eve
 * folds texts queued behind a running turn into one turn; waiting gives each text its own turn and
 * reply. Well inside the lease, so no second worker takes the delivery meanwhile.
 */
export const PREVIOUS_TURN_WAIT_MS = 90_000;
const PREVIOUS_TURN_POLL_MS = 1_000;

type RawMessage = {
  id?: unknown;
  direction?: unknown;
  timestamp?: unknown;
  sender?: { id?: unknown };
  content?: { type?: unknown; emoji?: unknown; target?: { id?: unknown; parentId?: unknown } };
  space?: { phone?: string };
};
export type PhotonWebhookPayload = { event: string; message: RawMessage & Record<string, unknown>; space: { id: string; phone?: string } & Record<string, unknown> };

/**
 * Photon's webhook signature, exactly as the iMessage adapter checks it: `v0=` HMAC-SHA256 of
 * `v0:<timestamp>:<raw body>`, with the timestamp no more than five minutes off.
 */
export function verifyPhotonSignature(input: {
  rawBody: string;
  secret: string;
  signature: string | null;
  timestamp: string | null;
  nowSec?: number;
}): { ok: true } | { ok: false; status: number; reason: string } {
  const { rawBody, secret, signature, timestamp } = input;
  if (!signature || !timestamp) return { ok: false, status: 400, reason: "missing signature headers" };
  const age = Math.abs((input.nowSec ?? Math.floor(Date.now() / 1000)) - Number(timestamp));
  if (!Number.isFinite(age) || age > TIMESTAMP_TOLERANCE_SEC) return { ok: false, status: 400, reason: "stale or invalid timestamp" };
  const expected = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`);
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, status: 401, reason: "bad signature" };
  return { ok: true };
}

/** Signs a body the way Photon does: for the local simulator and tests. */
export function signPhotonWebhook(rawBody: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): Record<string, string> {
  const timestamp = String(nowSec);
  return {
    [SIGNATURE_HEADER]: `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`,
    [TIMESTAMP_HEADER]: timestamp,
    [EVENT_HEADER]: MESSAGES_EVENT,
  };
}

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** The provider id a tapback points at: its `parentId` when there is one, as the adapter reads it. */
function reactionTarget(target: { id?: unknown; parentId?: unknown } | undefined): string | null {
  if (!target) return null;
  return str(target.parentId) ?? str(target.id);
}

/** What a verified `messages` payload is to the queue: a text, a tapback, or something to drop. */
export function classifyPayload(payload: PhotonWebhookPayload):
  | { kind: "ignore"; reason: string }
  | { kind: "message" | "reaction"; providerMessageId: string; sender: string; sentAt: Date | null } {
  const { message } = payload;
  const id = str(message.id);
  if (!id) return { kind: "ignore", reason: "no_id" };
  if (message.direction === "outbound") return { kind: "ignore", reason: "outbound" };
  const type = message.content?.type;
  if (typeof type === "string" && EVENT_CONTENT_TYPES.has(type)) return { kind: "ignore", reason: "event" };
  const sender = str(message.sender?.id);
  if (!sender) return { kind: "ignore", reason: "no_sender" };
  if (type === "reaction" && (typeof message.content?.emoji !== "string" || !reactionTarget(message.content?.target))) {
    return { kind: "ignore", reason: "malformed_reaction" };
  }
  const at = typeof message.timestamp === "string" || typeof message.timestamp === "number" ? new Date(message.timestamp) : null;
  return { kind: type === "reaction" ? "reaction" : "message", providerMessageId: id, sender, sentAt: at && !Number.isNaN(at.getTime()) ? at : null };
}

async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  const text = await request.text();
  return Buffer.byteLength(text) > max ? null : text;
}

export type Intake = {
  response: Response;
  /** Set when a new delivery was stored: the member whose queue to run now. */
  queued?: { orgId: string; memberId: string; deliveryId: string };
};

const answer = (status: number, body: Record<string, unknown> | string | null = null): Response =>
  body === null ? new Response(null, { status }) : typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status });

/**
 * The webhook route's work, before it answers Photon. Bad signatures are refused as the adapter refused
 * them; anything that isn't a member's text or tapback is acknowledged and dropped; a member's is stored
 * (once per provider id) and acknowledged. Unknown and removed members' texts are never stored.
 */
export async function intakePhotonWebhook(
  request: Request,
  options: { secret: string | undefined; encodeThreadId: (data: { chatGuid: string; phone?: string }) => string; now?: Date },
): Promise<Intake> {
  if (!options.secret) {
    console.error("photon: IMESSAGE_WEBHOOK_SECRET is not set, so webhooks can't be verified");
    return { response: answer(500, "Webhook verification not configured") };
  }
  const rawBody = await readCapped(request, MAX_WEBHOOK_BYTES);
  if (rawBody === null) return { response: answer(413, "Webhook body too large") };
  const verified = verifyPhotonSignature({
    rawBody,
    secret: options.secret,
    signature: request.headers.get(SIGNATURE_HEADER),
    timestamp: request.headers.get(TIMESTAMP_HEADER),
    nowSec: options.now ? Math.floor(options.now.getTime() / 1000) : undefined,
  });
  if (!verified.ok) {
    console.warn("photon: rejected a webhook delivery", { reason: verified.reason });
    return { response: answer(verified.status, verified.reason) };
  }
  const event = request.headers.get(EVENT_HEADER);
  if (event && event !== MESSAGES_EVENT) return { response: answer(204) };
  let payload: PhotonWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as PhotonWebhookPayload;
  } catch {
    return { response: answer(400, "Invalid JSON body") };
  }
  if (payload?.event !== MESSAGES_EVENT || !payload.message || typeof payload.space?.id !== "string") return { response: answer(204) };

  const target = classifyPayload(payload);
  if (target.kind === "ignore") return { response: answer(200, { ignored: target.reason }) };
  const e164 = normalizeE164(target.sender);
  const found = e164 ? await findMemberByPhone(e164) : null;
  if (!found || found.member.status === "removed") return { response: answer(200, { ignored: "unknown_phone" }) };

  const threadId = options.encodeThreadId({ chatGuid: payload.space.id, phone: payload.space.phone ?? payload.message.space?.phone });
  const stored = await recordDelivery({
    orgId: found.member.orgId,
    memberId: found.member.id,
    providerMessageId: target.providerMessageId,
    webhookId: request.headers.get(WEBHOOK_ID_HEADER),
    kind: target.kind,
    threadId,
    payload: payload as unknown as Record<string, unknown>,
    sentAt: target.sentAt ?? undefined,
    now: options.now,
  });
  if (stored.duplicate) return { response: answer(200, { duplicate: stored.id }) };
  return {
    response: answer(200, { queued: stored.id }),
    queued: { orgId: found.member.orgId, memberId: found.member.id, deliveryId: stored.id },
  };
}

// ---------------------------------------------------------------------------------------------
// Stored delivery → the Chat SDK shapes channel-dispatch.ts takes

/** iMessage's tapbacks, glyph to Chat SDK emoji name, as the adapter maps them. */
const TAPBACK_NAMES = new Map([
  ["❤️", "heart"],
  ["\u{1F44D}", "thumbs_up"],
  ["\u{1F44E}", "thumbs_down"],
  ["\u{1F602}", "laugh"],
  ["‼️", "exclamation"],
  ["❓", "question"],
]);

type ThreadLike = { id: string; toJSON(): unknown };
type ChatMessageLike = Parameters<typeof toInbound>[1] & { threadId: string };

export type ParsedDelivery =
  | { kind: "message"; message: ChatMessageLike; thread: ThreadLike }
  | { kind: "reaction"; reaction: Parameters<typeof toReaction>[0]; thread: ThreadLike };

/**
 * Reads a stored payload the way the adapter reads a webhook: its own `parseMessage` (with the space's
 * line, as the webhook path passes it) for the message and its thread id, and the tapback's target and
 * glyph for a reaction. `thread` builds the Chat SDK thread replies post to.
 */
export function parseDelivery(
  payload: PhotonWebhookPayload,
  adapter: { parseMessage(raw: unknown): ChatMessageLike; thread(threadId: string): ThreadLike },
): ParsedDelivery {
  const { message, space } = payload;
  const phone = space.phone ?? message.space?.phone;
  const parsed = adapter.parseMessage({ ...message, space: { ...space, ...(phone ? { phone } : {}) } });
  const thread = adapter.thread(parsed.threadId);
  if (message.content?.type === "reaction") {
    const glyph = String(message.content.emoji);
    return {
      kind: "reaction",
      thread,
      reaction: {
        raw: message,
        messageId: reactionTarget(message.content.target) ?? "",
        emoji: { name: getEmoji(TAPBACK_NAMES.get(glyph) ?? glyph).name },
        rawEmoji: glyph,
        user: { userId: str(message.sender?.id) ?? "" },
        threadId: parsed.threadId,
        thread,
      },
    };
  }
  return { kind: "message", message: parsed, thread };
}

/** What the handler needs from the channel. The channel module supplies the real ones; tests fake them. */
export interface PhotonRuntime {
  /** Starts or continues the turn on this thread's eve session (`from(sessionAddress(thread.id)).send`). */
  send(thread: ThreadLike, content: string | UserContent, options: { auth: SessionAuthContext; context: string[]; turnPolicy: "queue" }): Promise<unknown>;
  post: DispatchDeps["post"];
  markRead: DispatchDeps["markRead"];
  parse(payload: PhotonWebhookPayload): ParsedDelivery;
  /** The Chat SDK thread for a stored iMessage thread id: where a forwarded email's turn runs. */
  thread?: (threadId: string) => ThreadLike;
  download?: (id: string) => Promise<Uint8Array>;
  /** A forwarded email's attachment bytes; defaults to AgentMail's (core/agentmail.ts). */
  downloadEmail?: EmailDeps["download"];
  storeAttachment?: DispatchDeps["storeAttachment"];
  /** Readies the adapter (its Photon client) before the first post or download. */
  ready?: () => Promise<void>;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Waits, up to `PREVIOUS_TURN_WAIT_MS`, until the member's previous handed-off text has reached eve and
 * no turn is running in their thread. Past that it hands over anyway (eve then queues it), logged.
 */
async function waitForPreviousTurn(
  delivery: Parameters<DeliveryHandler>[0],
  clock: () => Date,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const previous = await previousHandOff(delivery, clock());
  if (!previous) return;
  const deadline = clock().getTime() + PREVIOUS_TURN_WAIT_MS;
  while (clock().getTime() < deadline) {
    if ((await deliveryReachedEve(delivery.orgId, previous.id)) && !(await threadTurnRunning(delivery.orgId, delivery.memberId, clock()))) return;
    await sleep(PREVIOUS_TURN_POLL_MS);
  }
  console.warn("photon: the previous turn is still going; handing this text over to queue behind it", {
    deliveryId: delivery.id,
    previousDeliveryId: previous.id,
  });
}

/**
 * Whether an earlier try's hand-off reached eve: yes once the turn's events carry this delivery;
 * otherwise wait while it could still be queued behind a running turn, then send it again.
 */
async function handOffState(
  delivery: Parameters<DeliveryHandler>[0],
  startedAt: string,
  now: Date,
): Promise<"reached" | "wait" | "resend"> {
  if (await deliveryReachedEve(delivery.orgId, delivery.id)) return "reached";
  const age = now.getTime() - new Date(startedAt).getTime();
  if (age < HANDOFF_GRACE_MS) return "wait";
  if (age < HANDOFF_MAX_WAIT_MS && (await threadTurnRunning(delivery.orgId, delivery.memberId, now))) return "wait";
  return "resend";
}

/** The queue's handler for Photon deliveries, and for the emails members forward (core/email-intake.ts). */
export function photonDeliveryHandler(runtime: PhotonRuntime): DeliveryHandler {
  const clock = runtime.clock ?? (() => new Date());
  const sleep = runtime.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let readied: Promise<void> | null = null;
  return async (delivery, step) => {
    const now = clock();
    const startedAt = step.progress.dispatchStartedAt;
    if (startedAt) {
      const state = await handOffState(delivery, startedAt, now);
      if (state === "reached") return { kind: "done", outcome: "dispatch" };
      if (state === "wait") return { kind: "later", at: new Date(now.getTime() + HANDOFF_RECHECK_MS), reason: "handoff_unconfirmed" };
      console.warn("photon: an earlier hand-off to eve was never confirmed; sending it again", {
        deliveryId: delivery.id,
        orgId: delivery.orgId,
        startedAt,
      });
      await step.save({ dispatchStartedAt: null });
    }
    if (runtime.ready) {
      readied ??= runtime.ready().catch((error) => {
        readied = null;
        throw error;
      });
      await readied;
    }
    const email = delivery.kind === "email";
    // A forwarded email never joins a turn already running in the thread: eve would fold it in, and the
    // turn would run without the email's mark. It waits for the thread to be quiet.
    if (email && (await threadTurnRunning(delivery.orgId, delivery.memberId, now))) {
      return { kind: "later", at: new Date(now.getTime() + HANDOFF_RECHECK_MS), reason: "turn_running" };
    }
    const parsed = email ? null : runtime.parse(delivery.payload as unknown as PhotonWebhookPayload);
    const channel = email ? "email" : "text";
    const deps: DispatchDeps = {
      // The delivery rides on the turn's auth, so the turn's events show eve got it.
      send: (content, options) =>
        runtime.send(parsed?.thread ?? (options.thread as ThreadLike), content, {
          auth: { ...options.auth, attributes: { ...options.auth.attributes, deliveryId: delivery.id } },
          context: options.context,
          turnPolicy: options.turnPolicy,
        }),
      post: runtime.post,
      markRead: runtime.markRead,
      now,
      storeAttachment: runtime.storeAttachment,
      delivery: {
        attempt: delivery.attempts,
        progress: step.progress,
        save: step.save,
        beforeHandOff: () => waitForPreviousTurn(delivery, clock, sleep),
        now: clock,
        // One reservation per delivery: a retried hand-off is the same turn.
        admit: async () => {
          const thread = await threadFor(delivery.orgId, delivery.memberId);
          return admitTurn({
            orgId: delivery.orgId,
            memberId: delivery.memberId,
            channel,
            key: `${channel}:${delivery.id}`,
            eveSessionId: thread?.eveSessionId ?? null,
            now: clock(),
          });
        },
      },
    };
    const decision = !parsed
      ? await handleEmail(delivery, {
          ...deps,
          thread: (threadId) => {
            if (!runtime.thread) throw new Error("photon: no thread builder for a forwarded email");
            return runtime.thread(threadId);
          },
          download: runtime.downloadEmail,
        })
      : parsed.kind === "message"
        ? await handleInbound(toInbound(parsed.thread, parsed.message, { download: runtime.download }), deps)
        : await handleReaction(toReaction(parsed.reaction), deps);
    // Over the business's usage limits, the text stays queued (and its later texts behind it) until then.
    if (decision.kind === "held") return { kind: "later", at: decision.retryAt, reason: "usage_limit" };
    return { kind: "done", outcome: decision.kind === "ignore" ? `ignore:${decision.reason}` : decision.kind };
  };
}
