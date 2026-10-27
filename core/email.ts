// Outbound email through Resend's HTTP API. `EMAIL_FROM` is the sending address on a domain verified
// in Resend; the business's name is shown as the sender. `EMAIL_FAKE=1` records instead of sending
// (tests, evals, local dev).

export type OutboundEmail = {
  fromName: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  attachments: Array<{ filename: string; content: Uint8Array }>;
};
export type EmailSender = (email: OutboundEmail) => Promise<{ id: string }>;

/** Emails "sent" while `EMAIL_FAKE=1`, newest last. */
export const fakeOutbox: OutboundEmail[] = [];

// Rough on purpose: Resend validates fully. This catches a name or a phone number passed as an address.
const ADDRESS = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/;

export function isEmailAddress(value: string): boolean {
  return ADDRESS.test(value.trim());
}

/** Display names can't carry the characters that delimit an address header. */
const displayName = (name: string) => name.replace(/["<>\r\n]+/g, " ").replace(/\s+/g, " ").trim();

/** True when `sendEmail` can send: Resend's key and sending address are set, or `EMAIL_FAKE=1`. */
export function emailConfigured(): boolean {
  if (process.env.EMAIL_FAKE === "1") return true;
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export const sendEmail: EmailSender = async (email) => {
  if (process.env.EMAIL_FAKE === "1") {
    fakeOutbox.push(email);
    return { id: `fake_${fakeOutbox.length}` };
  }
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) throw new Error("EMAIL_NOT_CONFIGURED");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: `"${displayName(email.fromName)}" <${from}>`,
      to: [email.to],
      ...(email.replyTo ? { reply_to: email.replyTo } : {}),
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments: email.attachments.map((file) => ({
        filename: file.filename,
        content: Buffer.from(file.content).toString("base64"),
      })),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("email: resend rejected", response.status, detail.slice(0, 300));
    throw new Error(response.status === 422 || response.status === 400 ? "EMAIL_REJECTED" : "EMAIL_FAILED");
  }
  const body = (await response.json()) as { id?: string };
  return { id: body.id ?? "" };
};
