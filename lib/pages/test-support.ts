// Shared by the business pages' DB tests: members who have texted, their signed-in sessions, a super
// admin's session, and calls into the route handlers with those sessions' cookies.
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-0";
process.env.PHOTON_ADMIN_FAKE = "1";

import assert from "node:assert/strict";
import { afterEach } from "node:test";
import { settleDeferred } from "../../core/deferred";
import { setTransportForTests } from "../../core/imessage";
import { setJobRunnerForTests } from "../../core/jobs";
import { addPhone, createMember, recordInbound, type Caller, type Member } from "../../core/members";
import { createOrganization } from "../../core/organizations";
import { TEST_ORG } from "../../core/test-db";
import { createSuperAdmin } from "../../scripts/admin-create";
import { auth } from "../auth";
import { requireMember, requireViewer, setActiveBusiness, type AppCaller } from "../guards";

export const BASE = "http://localhost:3000";
export const OTHER_ORG = "org_other";

/** Every text the assistant posted during the test. */
export let texts: Array<{ threadId: string; text: string }> = [];

export function installTransport(): void {
  texts = [];
  let n = 0;
  setTransportForTests({
    postText: async (threadId, text) => {
      texts.push({ threadId, text });
      return [`sent_${++n}`];
    },
    postFile: async () => `file_${++n}`,
    addReaction: async () => {},
  });
  // There's no eve server in tests: a session a page starts for a member's thread is a stand-in.
  let sessions = 0;
  setJobRunnerForTests({
    createSession: async () => `ses_page_${++sessions}`,
    send: async () => ({ status: "replied", reply: "ok" }),
  });
}
afterEach(() => setTransportForTests(null));

/** A member whose phone has texted the line, as a `Caller`. */
export async function person(
  name: string,
  role: Member["role"],
  phone: string,
  orgId: string = TEST_ORG,
): Promise<Caller> {
  const member = await createMember({ orgId, name, role });
  const row = await addPhone(orgId, member.id, phone);
  await recordInbound(orgId, row.id, `thread:${phone}`, new Date(), "iMessage");
  return { orgId, memberId: member.id, name, role, language: "en", phoneE164: phone };
}

export async function otherBusiness(): Promise<string> {
  await createOrganization({ id: OTHER_ORG, name: "Other Co", slug: "other-co" });
  return OTHER_ORG;
}

function post(path: string, body: unknown) {
  return auth().handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify(body),
    }),
  );
}

function cookieFrom(response: Response): Headers {
  const cookies = response.headers.getSetCookie().map((c) => c.split(";")[0]);
  assert.ok(cookies.length > 0, "a cookie was set");
  return new Headers({ cookie: cookies.join("; ") });
}

/** Signs a member in with the code the assistant texts them; returns their session's headers. */
export async function signIn(phone: string): Promise<Headers> {
  const before = texts.length;
  assert.equal((await post("/phone-code/send", { phone })).status, 200);
  // The code is looked up, saved, and texted after the response.
  await settleDeferred();
  const code = texts.slice(before).at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
  assert.ok(code, "a code was texted");
  const response = await post("/phone-code/verify", { phone, code });
  assert.equal(response.status, 200, await response.clone().text());
  return cookieFrom(response);
}

/** A super admin's session with `orgId` open: they look at a business they don't belong to. */
export async function superAdminViewing(orgId: string): Promise<Headers> {
  await createSuperAdmin("admin@example.test", "a-long-password");
  const response = await post("/sign-in/email", { email: "admin@example.test", password: "a-long-password" });
  assert.equal(response.status, 200, await response.clone().text());
  const headers = cookieFrom(response);
  await setActiveBusiness(await requireViewer(headers), orgId);
  return headers;
}

export const appCaller = (headers: Headers): Promise<AppCaller> => requireMember(headers);

/** Calls a route handler as the session in `headers`. */
export async function call<P>(
  handler: (request: Request, context: { params: Promise<P> }) => Promise<Response>,
  headers: Headers,
  options: { method?: string; params?: P; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> | null; response: Response }> {
  const request = new Request(`${BASE}/api/test`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: { ...Object.fromEntries(headers.entries()), "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const response = await handler(request, { params: Promise.resolve((options.params ?? {}) as P) });
  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("json") ? ((await response.clone().json()) as Record<string, unknown>) : null;
  return { status: response.status, body, response };
}

/** Asserts a refusal's status and code. */
export function refused(result: { status: number; body: Record<string, unknown> | null }, status: number, code?: string): void {
  assert.equal(result.status, status, JSON.stringify(result.body));
  if (code) assert.equal(result.body?.code, code);
}
