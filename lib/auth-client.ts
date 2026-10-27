"use client";

import { createAuthClient } from "better-auth/react";

/** Email sign-in for super admins, and sign-out. Phone codes post to /api/auth/phone-code/* directly. */
export const authClient = createAuthClient();

export type PhoneCodeError = "INVALID_CODE" | "TOO_MANY_ATTEMPTS" | "FAILED";

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Always resolves the same way for known and unknown phones, by design. */
export async function sendPhoneCode(phone: string): Promise<{ ok: boolean }> {
  const response = await postJson("/phone-code/send", { phone }).catch((error: unknown) => {
    console.error("sign-in: the code request didn't reach the server", error);
    return null;
  });
  if (response && !response.ok) console.error("sign-in: the code request failed", response.status);
  return { ok: Boolean(response?.ok) };
}

export async function verifyPhoneCode(phone: string, code: string): Promise<{ ok: true } | { ok: false; error: PhoneCodeError }> {
  const response = await postJson("/phone-code/verify", { phone, code }).catch(() => null);
  if (response?.ok) return { ok: true };
  const data: unknown = await response?.json().catch(() => null);
  const code_ = data && typeof data === "object" && "code" in data ? (data as { code: unknown }).code : null;
  return { ok: false, error: code_ === "INVALID_CODE" || code_ === "TOO_MANY_ATTEMPTS" ? code_ : "FAILED" };
}
