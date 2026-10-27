// Emailing a quote's PDF to the customer. Sending is the step a draft waits for, so a draft is
// approved first (owner or admin only), and the quote is marked sent once the email goes out.
import { and, eq, gte } from "drizzle-orm";
import { customers, events, quotes } from "../schema/schema";
import { saveCustomer } from "./customers";
import { db } from "./db";
import { isEmailAddress, sendEmail, type EmailSender } from "./email";
import { recordEvent } from "./events";
import { formatDateOnly, type Language } from "./language";
import { isPrivileged, type Caller } from "./members";
import { formatCents } from "./money";
import { getProfileWith } from "./profile";
import { approveQuote, loadSummary, renderCurrentPdf, setQuoteOutcome, type Poster, type QuoteSummary } from "./quotes";

/** The same revision to the same address again within this window is a repeat, not a resend. */
const REPEAT_WINDOW_MS = 10 * 60 * 1000;

export type EmailQuoteInput = { quoteId: string; to?: string; note?: string };
export type EmailQuoteResult = {
  sentTo: string;
  alreadySent: boolean;
  /** Where the customer's replies go: the business email, or null when the profile has none. */
  replyTo: string | null;
  quote: QuoteSummary;
};
type Deps = { send?: EmailSender; now?: Date; post?: Poster };

type Copy = {
  subject: (business: string, title: string) => string;
  greeting: (name: string | null) => string;
  body: (title: string, total: string, validUntil: string) => string;
  contact: (replies: boolean, phone: string | null) => string | null;
};

const COPY: Record<Language, Copy> = {
  en: {
    subject: (business, title) => `Your quote from ${business}: ${title}`,
    greeting: (name) => (name ? `Hello ${name},` : "Hello,"),
    body: (title, total, validUntil) =>
      `Here is your quote for ${title}. The total is ${total}, good until ${validUntil}. The PDF is attached.`,
    contact: (replies, phone) =>
      replies && phone
        ? `Reply to this email or call ${phone} with any questions.`
        : replies
          ? "Reply to this email with any questions."
          : phone
            ? `Call ${phone} with any questions.`
            : null,
  },
  es: {
    subject: (business, title) => `Su cotización de ${business}: ${title}`,
    greeting: (name) => (name ? `Hola ${name}:` : "Hola:"),
    body: (title, total, validUntil) =>
      `Le enviamos su cotización para ${title}. El total es ${total}, válida hasta el ${validUntil}. El PDF va adjunto.`,
    contact: (replies, phone) =>
      replies && phone
        ? `Si tiene preguntas, responda a este correo o llame al ${phone}.`
        : replies
          ? "Si tiene preguntas, responda a este correo."
          : phone
            ? `Si tiene preguntas, llame al ${phone}.`
            : null,
  },
};

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Paragraphs as plain text and as minimal HTML, the same words in both. */
function render(paragraphs: string[]): { text: string; html: string } {
  return {
    text: paragraphs.join("\n\n"),
    html: paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("\n"),
  };
}

export async function emailQuote(input: EmailQuoteInput, caller: Caller, deps: Deps = {}): Promise<EmailQuoteResult> {
  const { orgId } = caller;
  const now = deps.now ?? new Date();
  const [quote] = await db()
    .select({ customerId: quotes.customerId })
    .from(quotes)
    .where(and(eq(quotes.orgId, orgId), eq(quotes.id, input.quoteId)));
  if (!quote) throw new Error("QUOTE_NOT_FOUND");
  let summary = await loadSummary(orgId, input.quoteId);
  if (summary.status === "void") throw new Error("QUOTE_CLOSED");

  const [customer] = quote.customerId
    ? await db()
        .select()
        .from(customers)
        .where(and(eq(customers.orgId, orgId), eq(customers.id, quote.customerId)))
    : [];
  const given = input.to?.trim();
  if (given && !isEmailAddress(given)) throw new Error("INVALID_EMAIL");
  const to = given || customer?.emails.find(isEmailAddress);
  if (!to) throw new Error("NO_EMAIL");

  // A draft goes out only once it's approved, and only the owner or an admin approves.
  if (summary.status === "draft" || summary.status === "needs_owner") {
    if (!isPrivileged(caller.role)) throw new Error("NOT_APPROVED");
    const approved = await approveQuote(summary.quoteId, caller, { now, post: deps.post });
    if (!approved.ok) throw new Error(approved.reason === "not_ready" ? "NOT_READY" : "NOT_APPROVED");
    summary = approved.quote;
  }

  const profile = await getProfileWith(orgId, db());
  const replyTo = profile.email && isEmailAddress(profile.email) ? profile.email : null;
  const repeat = await db()
    .select({ data: events.data })
    .from(events)
    .where(
      and(
        eq(events.orgId, orgId),
        eq(events.kind, "quote.emailed"),
        eq(events.refId, summary.quoteId),
        // Events are stamped by the database clock, so the window is real time, not `now`.
        gte(events.createdAt, new Date(Date.now() - REPEAT_WINDOW_MS)),
      ),
    );
  if (repeat.some((row) => row.data.to === to && row.data.revision === summary.revisionNumber)) {
    return { sentTo: to, alreadySent: true, replyTo, quote: summary };
  }

  const pdf = await renderCurrentPdf(orgId, summary.quoteId);
  const language = pdf.revision.customerLanguage;
  const copy = COPY[language];
  const title = summary.title.replace(/\s+/g, " ").trim();
  const paragraphs = [
    copy.greeting(customer?.name ?? null),
    copy.body(
      title,
      formatCents(pdf.revision.totalCents, language),
      formatDateOnly(pdf.revision.validUntil, language),
    ),
    input.note?.trim(),
    copy.contact(replyTo !== null, profile.phone),
    profile.name,
  ].filter((p): p is string => Boolean(p));

  const sent = await (deps.send ?? sendEmail)({
    fromName: profile.name,
    to,
    replyTo: replyTo ?? undefined,
    subject: copy.subject(profile.name, title),
    ...render(paragraphs),
    attachments: [{ filename: pdf.filename, content: pdf.bytes }],
  });

  // An address the member gave is kept on the customer, so "email it to her" works next time.
  if (customer && given && !customer.emails.includes(given.toLowerCase()) && !customer.archivedAt) {
    await saveCustomer(orgId, { customerId: customer.id, email: given }, caller.memberId);
  }
  await recordEvent({
    orgId,
    kind: "quote.emailed",
    refId: summary.quoteId,
    memberId: caller.memberId,
    data: { to, revision: pdf.revision.number, providerId: sent.id },
  });
  if (summary.status === "approved") summary = await setQuoteOutcome(summary.quoteId, "sent", caller, { now });
  return { sentTo: to, alreadySent: false, replyTo, quote: summary };
}
