import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { emailConfigured } from "./email";

const NAMES = ["EMAIL_FAKE", "RESEND_API_KEY", "EMAIL_FROM"] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

test("email counts as set up with Resend's key and sending address, or EMAIL_FAKE", () => {
  for (const name of NAMES) process.env[name] = "";
  assert.equal(emailConfigured(), false);
  process.env.RESEND_API_KEY = "re_test";
  assert.equal(emailConfigured(), false, "a key without a sending address");
  process.env.EMAIL_FROM = "quotes@example.test";
  assert.equal(emailConfigured(), true);
  for (const name of NAMES) process.env[name] = "";
  process.env.EMAIL_FAKE = "1";
  assert.equal(emailConfigured(), true);
});
