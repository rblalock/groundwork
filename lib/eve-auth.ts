import { ForbiddenError, localDev, type AuthFn } from "eve/channels/auth";
import type { SessionAuthContext } from "eve/context";
import { agentSessionFor, ownAgentSession } from "../core/agent-sessions";
import { memberConversationForSession, threadOwnerForLocalDev } from "../core/conversations";
import { CUSTOMER_PAGE_KINDS, type CustomerPageKind } from "../core/customer-page-template";
import { JOB_TOKEN_PREFIX, verifyJobToken } from "../core/job-token";
import { getOwnJob, jobForSession, mayReadJob } from "../core/jobs";
import { APP_JOB, APP_WEB, findMemberById, isPrivileged, jobPrincipalId } from "../core/members";
import { isSuspended } from "../core/organizations";
import { ON_SCREEN_HEADER } from "./on-screen";
import { onScreenRecord } from "./pages/on-screen";
import { admitTurn, releaseTurn, type UsageChannel } from "../core/usage-limits";
import type { Language } from "../core/language";
import { getViewer, resolveAppCaller } from "./guards";

// The web app talks to the agent's eve routes on the same origin, so the browser's Better Auth cookie
// rides along. This turns it into the member's eve principal, and lets them act only on a session
// that is one of their own conversations: their thread or one of their jobs. The agent runs as its own
// service on the same database, so it reads the session with the same BETTER_AUTH_SECRET. The agent
// itself drives a member's jobs with a signed job token (`jobRuntimeAuth`).

const SESSION_PATH = /\/session\/([^/]+)/;
const PAUSED = "This business is paused.";
const CREATE_PATH = /\/session\/?$/;
const STREAM_PATH = /\/session\/[^/]+\/stream\/?$/;
const CONTEXT_RESET = /\/session\/[^/]+\/(reset|clear|compact)\/?$/;
/** A message (or input response) into an existing session: the request that starts a turn. */
const SEND_PATH = /\/session\/[^/]+\/?$/;

/** The words a refused web or job turn shows, in the member's language. */
export function usageLimitMessage(language: Language): string {
  return language === "es"
    ? "Tu negocio llegó a su límite de uso del asistente por esta hora. Inténtalo de nuevo en unos minutos."
    : "Your business hit its assistant usage limit for this hour. Try again in a few minutes.";
}

/** A 429 for a turn over its business's usage limits, with when to try again. */
export class UsageLimitedError extends ForbiddenError {
  override readonly response: Response;
  constructor(language: Language, retryAt: Date, reason: string) {
    const message = usageLimitMessage(language);
    super({ message });
    const retryAfterSeconds = Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1000));
    this.response = Response.json(
      { error: message, code: "USAGE_LIMIT", reason, retryAfterSeconds },
      { status: 429, headers: { "retry-after": String(retryAfterSeconds) } },
    );
  }
}

/** Admitted requests, so the channel can release a reservation whose request eve then refused. */
const admitted = new WeakMap<Request, { orgId: string; reservationId: string }>();

/**
 * Admits the turn this request starts under the business's usage limits, or refuses it with a 429.
 * The reservation's id rides on the turn's auth, for the usage hook and the metered model.
 */
async function admitRequest(
  request: Request,
  who: { orgId: string; memberId: string; language: Language; channel: UsageChannel; eveSessionId: string | null },
): Promise<string> {
  const admission = await admitTurn({
    orgId: who.orgId,
    memberId: who.memberId,
    channel: who.channel,
    key: `${who.channel}:${crypto.randomUUID()}`,
    eveSessionId: who.eveSessionId,
  });
  if (!admission.ok) throw new UsageLimitedError(who.language, admission.retryAt, admission.reason);
  admitted.set(request, { orgId: who.orgId, reservationId: admission.reservationId });
  return admission.reservationId;
}

/**
 * Wraps eve's HTTP channel so a turn eve refused to accept (a bad body, a session not ready) gives its
 * reservation back instead of holding a slot until the lease runs out.
 */
