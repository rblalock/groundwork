import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import type { DNSResolver } from "mailauth";
import { agentMailGateway, dkimSignature, fakeEmailResolver, fakeReceivedEvent } from "./agentmail";
import { verifySender } from "./email-auth";

// Sender verification on raw messages, as mailauth checks them against DNS. Keys are made here, and DNS is
// a table: nothing leaves this machine.

const INBOX = "acme-1234@agentmail.test";
const SENDER = "pat@example.com";

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
};
const key = pair();

/** DNS as a table of TXT records; anything missing is NXDOMAIN, and `fail` names throw a temporary error. */
function dns(records: Record<string, string>, fail: string[] = []): DNSResolver {
  return async (name) => {
    if (fail.includes(name)) throw Object.assign(new Error(`queryTxt ESERVFAIL ${name}`), { code: "ESERVFAIL" });
    const record = records[name.toLowerCase()];
    if (record === undefined) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: "ENOTFOUND" });
    return [[record]];
  };
}
const dkimRecord = (publicKey = key.publicKey) => `v=DKIM1; k=rsa; p=${publicKey}`;
const withDmarc = (extra: Record<string, string> = {}, policy = "v=DMARC1; p=reject") =>
  dns({ "s1._domainkey.example.com": dkimRecord(), "_dmarc.example.com": policy, ...extra });

function message(headers: { from?: string; to?: string; cc?: string } = {}, body = "Can you quote 20 windows at 12 Example St?\r\n"): string {
  return [
    `From: ${headers.from ?? `Pat Example <${SENDER}>`}`,
    `To: ${headers.to ?? INBOX}`,
    ...(headers.cc ? [`Cc: ${headers.cc}`] : []),
    "Subject: Fwd: windows",
    "Date: Mon, 19 Oct 2026 09:02:00 +0000",
    "Message-ID: <m1@mail.example.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");
}

async function sign(raw: string, options: { domain?: string; privateKey?: string } = {}): Promise<Uint8Array> {
  const signature = await dkimSignature(raw, { signingDomain: options.domain ?? "example.com", selector: "s1", privateKey: options.privateKey ?? key.privateKey });
  return new TextEncoder().encode(`${signature}${raw}`);
}

const verify = (raw: Uint8Array, resolver: DNSResolver, sender = SENDER) => verifySender(raw, { sender, inbox: INBOX }, { resolver });

test("a DKIM-signed message passes DMARC for its From domain", async () => {
  assert.deepEqual(await verify(await sign(message()), withDmarc()), { ok: true, method: "dmarc", domain: "example.com" });
  // Addressed to the inbox in Cc, signed over Cc, is fine too.
  assert.equal((await verify(await sign(message({ to: "someone@example.org", cc: INBOX })), withDmarc())).ok, true);
});

test("forged, unsigned, and tampered messages fail, and so does a domain whose DMARC policy the DKIM can't meet", async () => {
  // Signed with a key the domain doesn't publish: what forging From looks like.
  assert.deepEqual(await verify(await sign(message(), { privateKey: pair().privateKey }), withDmarc()), { ok: false, reason: "dkim_failed" });
  assert.deepEqual(await verify(new TextEncoder().encode(message()), withDmarc()), { ok: false, reason: "unsigned" });
  // Changed after signing: the body hash no longer matches, and the domain's DMARC policy refuses it.
  const signed = Buffer.from(await sign(message())).toString().replace("20 windows", "200 windows");
  assert.deepEqual(await verify(new TextEncoder().encode(signed), withDmarc()), { ok: false, reason: "dkim_failed" });
  // A signature on a subdomain under a strict-alignment (adkim=s) DMARC policy: DMARC fails.
  const sub = await sign(message(), { domain: "mail.example.com" });
  assert.deepEqual(await verify(sub, withDmarc({ "s1._domainkey.mail.example.com": dkimRecord() }, "v=DMARC1; p=reject; adkim=s")), { ok: false, reason: "dmarc_failed" });
});

test("a valid signature from another domain is misaligned and fails", async () => {
  const other = await sign(message(), { domain: "mailer.example.net" });
  assert.deepEqual(await verify(other, withDmarc({ "s1._domainkey.mailer.example.net": dkimRecord() })), { ok: false, reason: "dkim_failed" });
});

