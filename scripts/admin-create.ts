import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { user } from "../schema/schema";
import { closeDb, db } from "../core/db";
import { auth, SUPER_ADMIN, superAdminEmailAllowed } from "../lib/auth";

/**
 * Makes `email` a super admin, creating the account if needed. When SUPER_ADMIN_EMAILS is set, only an
 * email on it. The password comes from
 * ADMIN_PASSWORD, or is generated and printed once. An existing account keeps its password.
 */
export async function createSuperAdmin(email: string, password?: string): Promise<{ created: boolean; password?: string }> {
  const normalized = email.trim().toLowerCase();
  // Only an email on SUPER_ADMIN_EMAILS can be one (when it's set), so don't make an account that can't sign in as one.
  if (process.env.SUPER_ADMIN_EMAILS && !superAdminEmailAllowed(normalized)) throw new Error(`${normalized} isn't in SUPER_ADMIN_EMAILS`);
  const [existing] = await db().select().from(user).where(eq(user.email, normalized));
  if (existing) {
    await db().update(user).set({ role: SUPER_ADMIN, updatedAt: new Date() }).where(eq(user.id, existing.id));
    return { created: false };
  }
  const chosen = password ?? randomBytes(12).toString("base64url");
  await auth().api.signUpEmail({ body: { email: normalized, password: chosen, name: normalized.split("@")[0] } });
  await db().update(user).set({ role: SUPER_ADMIN }).where(eq(user.email, normalized));
  return { created: true, password: password ? undefined : chosen };
}

async function main(): Promise<number> {
  const email = process.argv[2];
  if (!email || !email.includes("@")) {
    console.error("Usage: npm run admin:create -- <email>   (ADMIN_PASSWORD=... to choose the password)");
    return 1;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Put it in .env.local.");
    return 1;
  }
  try {
    const result = await createSuperAdmin(email, process.env.ADMIN_PASSWORD || undefined);
    if (!result.created) console.log(`${email} already had an account; it's a super admin now.`);
    else if (result.password) console.log(`Created super admin ${email} with password: ${result.password}`);
    else console.log(`Created super admin ${email}.`);
    return 0;
  } catch (error) {
    console.error(`Could not create the super admin: ${error instanceof Error ? error.message : error}`);
    return 1;
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