export function withUsageAdmission<T extends { routes: readonly unknown[] }>(channel: T): T {
  type HttpRoute = { method: string; path: string; handler: (request: Request, ...rest: unknown[]) => Promise<Response> };
  const routes = channel.routes.map((route) => {
    const http = route as HttpRoute;
    if (http.method !== "POST" || typeof http.handler !== "function") return route;
    return {
      ...http,
      handler: async (request: Request, ...rest: unknown[]) => {
        try {
          const response = await http.handler(request, ...rest);
          const admission = admitted.get(request);
          if (admission && !response.ok) {
            await releaseTurn(admission.orgId, admission.reservationId).catch((error) =>
              console.error("usage: a refused turn's reservation was not released", { reservationId: admission.reservationId, error }),
            );
          }
          return response;
        } finally {
          admitted.delete(request);
        }
      },
    };
  });
  return { ...channel, routes };
}

/**
 * The eve channel's auth for signed-in members. Skips (null) a request with no app session, so the
 * walk moves on (`localDev()` in development, a 401 in production). Refuses a signed-in caller who is
 * not a member (a super admin's read-only view included), any brand-new session (a member's thread is
 * started by their first text, or by Home on the Photon channel, `webThreadStarter`; jobs are opened by
 * the assistant), clearing or resetting a conversation, writing in an archived job, and a session
 * that isn't one of the member's conversations. An owner or admin may read (stream, nothing else) a
 * crew member's job about a quote or customer.
 */
export function appWebAuth(): AuthFn<Request> {
  return async (request) => {
    if (!request.headers.get("cookie")) return null;
    const viewer = await getViewer(request.headers);
    if (!viewer) return null;
    const caller = await resolveAppCaller(viewer);
    if (!caller) throw new ForbiddenError({ message: "You're not a member of a business." });
    if (!caller.memberId) {
      throw new ForbiddenError({ message: "Super admins can look, but only members can talk to the assistant." });
    }
    if (caller.suspended) throw new ForbiddenError({ message: PAUSED });
    const { pathname } = new URL(request.url);
    if (CONTEXT_RESET.test(pathname)) {
      throw new ForbiddenError({ message: "Your thread with the assistant can't be cleared." });
    }
    const match = pathname.match(SESSION_PATH);
    if (!match) {
      throw new ForbiddenError({ message: "Text the assistant first. The web app continues that thread." });
    }
    const sessionId = decodeURIComponent(match[1]);
    const principal = (conversationId: string, conversationKind: string, readOnly = false): SessionAuthContext => ({
      authenticator: APP_WEB,
      principalId: viewer.userId,
      principalType: "user",
      attributes: {
        orgId: caller.orgId,
        memberId: caller.memberId!,
        conversationId,
        conversationKind,
        ...(readOnly ? { readOnly: "1" } : {}),
      },
    });
    const conversation = await memberConversationForSession(caller.orgId, caller.memberId, sessionId);
    if (!conversation) {
      if (request.method === "GET" && STREAM_PATH.test(pathname)) {
        const job = await jobForSession(caller.orgId, sessionId);
        if (job && mayReadJob({ ...caller, memberId: caller.memberId }, job)) return principal(job.id, "job", true);
      }
      throw new ForbiddenError({ message: "That conversation isn't yours." });
    }
    if (conversation.kind === "job" && conversation.status === "archived" && request.method !== "GET") {
      throw new ForbiddenError({ message: "That job is archived." });
    }
    const auth = principal(conversation.id, conversation.kind);
    if (request.method === "POST" && SEND_PATH.test(pathname)) {
      const onScreen = await onScreenRecord(caller, request.headers.get(ON_SCREEN_HEADER));
      const reservationId = await admitRequest(request, {
        orgId: caller.orgId,
        memberId: caller.memberId,
        language: caller.language,
        channel: "web",
        eveSessionId: sessionId,
      });
      return { ...auth, attributes: { ...auth.attributes, reservationId, ...(onScreen ? { onScreen: JSON.stringify(onScreen) } : {}) } };
    }
    return auth;
  };
}

