// A web chat whose eve session stopped running. eve answers a send into a session it has ended with a
// 404 or a 409 (`session_not_active`, or `session_stranded`: another eve version built it). Under
// `next dev`, eve's local world doesn't resume the runs of an earlier dev server, so after a restart
// every older session's send fails with a plain 500 (eve logs `DevelopmentRunUnavailableError`). The
// chat then asks the server for its conversation's session again (`/api/assistant/session`), which
// probes the old one and moves the conversation to a fresh one only when eve really can't run it.

const ENDED_CODES = new Set(["session_not_active", "session_stranded"]);

/** eve has ended the session, or no deployment can ever run it. */
export function sessionEnded(status: number, code: string | undefined): boolean {
  return status === 404 || (status === 409 && ENDED_CODES.has(code ?? ""));
}

/** A refused send worth asking the server about: the session may be gone (a 500 may be a dev restart). */
export function sendMayHaveLostSession(status: number, code: string | undefined): boolean {
  return sessionEnded(status, code) || status >= 500;
}

/**
 * Whether a probe of the session (a cancel naming no turn of it, which a live session ignores) says
 * eve can't run it. A 500 counts only in development, where it's a run the dev server won't resume;
 * in production it may be a passing fault, and the conversation keeps its session.
 */
export function probeSaysLost(status: number, code: string | undefined, development: boolean): boolean {
  return sessionEnded(status, code) || (development && status >= 500);
}
