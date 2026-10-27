import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, gte, isNull, lt, sql } from "drizzle-orm";
import { loginCodes } from "../schema/schema";
import { db, newId } from "../core/db";
import { isLanguage, type Language } from "../core/language";
import { findMemberByPhone, normalizeE164, type Member, type MemberPhone } from "../core/members";
import { isSuspended } from "../core/organizations";
import { postToMember, postToPhone } from "../core/outbound";

// Members sign in to the web app with a 6-digit code the assistant posts in their iMessage thread. Only
// a phone that is verified (it texted the line, or an admin vouched for it at provisioning) can get one,
// so nothing ever texts a stranger, and the reply to a request is the same whether or not the phone is known.

export const CODE_TTL_MINUTES = 10;
/** Codes a phone can be sent in `SEND_WINDOW_MINUTES`. */
export const MAX_SENDS = 3;
export const SEND_WINDOW_MINUTES = 15;
/** Wrong guesses before a code stops working. */
export const MAX_ATTEMPTS = 5;

/**
 * Texts the member. The real one posts in their thread as a `system` message, logged without the code,
 * or to `e164` directly when the member has not texted yet.
 */
export type CodePoster = (
  orgId: string,
  memberId: string,
  text: string,
  logText: string,
  e164: string,
) => Promise<{ posted: boolean; reason?: string }>;

export type LoginCodeDeps = { now?: Date; post?: CodePoster; generate?: () => string };

const defaultPost: CodePoster = async (orgId, memberId, text, logText, e164) => {
  const result = await postToMember(orgId, memberId, { text, logText }, "system");
  if (result.posted || result.reason !== "never_texted") return result;
  return postToPhone(orgId, memberId, e164, { text, logText });
};

/**
 * What a code's text is logged with in its place: the `messages` log never holds a code. The web thread
 * also leaves out every logged text holding this, so sign-in notices never show there.
 */
export const CODE_MASK = "······";

export function codeText(code: string, language: Language): string {
  return language === "es"
    ? `Tu código para entrar es ${code}. Vence en ${CODE_TTL_MINUTES} minutos. Si no lo pediste, ignora este mensaje.`
    : `Your sign-in code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes. If you didn't ask for it, ignore this text.`;
}

function hashKey(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (secret) return secret;
  if (process.env.VERCEL_ENV === "production") throw new Error("BETTER_AUTH_SECRET must be set.");
  return "local-dev-login-code-key";
}