/**
 * Who may start their thread from the web app (the Photon channel's thread route): a signed-in member
 * of an open business, as the principal their web turns run as. Null for anyone else.
 */
export async function webThreadStarter(request: Request): Promise<{ orgId: string; memberId: string; auth: SessionAuthContext } | null> {
  if (!request.headers.get("cookie")) return null;
  const viewer = await getViewer(request.headers);
  const caller = viewer && (await resolveAppCaller(viewer));
  if (!viewer || !caller?.memberId || caller.suspended) return null;
  const auth: SessionAuthContext = {
    authenticator: APP_WEB,
    principalId: viewer.userId,
    principalType: "user",
    attributes: { orgId: caller.orgId, memberId: caller.memberId, conversationKind: "thread" },
  };
  return { orgId: caller.orgId, memberId: caller.memberId, auth };
}

/** Names the customer page a new designer session is for (`designerWebAuth`). */
export const DESIGN_PAGE_HEADER = "x-gw-design-page";

const isPageKind = (value: string | null): value is CustomerPageKind => CUSTOMER_PAGE_KINDS.includes(value as CustomerPageKind);

/**
 * The designer's eve channel auth (agents/designer/), for signed-in owners and admins only. A member
 * talks to the designer in one session per customer page, recorded in `agent_sessions`: creating one
 * needs `DESIGN_PAGE_HEADER` naming a page they have none for yet and no message
 * (lib/pages/customer-pages.ts creates it with their cookie), and every other request must address
 * one of theirs, so each turn is admitted under the business's usage limits. Nothing clears or resets it.
 * The page rides on the turn's auth, for the designer's context.
 */
export function designerWebAuth(): AuthFn<Request> {
  return async (request) => {
    if (!request.headers.get("cookie")) return null;
    const viewer = await getViewer(request.headers);
    if (!viewer) return null;
    const caller = await resolveAppCaller(viewer);
    if (!caller?.memberId) throw new ForbiddenError({ message: "Only members can design the business's pages." });
    if (!isPrivileged(caller.role)) throw new ForbiddenError({ message: "Only the owner or an admin can design the business's pages." });
    if (caller.suspended) throw new ForbiddenError({ message: PAUSED });
    const who = { orgId: caller.orgId, memberId: caller.memberId };
    const { pathname } = new URL(request.url);
    if (CONTEXT_RESET.test(pathname)) throw new ForbiddenError({ message: "A page's design conversation can't be cleared." });
    const principal = (page: string): SessionAuthContext => ({
      authenticator: APP_WEB,
      principalId: viewer.userId,
      principalType: "user",
      attributes: { orgId: caller.orgId, memberId: who.memberId, page },
    });
    const match = pathname.match(SESSION_PATH);
    if (!match) {
      const page = request.headers.get(DESIGN_PAGE_HEADER);
      if (request.method !== "POST" || !CREATE_PATH.test(pathname) || !isPageKind(page) || (await agentSessionFor(who, "designer", page))) {
        throw new ForbiddenError({ message: "Open the page's designer to talk to it." });
      }
      // Created empty, never with a first message: every turn goes through a recorded session, and is admitted there.
      if ((await request.clone().text()).trim() !== "") throw new ForbiddenError({ message: "Open the page's designer to talk to it." });
      return principal(page);
    }
    const session = await ownAgentSession(who, "designer", decodeURIComponent(match[1]));
    if (!session) throw new ForbiddenError({ message: "That conversation isn't yours." });
    const auth = principal(session.subject);
    if (request.method === "POST" && SEND_PATH.test(pathname)) {
      const reservationId = await admitRequest(request, { ...who, language: caller.language, channel: "web", eveSessionId: session.eveSessionId });
      return { ...auth, attributes: { ...auth.attributes, reservationId } };
    }
    return auth;
  };
}

