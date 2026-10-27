import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins/organization";
import * as schema from "../schema/schema";
import { db } from "../core/db";
import { phoneCode } from "./phone-code-plugin";

export const SUPER_ADMIN = "super_admin";

/**
 * The only emails that can be super admins: `SUPER_ADMIN_EMAILS`, comma-separated. An account with the
 * role whose email isn't listed is treated as no super admin at all. Unset, production allows nobody
 * (it fails closed); elsewhere (local dev, tests) any account with the role.
 */
export function superAdminEmailAllowed(email: string, env: Record<string, string | undefined> = process.env): boolean {
  const list = (env.SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return env.VERCEL_ENV !== "production";
  return list.includes(email.trim().toLowerCase());
}

function baseURL(): string {
  if (process.env.BETTER_AUTH_URL) return process.env.BETTER_AUTH_URL;
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

// The organization plugin adopts our `organization` table: a business. Who belongs to it, and as
// what, stays in our `members` table (`user_id` is the login), which texting already keeps; the
// plugin's own `member` table is required by it and left empty. So every plugin endpoint is off below,
// and the app reads memberships and switches businesses through its own guarded routes. The plugin
// is here for `session.active_organization_id` and the shape self-serve signup will need.
const organizationPlugin = organization({ allowUserToCreateOrganization: false });
const organizationPaths = Object.values(organizationPlugin.endpoints).map((endpoint) => endpoint.path);

function createAuth() {
  return betterAuth({
    appName: "Assistant",
    baseURL: baseURL(),
    secret: process.env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db(), {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        rateLimit: schema.rateLimit,
        organization: schema.organization,
        member: schema.authMember,
        invitation: schema.invitation,
      },
    }),
    user: {
      additionalFields: {
        role: { type: "string", required: false, input: false },
      },
    },
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    rateLimit: {
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
      },
    },
    disabledPaths: organizationPaths,
    hooks: {
      // No one signs up on the web: members get a login from a texted code, and super admins are made
      // only by `npm run admin:create`, which calls the API without a request and sets the role itself.
      // An allowlist here would let whoever signs up first with a listed (unverified) email become one.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-up/email" && ctx.request) {
          throw new APIError("FORBIDDEN", { message: "Sign-up is closed. Members sign in with their cell." });
        }
      }),
    },
    plugins: [organizationPlugin, phoneCode()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

/** Built on first use: `next build` loads route modules before DATABASE_URL exists. */
export function auth(): Auth {
  instance ??= createAuth();
  return instance;
}
