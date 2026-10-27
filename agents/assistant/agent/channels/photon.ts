import { createMemoryState } from "@chat-adapter/state-memory";
import type { Thread } from "chat";
import { POST, type ChannelFrom, type ChannelResolveSession } from "eve/channels";
import type { SessionAuthContext } from "eve/context";
import { chatSdkChannel, isNotImplemented, type ChatSdkChannelState } from "eve/channels/chat-sdk";
import { handleAssistantMessage, handleFailure, markTurnStarted, repliesByText, trackSession } from "../../../../core/channel-dispatch";
import { startThread, threadFor } from "../../../../core/conversations";
import { drainDeliveries, processMember } from "../../../../core/deliveries";
import { createAdapter, downloadAttachment, postText, registerBot } from "../../../../core/imessage";
import { intakePhotonWebhook, parseDelivery, photonDeliveryHandler } from "../../../../core/photon-inbound";
import { verifyDrainToken } from "../../../../core/worker-token";
import { webThreadStarter } from "../../../../lib/eve-auth";

// Members text the Photon iMessage line. Webhooks no longer run through the Chat SDK's in-memory
// handlers: the route below stores each delivery in Postgres before Photon gets its 200, then works the
// member's queue in order (core/deliveries.ts, core/photon-inbound.ts), and the every-minute
// backstop (agents/assistant/agent/schedules/texts.ts) drains anything left. Each text is still gated by phone in
// channel-dispatch.ts and handed to the member's eve session through this channel's thread
// continuation, as the Chat SDK bridge did, so their thread (which the web app resumes) carries on.
// The Chat SDK channel still owns the session: its events below post replies, typing, and failures.
const adapter = createAdapter({ onMissing: "warn" });

export const { bot, channel } = chatSdkChannel({
  adapters: { imessage: adapter },
  routes: { imessage: "/eve/v1/photon" },
  state: createMemoryState(),
  streaming: false,
  turnPolicy: "queue",
  userName: "Assistant",
  events: {
    // Supplying this replaces eve's default, so it repeats that default's work (reset the tool-call
    // status and stream bookkeeping, show typing) before recording the turn's start and remembering the
    // member's session. The member's thread is one session the web app sends into too, and these events
    // fire for those turns as well: a web turn shows no typing here, and its replies stay on the web.
    async "turn.started"(_event, channelCtx, ctx) {
      channelCtx.state.pendingToolCallMessage = null;
      channelCtx.state.anchorMessageId = null;
      channelCtx.state.lastEditAtMs = null;
      channelCtx.state.streamStepIndex = null;
      if (!repliesByText(ctx.session.auth.current)) return;
      try {
        await channelCtx.thread?.startTyping("Working...");
      } catch (error) {
        if (!isNotImplemented(error)) console.warn("photon: typing indicator failed", error);
      }
      try {
        await markTurnStarted(ctx.session.auth.current);
      } catch (error) {
        console.error("photon: turn start was not recorded", error);
      }
      try {
        await trackSession(ctx.session.auth.current, ctx.session.id);
      } catch (error) {
        console.error("photon: session tracking failed", error);
      }
    },
    // eve's default shows typing with the tool names; a web turn's tools show only on the web.
    async "actions.requested"(_event, channelCtx, ctx) {
      channelCtx.state.pendingToolCallMessage = null;
      if (!repliesByText(ctx.session.auth.current)) return;
      try {
        await channelCtx.thread?.startTyping("Working...");
      } catch (error) {
        if (!isNotImplemented(error)) console.warn("photon: typing indicator failed", error);
      }
    },
    async "message.completed"(event, channelCtx, ctx) {
      await handleAssistantMessage(
        event,
        { state: channelCtx.state, threadId: channelCtx.thread?.id ?? null, auth: ctx.session.auth.current },
        { post: postText, now: new Date() },
      );
    },
    // eve's defaults post the raw error hint in English, straight to the thread. These post one fixed
    // line in the member's language, only to a live member, and log it.
    async "turn.failed"(event, channelCtx, ctx) {
      await handleFailure(
        { threadId: channelCtx.thread?.id ?? null, auth: ctx.session.auth.current },
        { code: event.code, message: event.message, turnId: event.turnId },
        { post: postText, now: new Date() },
      );
    },
    async "session.failed"(event, channelCtx) {
      await handleFailure(
        { threadId: channelCtx.thread?.id ?? null, auth: null },
        { code: event.code, message: event.message, sessionId: event.sessionId },
        { post: postText, now: new Date() },
      );
    },
    // v1 has no eve approval prompts and no connection-gated tools, so these should never fire. eve's
    // defaults would post an English card or auth link to the member; log instead. An unanswered input
    // request is cancelled by the member's next text.
    async "input.requested"(event) {
      console.warn("photon: unexpected input request, not posted", { count: event.requests.length });
    },
    async "authorization.required"(event) {
      console.warn("photon: unexpected authorization request, not posted", { name: event.name });
    },
    async "authorization.completed"(event) {
      console.warn("photon: unexpected authorization completion", { name: event.name, outcome: event.outcome });
    },
  },
});

