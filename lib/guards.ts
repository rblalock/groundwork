import { and, asc, eq, isNotNull } from "drizzle-orm";
import { members, organization } from "../schema/schema";
import { db } from "../core/db";
import { isPrivileged, membershipsForUser, callerForMember, type Caller } from "../core/members";
import { isSuspended } from "../core/organizations";
import { auth, SUPER_ADMIN, superAdminEmailAllowed } from "./auth";

/** A guard's refusal. Route handlers turn it into a JSON response; pages redirect or 404. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Whoever is signed in, before any business is picked. */
export type Viewer = {
  userId: string;
  name: string;
  email: string;
  superAdmin: boolean;
  sessionToken: string;
  activeOrganizationId: string | null;
};

/**
 * The signed-in person in one business, shaped like the agent's `Caller` so the same `core`
 * functions serve both. `memberId` is null only for a super admin looking at a business they don't
 * belong to: they see what its owner sees, and can't act as anyone (`memberCaller` refuses).
 */
export type AppCaller = Omit<Caller, "memberId"> & {
  memberId: string | null;
  userId: string;
  superAdmin: boolean;
  /** A super admin paused the business: members get the paused screen; super admins still look. */
  suspended: boolean;
};

export type Business = { id: string; name: string; slug: string };

/**
 * A super admin needs both an operator's grant (the role on their login, which nothing in the app sets)
 * and an email on SUPER_ADMIN_EMAILS: the login's own (an email-and-password account from
 * `admin:create`), or, for a phone login, its member's forwarding email, proven theirs by an email from
 * it carrying a code texted to that phone. A forwarding email alone grants nothing, and taking the role
 * away revokes it.
 */
async function isSuperAdmin(user: { id: string; email: string; role?: string | null }): Promise<boolean> {
  if (user.role !== SUPER_ADMIN) return false;
  if (superAdminEmailAllowed(user.email)) return true;
  if (!process.env.SUPER_ADMIN_EMAILS?.trim()) return false;
  const confirmed = await db()
    .select({ email: members.email })
    .from(members)
    .where(and(eq(members.userId, user.id), eq(members.status, "active"), isNotNull(members.email)));
  return confirmed.some((member) => member.email !== null && superAdminEmailAllowed(member.email));
}

export async function getViewer(headers: Headers): Promise<Viewer | null> {
  const found = await auth().api.getSession({ headers });
  if (!found) return null;
  const { user, session } = found;
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    superAdmin: await isSuperAdmin(user),
    sessionToken: session.token,
    activeOrganizationId: (session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
  };
}

async function findBusiness(orgId: string): Promise<Business | null> {
  const [row] = await db()
    .select({ id: organization.id, name: organization.name, slug: organization.slug })
    .from(organization)
    .where(eq(organization.id, orgId));
  return row ?? null;
}

/** The businesses this person may open: their memberships, or every business for a super admin. */
export async function businessesFor(viewer: Viewer): Promise<Business[]> {
  if (viewer.superAdmin) {
    return db()
      .select({ id: organization.id, name: organization.name, slug: organization.slug })
      .from(organization)
      .orderBy(asc(organization.name), asc(organization.id));
  }
  return (await membershipsForUser(viewer.userId)).map((m) => m.org);
}

/**
 * The viewer in their active business: the session's, if they're an active member of it (or a super
 * admin), else their first membership. Null when there is none to open.
 */
export async function resolveAppCaller(viewer: Viewer): Promise<AppCaller | null> {
  const memberships = await membershipsForUser(viewer.userId);
  const active = viewer.activeOrganizationId;
  const chosen = memberships.find((m) => m.org.id === active) ?? (active && viewer.superAdmin ? null : memberships[0]);
  if (chosen) {
    const [caller, suspended] = await Promise.all([callerForMember(chosen.member), isSuspended(chosen.org.id)]);
    if (caller) return { ...caller, userId: viewer.userId, superAdmin: viewer.superAdmin, suspended };
  }
  if (viewer.superAdmin && active && (await findBusiness(active))) {
    return {
      orgId: active,
      memberId: null,
      name: viewer.name,
      role: "owner",
      language: "en",
      phoneE164: null,
      userId: viewer.userId,
      superAdmin: true,
      suspended: await isSuspended(active),
    };
  }
  return null;
}

/** Anyone signed in. Throws 401. */
export async function requireViewer(headers: Headers): Promise<Viewer> {
  const viewer = await getViewer(headers);
  if (!viewer) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  return viewer;
}

/**
 * A member of the active business (or a super admin viewing it). Throws 401, or 403 with no business
 * or while the business is paused (super admins still look).
 */
export async function requireMember(headers: Headers): Promise<AppCaller> {
  const caller = await resolveAppCaller(await requireViewer(headers));
  if (!caller) throw new HttpError(403, "NO_BUSINESS", "You're not a member of a business.");
  if (caller.suspended && !caller.superAdmin) throw new HttpError(403, "BUSINESS_PAUSED", "This business is paused.");
  return caller;
}

/** An owner or admin of the active business, for settings, the team, and money. Throws 403 for crew. */
export async function requirePrivileged(headers: Headers): Promise<AppCaller> {
  const caller = await requireMember(headers);
  if (!isPrivileged(caller.role)) throw new HttpError(403, "NOT_PRIVILEGED", "Only the owner or an admin can do that.");
  return caller;
}

/** The owner of the active business, for card payments through Stripe. Throws 403 for admins and crew. */
export async function requireOwner(headers: Headers): Promise<AppCaller> {
  const caller = await requireMember(headers);
  if (caller.role !== "owner") throw new HttpError(403, "OWNER_ONLY", "Only the owner can do that.");
  return caller;
}

export async function requireSuperAdmin(headers: Headers): Promise<Viewer> {
  const viewer = await requireViewer(headers);
  if (!viewer.superAdmin) throw new HttpError(403, "NOT_SUPER_ADMIN", "Only a super admin can do that.");
  return viewer;
}

/** The caller as the member they are, for anything that acts as them. Throws 403 for a super admin's view. */
export function memberCaller(caller: AppCaller): Caller {
  if (!caller.memberId) throw new HttpError(403, "NOT_A_MEMBER", "Super admins can look, but only members can make changes.");
  return { ...caller, memberId: caller.memberId };
}

/** Opens another business for this session. Members can open their own; super admins any. */
export async function setActiveBusiness(viewer: Viewer, orgId: string): Promise<Business> {
  const business = await findBusiness(orgId);
  const allowed =
    business &&
    (viewer.superAdmin || (await membershipsForUser(viewer.userId)).some((m) => m.org.id === orgId));
  if (!business || !allowed) throw new HttpError(404, "NO_SUCH_BUSINESS", "That business isn't one you can open.");
  const ctx = await auth().$context;
  await ctx.internalAdapter.updateSession(viewer.sessionToken, { activeOrganizationId: orgId });
  return business;
}

/** Wraps a route handler: guard refusals and bad input become JSON errors. */
export function route<A extends unknown[]>(handler: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof HttpError) {
        return Response.json({ error: error.message, code: error.code }, { status: error.status });
      }
      if (error instanceof Error && error.name === "ZodError") {
        return Response.json({ error: "Check the fields and try again.", code: "INVALID_INPUT" }, { status: 400 });
      }
      console.error("route failed", error);
      return Response.json({ error: "Something went wrong. Try again.", code: "INTERNAL" }, { status: 500 });
    }
  };
}