test("only a domain with no DMARC record is accepted on an aligned DKIM pass alone", async () => {
  const raw = await sign(message());
  assert.deepEqual(await verify(raw, dns({ "s1._domainkey.example.com": dkimRecord() })), { ok: true, method: "dkim", domain: "example.com" });
  // A temporary DNS failure looking up DMARC is not "no record": it fails closed.
  assert.deepEqual(await verify(raw, dns({ "s1._domainkey.example.com": dkimRecord() }, ["_dmarc.example.com"])), { ok: false, reason: "dmarc_failed" });
});

test("a signed message must be from the member and addressed to the inbox: no replays of mail meant for others", async () => {
  assert.deepEqual(await verify(await sign(message()), withDmarc(), "carlos@example.com"), { ok: false, reason: "not_from_sender" });
  // The owner's genuine, signed email to a customer, resent to the inbox, isn't a command.
  assert.deepEqual(await verify(await sign(message({ to: "jane@example.org" })), withDmarc()), { ok: false, reason: "not_to_inbox" });
  // A genuine signed email to a customer, with an unsigned To naming the inbox added on top: refused.
  const replayed = Buffer.from(await sign(message({ to: "jane@example.org" }))).toString();
  assert.deepEqual(await verify(new TextEncoder().encode(`To: ${INBOX}\r\n${replayed}`), withDmarc()), { ok: false, reason: "not_to_inbox" });
  // Or with an unsigned Cc naming it: the inbox must be in a line the signature covers.
  assert.deepEqual(await verify(new TextEncoder().encode(`Cc: ${INBOX}\r\n${replayed}`), withDmarc()), { ok: false, reason: "dkim_failed" });
  // Two From headers can't be resolved to one sender.
  const twoFroms = await sign(message().replace("To:", `From: ${SENDER}\r\nTo:`));
  assert.equal((await verify(twoFroms, withDmarc())).ok, false);
  assert.deepEqual(await verify(new Uint8Array(), withDmarc()), { ok: false, reason: "malformed" });
});

test("a From or Return-Path line over 1 KB is refused before it is parsed, and a long real display name isn't", async () => {
  // A display name of 40 accented characters, encoded as a mail client would: about 300 bytes, still fine.
  const name = `=?UTF-8?B?${Buffer.from("Álvaro Pérez ".repeat(3).padEnd(40, "é")).toString("base64")}?=`;
  assert.equal((await verify(await sign(message({ from: `${name} <${SENDER}>` })), withDmarc())).ok, true);
  // The free-text shape that made nodemailer's address parser quadratic, folded over lines as in a real header.
  const payload = "[x]".repeat(400).match(/.{1,300}/g)!.join("\r\n ");
  assert.deepEqual(await verify(await sign(message({ from: `${payload} <${SENDER}>` })), withDmarc()), { ok: false, reason: "malformed" });
  const returnPath = Buffer.from(await sign(message())).toString().replace("From:", `Return-Path: <${"a".repeat(1_100)}@example.com>\r\nFrom:`);
  assert.deepEqual(await verify(new TextEncoder().encode(returnPath), withDmarc()), { ok: false, reason: "malformed" });
});

test("the fake's mail verifies through its own resolver, and its forgeries don't", async () => {
  const base = { inboxId: "inbox_fake_auth", to: INBOX, from: `Pat Example <${SENDER}>`, subject: "Fwd: windows", text: "Can you quote this?" };
  const check = async (authentication?: "forged" | "unsigned" | "misaligned") => {
    const event = await fakeReceivedEvent({ ...base, authentication });
    const messageId = (event.message as { message_id: string }).message_id;
    const raw = await agentMailGateway().getRawMessage({ inboxId: base.inboxId, messageId, maxBytes: 1_000_000 });
    return verifySender(raw, { sender: SENDER, inbox: INBOX }, { resolver: fakeEmailResolver() });
  };
  assert.deepEqual(await check(), { ok: true, method: "dmarc", domain: "example.com" });
  assert.deepEqual(await check("forged"), { ok: false, reason: "dkim_failed" });
  assert.deepEqual(await check("unsigned"), { ok: false, reason: "unsigned" });
  assert.deepEqual(await check("misaligned"), { ok: false, reason: "dkim_failed" });
});