registerBot(bot);

/**
 * The continuation address of a member's iMessage thread: their one session with the assistant. eve
 * routes a session's work by the name of the agent that started it, and the sessions the app's single
 * agent started before it became `assistant` (agents/) can't run here, so this agent's sessions take
 * addresses of their own. A member's first text since then starts a fresh session, and their thread on
 * the web follows it (`trackSession`).
 */
const sessionAddress = (threadId: string) => `assistant:${threadId}`;

/**
 * The continuation address of a thread the member started on the web, before they ever texted
 * (`threadStart` below). It's started here, not on the eve channel, so this channel's events run its
 * turns: a text that joins it later is answered by text.
 */
const memberAddress = (memberId: string) => `assistant:member:${memberId}`;

/**
 * Where a text goes: into the member's thread when it started on the web (`session`, still at the
 * member's address), carrying this iMessage thread so the reply is texted back; otherwise into this
 * iMessage thread's own session, started by the text if it has none.
 */
async function addressFor(resolveSession: ChannelResolveSession, threadId: string, auth: SessionAuthContext, session: string | null | undefined) {
  const memberId = auth.attributes.memberId;
  if (session && typeof memberId === "string") {
    const started = await resolveSession(memberAddress(memberId));
    if (started?.id === session) return memberAddress(memberId);
  }
  return sessionAddress(threadId);
}

/** The queue's handler, bound to this request's continuation: what `send` did inside a Chat SDK handler. */
function handlerFor(from: ChannelFrom<ChatSdkChannelState>, resolveSession: ChannelResolveSession) {
  return photonDeliveryHandler({
    async send(thread, content, { session, ...options }) {
      const serialized = (thread as Thread).toJSON();
      const address = await addressFor(resolveSession, thread.id, options.auth, session);
      await from(address).send(content, { ...options, state: { thread: serialized } });
    },
    post: postText,
    markRead: (threadId, messageId) => adapter.markRead(threadId, messageId),
    parse: (payload) => parseDelivery(payload, { parseMessage: (raw) => adapter.parseMessage(raw), thread: (id) => bot.thread(id) }),
    thread: (id) => bot.thread(id),
    download: downloadAttachment,
    // The adapter's Photon client is built on first use; downloads need it built first.
    ready: () => bot.initialize(),
  });
}

/** Photon's webhook: store, answer, then work this member's queue in the background. */
const webhook = POST<ChatSdkChannelState>("/eve/v1/photon", async (request, { from, resolveSession, waitUntil }) => {
  const { response, queued } = await intakePhotonWebhook(request, {
    secret: process.env.IMESSAGE_WEBHOOK_SECRET?.trim(),
    encodeThreadId: (data) => adapter.encodeThreadId(data),
  });
  if (queued) {
    waitUntil(
      processMember(queued.orgId, queued.memberId, handlerFor(from, resolveSession)).catch((error) =>
        console.error("photon: the member's queue did not run; the backstop will", { deliveryId: queued.deliveryId, error }),
      ),
    );
  }
  return response;
});

/** The backstop's drain (agents/assistant/agent/schedules/texts.ts), with its signed token. */
const drain = POST<ChatSdkChannelState>("/eve/v1/photon/drain", async (request, { from, resolveSession }) => {
  if (!verifyDrainToken(request.headers.get("authorization"))) return new Response("Unauthorized", { status: 401 });
  return Response.json(await drainDeliveries(handlerFor(from, resolveSession)));
});

/**
 * The web app's Home starts a signed-in member's thread here on their first visit, before they ever
 * texted (lib/pages/assistant.ts, with their cookie). The session waits for its first message, which
 * comes from the web app like any web turn (lib/eve-auth.ts, `appWebAuth`). A member who already has
 * a thread gets it back, and so does one whose text started it meanwhile. Two Home loads at once share
 * one session: `create` hands a concurrent caller the session that won the member's address, and
 * `startThread` keeps the first row.
 */
const threadStart = POST<ChatSdkChannelState>("/eve/v1/photon/thread", async (request, { from }) => {
  const starter = await webThreadStarter(request);
  if (!starter) return Response.json({ error: "Only a member of an open business can start a thread." }, { status: 403 });
  const { orgId, memberId, auth } = starter;
  const existing = await threadFor(orgId, memberId);
  if (existing?.eveSessionId) return Response.json({ sessionId: existing.eveSessionId });
  const { session } = await from(memberAddress(memberId)).create({ auth, state: { thread: null } });
  const thread = await startThread(orgId, memberId, session.id);
  return Response.json({ sessionId: thread.eveSessionId });
});

export default { ...channel, routes: [webhook, drain, threadStart] } satisfies typeof channel;
