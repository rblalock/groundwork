import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import type { Language } from "../core/language";
import { isPrivileged } from "../core/members";
import { getViewer, resolveAppCaller, type AppCaller, type Viewer } from "./guards";

// The guards for server components: the same checks as the route handlers' (lib/guards.ts), turned
// into redirects and 404s. Cached per request, so the layout and the page resolve the session once.

const viewerForRequest = cache(async (): Promise<Viewer | null> => getViewer(await headers()));
const callerForRequest = cache(async (): Promise<AppCaller | null> => {
  const viewer = await viewerForRequest();
  return viewer ? resolveAppCaller(viewer) : null;
});

/** The signed-in member's language for the page's `<html lang>`, or null for anyone else (a public page's visitor). */
export async function requestLanguage(): Promise<Language | null> {
  const viewer = await viewerForRequest();
  return viewer ? ((await callerForRequest())?.language ?? null) : null;
}

/** The signed-in person, or a redirect to sign in. */
export async function pageViewer(): Promise<Viewer> {
  const viewer = await viewerForRequest();
  if (!viewer) redirect("/sign-in");
  return viewer;
}

/** The viewer's active business, if they have one. */
export async function pageCallerOrNull(): Promise<AppCaller | null> {
  await pageViewer();
  return callerForRequest();
}

/**
 * A member of the active business. A super admin with none open goes to the businesses list; a member
 * of a paused business, to the paused screen.
 */
export async function pageMember(): Promise<AppCaller> {
  const viewer = await pageViewer();
  const caller = await callerForRequest();
  if (!caller) redirect(viewer.superAdmin ? "/admin" : "/no-business");
  if (caller.suspended && !viewer.superAdmin) redirect("/paused");
  return caller;
}

/** An owner or admin. Crew get a 404: the page isn't theirs. */
export async function pagePrivileged(): Promise<AppCaller> {
  const caller = await pageMember();
  if (!isPrivileged(caller.role)) notFound();
  return caller;
}

export async function pageSuperAdmin(): Promise<Viewer> {
  const viewer = await pageViewer();
  if (!viewer.superAdmin) notFound();
  return viewer;
}
