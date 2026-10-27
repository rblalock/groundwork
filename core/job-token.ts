import { createHmac, timingSafeEqual } from "node:crypto";

// A job runs in its own eve session, which the assistant opens and drives server-side, as the member
// whose thread asked for it. The agent reaches its own eve channel over HTTP, so it signs a short-lived
// bearer token with the app's BETTER_AUTH_SECRET (which the agent already has, to read web sign-ins),
// scoped to one business, one member, and one job conversation. The eve channel's auth
// (lib/eve-auth.ts, `jobRuntimeAuth`) checks it again against the database on every request.

/** Marks our tokens, so the eve channel's auth can skip a bearer that isn't one. */
export const JOB_TOKEN_PREFIX = "gwjob.";
const TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * One business, member, and job. An email's turn in its thread (core/email-intake.ts) also carries
 * `origin: "email"`, so its tools refuse money and team actions as on any email turn, the queue's
 * `deliveryId`, so the queue sees the turn reached eve, and the `reservationId` the queue admitted it under.
 */
export type JobClaims = {
  orgId: string;
  memberId: string;
  conversationId: string;
  origin?: "email";
  deliveryId?: string;
  reservationId?: string;
};
type Signed = JobClaims & { v: 1; exp: number };

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("BETTER_AUTH_SECRET is not set, so job sessions can't be signed.");
  return value;
}

// Domain-separated from anything else the secret signs.
const sign = (body: string) => createHmac("sha256", secret()).update(`gw-job-runtime:${body}`).digest("base64url");

/** A bearer token for one job conversation, good for five minutes. Sign a fresh one per request. */
export function jobToken(claims: JobClaims, now: number = Date.now()): string {
  const signed: Signed = {
    v: 1,
    orgId: claims.orgId,
    memberId: claims.memberId,
    conversationId: claims.conversationId,
    ...(claims.origin ? { origin: claims.origin } : {}),
    ...(claims.deliveryId ? { deliveryId: claims.deliveryId } : {}),
    ...(claims.reservationId ? { reservationId: claims.reservationId } : {}),
    exp: now + TOKEN_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(signed)).toString("base64url");
  return `${JOB_TOKEN_PREFIX}${body}.${sign(body)}`;
}

/** The claims of a valid, unexpired token, or null for anything else (bad signature, expired, malformed). */
export function verifyJobToken(token: string, now: number = Date.now()): JobClaims | null {
  if (!token.startsWith(JOB_TOKEN_PREFIX)) return null;
  const [body, signature, extra] = token.slice(JOB_TOKEN_PREFIX.length).split(".");
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString()) as Partial<Signed>;
    if (value.v !== 1 || typeof value.exp !== "number" || value.exp <= now) return null;
    if (typeof value.orgId !== "string" || typeof value.memberId !== "string" || typeof value.conversationId !== "string") return null;
    if (!value.orgId || !value.memberId || !value.conversationId) return null;
    if (value.origin !== undefined && value.origin !== "email") return null;
    if (value.deliveryId !== undefined && typeof value.deliveryId !== "string") return null;
    if (value.reservationId !== undefined && typeof value.reservationId !== "string") return null;
    return {
      orgId: value.orgId,
      memberId: value.memberId,
      conversationId: value.conversationId,
      ...(value.origin ? { origin: value.origin } : {}),
      ...(value.deliveryId ? { deliveryId: value.deliveryId } : {}),
      ...(value.reservationId ? { reservationId: value.reservationId } : {}),
    };
  } catch {
    return null;
  }
}