/**
 * The eve channel's auth for the agent driving a member's job (core/jobs.ts). Skips (null) any
 * request without a job token. A valid token names one business, member, and job: the member must
 * still be active, the job theirs and not archived, and the request either creates the job's first
 * session or addresses the session the job already has. Nothing can clear or reset it.
 */
export function jobRuntimeAuth(): AuthFn<Request> {
  return async (request) => {
    const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!bearer?.startsWith(JOB_TOKEN_PREFIX)) return null;
    const claims = verifyJobToken(bearer);
    if (!claims) throw new ForbiddenError({ message: "That job token isn't valid." });
    const member = await findMemberById(claims.orgId, claims.memberId);
    if (!member || member.status !== "active") throw new ForbiddenError({ message: "That member isn't active." });
    if (await isSuspended(member.orgId)) throw new ForbiddenError({ message: PAUSED });
    const job = await getOwnJob(claims.orgId, claims.memberId, claims.conversationId);
    if (!job) throw new ForbiddenError({ message: "That job isn't theirs." });
    if (job.status === "archived") throw new ForbiddenError({ message: "That job is archived." });
    const { pathname } = new URL(request.url);
    if (CONTEXT_RESET.test(pathname)) throw new ForbiddenError({ message: "A job can't be cleared." });
    const match = pathname.match(SESSION_PATH);
    if (match) {
      if (decodeURIComponent(match[1]) !== job.eveSessionId) throw new ForbiddenError({ message: "That session isn't this job's." });
    } else if (!(request.method === "POST" && CREATE_PATH.test(pathname) && !job.eveSessionId)) {
      throw new ForbiddenError({ message: "A job token only opens the job's own session." });
    }
    const auth: SessionAuthContext = {
      authenticator: APP_JOB,
      principalId: jobPrincipalId(member.id),
      principalType: "user",
      attributes: {
        orgId: member.orgId,
        memberId: member.id,
        conversationId: job.id,
        conversationKind: "job",
        // An email's turn in its thread: its tools refuse as on any email turn, and the queue sees it arrive.
        ...(claims.origin ? { origin: claims.origin } : {}),
        ...(claims.deliveryId ? { deliveryId: claims.deliveryId } : {}),
      },
    };
    // A message into the job's session, or a session created with its first message, starts a turn.
    const startsTurn =
      request.method === "POST" && (SEND_PATH.test(pathname) || (CREATE_PATH.test(pathname) && (await request.clone().text()).trim() !== ""));
    if (startsTurn && claims.reservationId) {
      // The queue already admitted this email's turn (one reservation per delivery, retries included).
      return { ...auth, attributes: { ...auth.attributes, reservationId: claims.reservationId } };
    }
    if (startsTurn) {
      const reservationId = await admitRequest(request, {
        orgId: member.orgId,
        memberId: member.id,
        language: member.language === "es" ? "es" : "en",
        channel: "job",
        eveSessionId: job.eveSessionId,
      });
      return { ...auth, attributes: { ...auth.attributes, reservationId } };
    }
    return auth;
  };
}

/**
 * Local development and evals only: a `local-dev` turn on a session that is a member's thread runs as
 * that member (`attributes.memberId`), so an eval can talk as crew, not only as the owner `localDev()`
 * stands for. It answers only where eve's own `localDev()` does (an eve dev server, never production),
 * and skips (null) any other session, which then falls through to `localDev()` itself.
 */
export function localDevThread(): AuthFn<Request> {
  const dev = localDev();
  return async (request) => {
    const base = await dev(request);
    if (!base) return null;
    const match = new URL(request.url).pathname.match(SESSION_PATH);
    if (!match) return null;
    const owner = await threadOwnerForLocalDev(decodeURIComponent(match[1]));
    if (!owner) return null;
    if (await isSuspended(owner.orgId)) throw new ForbiddenError({ message: PAUSED });
    return { ...base, attributes: { orgId: owner.orgId, memberId: owner.memberId } };
  };
}
