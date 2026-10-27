import { isPrivileged, type Caller } from "../../core/members";
import { HttpError, memberCaller, type AppCaller } from "../guards";

// Who may see and change what on the business pages. The server components and the route handlers
// both go through these, so crew limits hold whichever way a page's data is reached.

/** A 404 for anything outside what the caller may see, so ids from another business look missing. */
export function notFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "That isn't here.");
}

/** An owner or admin acting as themselves. Crew get 403; a super admin's look-only view gets 403 too. */
export function privilegedActor(caller: AppCaller): Caller {
  if (!isPrivileged(caller.role)) throw new HttpError(403, "NOT_PRIVILEGED", "Only the owner or an admin can do that.");
  return memberCaller(caller);
}

/** Turns a library's error code into a refusal in the caller's words; anything unknown is rethrown. */
export function refuse(error: unknown, known: Record<string, readonly [status: number, message: string]>): never {
  if (error instanceof HttpError) throw error;
  const code = error instanceof Error ? error.message.split(":")[0] : "";
  const hit = known[code];
  if (hit) throw new HttpError(hit[0], code, hit[1]);
  throw error;
}
