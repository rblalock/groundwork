import type { BetterAuthPlugin, User } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { linkMemberUser, type Member } from "../core/members";
import { defer } from "../core/deferred";
import { requestLoginCode, verifyLoginCode, type LoginCodeDeps } from "./login-codes";

let testDeps: LoginCodeDeps | null = null;

/** Tests swap in a fake poster and clock. Pass null to restore the real ones. */
export function setLoginCodeDepsForTests(deps: LoginCodeDeps | null): void {
  testDeps = deps;
}

/** Better Auth requires an email; phone sign-ins get one that can never receive mail. */
export const placeholderEmail = (member: Pick<Member, "id">) => `${member.id}@members.invalid`;

/** The parts of Better Auth's internal adapter a phone sign-in uses. */
type Users = {
  findUserById(id: string): Promise<User | null>;
  findUserByEmail(email: string): Promise<{ user: User } | null>;
  createUser(data: { name: string; email: string; emailVerified: boolean }, source: { method: "phone-number" }): Promise<User>;
};

/** The member's web login: their linked user, or a new one on their first sign-in. */
async function userForMember(users: Users, member: Member): Promise<User> {
  if (member.userId) {
    const linked = await users.findUserById(member.userId);
    if (linked) return linked;
  }
  const email = placeholderEmail(member);
  const existing = await users.findUserByEmail(email);
  const created = existing?.user ?? (await users.createUser({ name: member.name, email, emailVerified: false }, { method: "phone-number" }));
  // A concurrent first sign-in may have linked another user first; that one wins.
  const linkedId = await linkMemberUser(member.orgId, member.id, created.id);
  if (linkedId && linkedId !== created.id) {
    const winner = await users.findUserById(linkedId);
    if (winner) return winner;
  }
  return created;
}

const phone = z.string().trim().min(1).max(40);

/**
 * Sign-in by a code the assistant texts. `/phone-code/send` answers the same for every phone, and at
 * once: the lookup, save, and text run after the response, so neither the answer nor its timing tells
 * who is a member. `/phone-code/verify` signs the member in, creating their user on the first sign-in,
 * and opens their business.
 */
export const phoneCode = () =>
  ({
    id: "phone-code",
    endpoints: {
      sendPhoneCode: createAuthEndpoint(
        "/phone-code/send",
        { method: "POST", body: z.object({ phone }) },
        async (ctx) => {
          const { phone } = ctx.body;
          const deps = testDeps ?? {};
          // After the response (`core/deferred.ts`): Next's `after()` in the web app.
          defer(async () => {
            try {
              await requestLoginCode(phone, deps);
            } catch (error) {
              console.error("login code: request failed", error);
            }
          });
          return ctx.json({ ok: true });
        },
      ),
      verifyPhoneCode: createAuthEndpoint(
        "/phone-code/verify",
        { method: "POST", body: z.object({ phone, code: z.string().trim().min(1).max(12) }) },
        async (ctx) => {
          const result = await verifyLoginCode(ctx.body.phone, ctx.body.code, testDeps ?? {});
          if (!result.ok) {
            throw new APIError("UNAUTHORIZED", {
              code: result.reason === "too_many_attempts" ? "TOO_MANY_ATTEMPTS" : "INVALID_CODE",
              message:
                result.reason === "too_many_attempts"
                  ? "Too many tries. Ask for a new code."
                  : "That code didn't work. Check it, or ask for a new one.",
            });
          }
          const user = await userForMember(ctx.context.internalAdapter, result.member);
          const session = await ctx.context.internalAdapter.createSession(user.id, false, {
            activeOrganizationId: result.member.orgId,
          });
          if (!session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Could not sign you in. Try again." });
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ ok: true });
        },
      ),
    },
    // Per IP, on top of the per-phone limits in login-codes.ts.
    rateLimit: [
      { pathMatcher: (path: string) => path === "/phone-code/send", window: 60, max: 5 },
      { pathMatcher: (path: string) => path === "/phone-code/verify", window: 60, max: 10 },
    ],
  }) satisfies BetterAuthPlugin;
