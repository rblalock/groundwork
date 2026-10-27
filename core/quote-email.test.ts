process.env.BLOB_FAKE = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { customers, quotes } from "../schema/schema";
import { db } from "./db";
import { isEmailAddress, type OutboundEmail } from "./email";
import { TEST_ORG, withTestDb } from "./test-db";
import { updateProfile } from "./profile";
import { addPhone, createMember, recordInbound, type Caller, type Member } from "./members";
import { saveItems } from "./pricebook";
import { saveCustomer } from "./customers";
import { emailQuote } from "./quote-email";
import { createQuote, type Poster } from "./quotes";

const NOW = new Date("2026-10-20T15:00:00Z");
const post: Poster = async () => ({ posted: true });

function outbox() {
  const sent: OutboundEmail[] = [];
  return { sent, send: async (email: OutboundEmail) => (sent.push(email), { id: `em_${sent.length}` }) };
}

async function person(name: string, role: Member["role"], e164: string): Promise<Caller> {
  const member = await createMember({ orgId: TEST_ORG, name, role });
  const phone = await addPhone(TEST_ORG, member.id, e164);
  await recordInbound(TEST_ORG, phone.id, `thread:${e164}`, new Date(), "iMessage");
  return { orgId: TEST_ORG, memberId: member.id, name, role, language: "en", phoneE164: e164 };
}

async function seed(customer: { email?: string; language?: "en" | "es" } = {}) {
  const owner = await person("Pat", "owner", "+13055550100");
  await updateProfile(TEST_ORG, { name: "Example Services", email: "office@example.com", phone: "(305) 555-0100" }, owner.memberId);
  const [widget] = await saveItems(
    TEST_ORG,
    [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }],
    owner.memberId,
  );
  const jane = await saveCustomer(TEST_ORG, { name: "Jane Sample", ...customer }, owner.memberId);
  const quote = await createQuote(
    { title: "12 Sample St", customerId: jane.id, lines: [{ itemId: widget.id, quantity: 20 }] },
    owner,
    { post, now: NOW },
  );
  return { owner, widget, jane, quote };
}

test("isEmailAddress takes an address and refuses a name or a phone number", () => {
  assert.ok(isEmailAddress("jane@example.com"));
  assert.ok(isEmailAddress(" jane.sample+quotes@mail.example.co "));
  assert.ok(!isEmailAddress("Jane Sample"));
  assert.ok(!isEmailAddress("305-555-0142"));
  assert.ok(!isEmailAddress("jane@example"));
});

withTestDb("emailing a draft approves it, sends the approved PDF to the saved address, and marks it sent", async () => {
  const { owner, quote } = await seed({ email: "jane@example.com" });
  const { sent, send } = outbox();
  const result = await emailQuote({ quoteId: quote.quoteId }, owner, { send, post, now: NOW });

  assert.equal(result.sentTo, "jane@example.com");
  assert.equal(result.alreadySent, false);
  assert.equal(result.replyTo, "office@example.com");
  assert.equal(result.quote.status, "sent");
  assert.equal(sent.length, 1);
  const [email] = sent;
  assert.equal(email.to, "jane@example.com");
  assert.equal(email.fromName, "Example Services");
  assert.equal(email.replyTo, "office@example.com");
  assert.equal(email.subject, "Your quote from Example Services: 12 Sample St");
  assert.match(email.text, /^Hello Jane Sample,/);
  assert.match(email.text, /The total is \$240\.00/);
  assert.match(email.text, /Reply to this email or call \(305\) 555-0100/);
  assert.equal(email.attachments.length, 1);
  assert.match(email.attachments[0].filename, /\.pdf$/);
  const pdf = await PDFDocument.load(email.attachments[0].content);
  assert.ok(pdf.getPageCount() >= 1);

  const [row] = await db().select().from(quotes).where(eq(quotes.id, quote.quoteId));
  assert.equal(row.status, "sent");
  assert.ok(row.approvedAt);
});

withTestDb("an address the member typed is used and saved on the customer; a repeat sends nothing", async () => {
  const { owner, jane, quote } = await seed();
  const { sent, send } = outbox();
  const first = await emailQuote({ quoteId: quote.quoteId, to: "jane@example.com", note: "Thanks for having us out." }, owner, {
    send,
    post,
    now: NOW,
  });
  assert.equal(first.sentTo, "jane@example.com");
  assert.match(sent[0].text, /Thanks for having us out\./);
  const [customer] = await db().select().from(customers).where(eq(customers.id, jane.id));
  assert.deepEqual(customer.emails, ["jane@example.com"]);

  const again = await emailQuote({ quoteId: quote.quoteId }, owner, { send, post, now: new Date(NOW.getTime() + 60_000) });
  assert.equal(again.alreadySent, true);
  assert.equal(sent.length, 1);
});

withTestDb("without an address, with a bad one, or from crew on a draft, nothing is sent", async () => {
  const { owner, quote } = await seed();
  const crew = await person("Sam", "member", "+13055550142");
  const { sent, send } = outbox();
  await assert.rejects(emailQuote({ quoteId: quote.quoteId }, owner, { send, post, now: NOW }), /NO_EMAIL/);
  await assert.rejects(emailQuote({ quoteId: quote.quoteId, to: "Jane" }, owner, { send, post, now: NOW }), /INVALID_EMAIL/);
  await assert.rejects(
    emailQuote({ quoteId: quote.quoteId, to: "jane@example.com" }, crew, { send, post, now: NOW }),
    /NOT_APPROVED/,
  );
  assert.equal(sent.length, 0);
  const [row] = await db().select().from(quotes).where(eq(quotes.id, quote.quoteId));
  assert.equal(row.status, "draft");
});

withTestDb("a Spanish-speaking customer gets the email in Spanish", async () => {
  const { owner, quote: first } = await seed({ email: "ana@example.com", language: "es" });
  const { sent, send } = outbox();
  await emailQuote({ quoteId: first.quoteId }, owner, { send, post, now: NOW });
  assert.equal(sent[0].subject, "Su cotización de Example Services: 12 Sample St");
  assert.match(sent[0].text, /^Hola Jane Sample:/);
  assert.match(sent[0].text, /El PDF va adjunto\./);
});