/** Keyed by the auth secret and bound to the phone, so a leaked table can't be brute-forced offline. */
function hashCode(e164: string, code: string): string {
  return createHmac("sha256", hashKey()).update(`${e164}:${code}`).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

const sixDigits = () => randomInt(0, 1_000_000).toString().padStart(6, "0");
const minutes = (n: number) => n * 60 * 1000;

/** An active member whose phone is verified: the only people a code goes to. */
function canSignIn(found: { member: Member; phone: MemberPhone } | null): found is { member: Member; phone: MemberPhone } {
  return Boolean(found && found.member.status === "active" && found.phone.status === "verified");
}

export type RequestResult =
  | { sent: true; orgId: string; memberId: string }
  | { sent: false; reason: "invalid_phone" | "unknown" | "rate_limited" | "send_failed" | "suspended" };

/**
 * Texts a new code to the member who owns the phone, replacing any earlier one. Callers answer every
 * result the same way; the reason is for tests and logs.
 */
export async function requestLoginCode(phoneInput: string, deps: LoginCodeDeps = {}): Promise<RequestResult> {
  const now = deps.now ?? new Date();
  const e164 = normalizeE164(phoneInput);
  if (!e164) return { sent: false, reason: "invalid_phone" };
  const found = await findMemberByPhone(e164);
  if (!canSignIn(found)) return { sent: false, reason: "unknown" };
  const { member } = found;
  // A paused business's members can't sign in, and nothing texts them.
  if (await isSuspended(member.orgId)) return { sent: false, reason: "suspended" };

  const [{ count }] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(loginCodes)
    .where(and(eq(loginCodes.phoneE164, e164), gte(loginCodes.createdAt, new Date(now.getTime() - minutes(SEND_WINDOW_MINUTES)))));
  if (count >= MAX_SENDS) return { sent: false, reason: "rate_limited" };

  const code = (deps.generate ?? sixDigits)();
  const id = newId("lc");
  await db().transaction(async (tx) => {
    // A new code replaces the old one: only the latest text works.
    await tx
      .update(loginCodes)
      .set({ consumedAt: now })
      .where(and(eq(loginCodes.phoneE164, e164), isNull(loginCodes.consumedAt)));
    await tx.insert(loginCodes).values({
      id,
      orgId: member.orgId,
      memberId: member.id,
      phoneE164: e164,
      codeHash: hashCode(e164, code),
      expiresAt: new Date(now.getTime() + minutes(CODE_TTL_MINUTES)),
      createdAt: now,
    });
  });

  if (process.env.LOGIN_CODE_LOG === "1" && process.env.VERCEL_ENV !== "production") {
    console.log(`login code for ${e164}: ${code}`);
  }
  const language: Language = isLanguage(member.language) ? member.language : "en";
  const result = await (deps.post ?? defaultPost)(
    member.orgId,
    member.id,
    codeText(code, language),
    codeText(CODE_MASK, language),
    e164,
  );
  if (!result.posted) {
    // A code nobody received shouldn't count against them or stay usable.
    await db().delete(loginCodes).where(eq(loginCodes.id, id));
    console.warn("login code: not posted", { memberId: member.id, reason: result.reason });
    return { sent: false, reason: "send_failed" };
  }
  return { sent: true, orgId: member.orgId, memberId: member.id };
}

export type VerifyResult =
  | { ok: true; member: Member; phone: MemberPhone }
  | { ok: false; reason: "invalid_phone" | "no_code" | "wrong_code" | "too_many_attempts" | "not_a_member" | "suspended" };

/**
 * Checks a code against the phone's latest one and uses it up. Every guess counts; after
 * `MAX_ATTEMPTS` the code stops working. The member is checked again, since they may have been
 * removed since the text went out.
 */
export async function verifyLoginCode(phoneInput: string, codeInput: string, deps: Pick<LoginCodeDeps, "now"> = {}): Promise<VerifyResult> {
  const now = deps.now ?? new Date();
  const e164 = normalizeE164(phoneInput);
  if (!e164) return { ok: false, reason: "invalid_phone" };
  const code = codeInput.replace(/\D/g, "");

  const [latest] = await db()
    .select()
    .from(loginCodes)
    .where(and(eq(loginCodes.phoneE164, e164), isNull(loginCodes.consumedAt), gt(loginCodes.expiresAt, now)))
    .orderBy(desc(loginCodes.createdAt), desc(loginCodes.id))
    .limit(1);
  if (!latest) return { ok: false, reason: "no_code" };

  // Claim the guess before checking it, so concurrent guesses can't exceed the limit.
  const [claimed] = await db()
    .update(loginCodes)
    .set({ attempts: sql`${loginCodes.attempts} + 1` })
    .where(and(eq(loginCodes.id, latest.id), isNull(loginCodes.consumedAt), lt(loginCodes.attempts, MAX_ATTEMPTS)))
    .returning({ attempts: loginCodes.attempts });
  if (!claimed) return { ok: false, reason: "too_many_attempts" };

  if (code.length !== 6 || !sameHash(latest.codeHash, hashCode(e164, code))) {
    if (claimed.attempts >= MAX_ATTEMPTS) {
      await db().update(loginCodes).set({ consumedAt: now }).where(eq(loginCodes.id, latest.id));
      return { ok: false, reason: "too_many_attempts" };
    }
    return { ok: false, reason: "wrong_code" };
  }

  const used = await db()
    .update(loginCodes)
    .set({ consumedAt: now })
    .where(and(eq(loginCodes.id, latest.id), isNull(loginCodes.consumedAt)))
    .returning({ id: loginCodes.id });
  if (used.length === 0) return { ok: false, reason: "no_code" };

  const found = await findMemberByPhone(e164);
  if (!canSignIn(found) || found.member.id !== latest.memberId || found.member.orgId !== latest.orgId) {
    return { ok: false, reason: "not_a_member" };
  }
  if (await isSuspended(found.member.orgId)) return { ok: false, reason: "suspended" };
  return { ok: true, member: found.member, phone: found.phone };
}
