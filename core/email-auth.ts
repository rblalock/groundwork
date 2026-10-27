// Whether a forwarded email really comes from the address in its From line. From is trivially forged,
// and so are headers that claim a verdict (`Authentication-Results`), so neither is trusted: the original
// message's bytes, read back from AgentMail's API, are verified here with mailauth against DNS.
//
// The rule, failing closed:
//   - DKIM is checked on the raw message, and one signature must qualify: it passes, its signing domain
//     (d=) is aligned with the From domain (the same domain, or one an organizational subdomain of the
//     other, as mailauth computes DMARC's relaxed alignment), it uses rsa-sha256 or ed25519-sha256 with a
//     key of at least 2048 bits (RSA), it's within its validity time, it covers the whole body (no l=),
//     and it signs From and the To or Cc line that names the business's inbox.
//   - DMARC is evaluated for the From domain with that DKIM result and no SPF (SPF needs the connecting
//     IP, which isn't available here). A domain with a DMARC record must pass, which here means through
//     the aligned DKIM signature. Only a domain that publishes no DMARC record is accepted on the aligned
//     DKIM pass alone. A failure, a temporary DNS error, or anything else refuses the email.
//   - The message must have exactly one From, the address the email is attributed to, at most one To and
//     one Cc, and address the inbox directly in a To or Cc line the qualifying signature covers. A message
//     someone signed for another recipient can't be replayed to the inbox as a command, even with an
//     unsigned To added.
//
// DNS lookups are bounded (TXT only, DKIM keys and DMARC records only, a dozen at most), and the whole
// check times out. Locally, AGENTMAIL_FAKE's resolver answers for the fake's own signing key.
import { Resolver } from "node:dns/promises";
import { dkimVerify, dmarc, type DKIMResult, type DNSResolver } from "mailauth";

export const RAW_EMAIL_LIMITS = {
  /** The raw message, attachments included. */
  bytes: 40 * 1024 * 1024,
  headerBytes: 64_000,
  /** One From or Return-Path line, unfolded: mailauth hands both to an address parser. */
  addressHeaderBytes: 1_024,
  signatures: 10,
  dnsQueries: 12,
  verificationMs: 15_000,
} as const;

export type SenderAuth =
  | { ok: true; method: "dmarc" | "dkim"; domain: string }
  | { ok: false; reason: "malformed" | "unsigned" | "not_from_sender" | "not_to_inbox" | "dkim_failed" | "dmarc_failed" | "error" };

// Fields mailauth returns at runtime but leaves out of its declarations. Their absence fails closed.
type FullSignature = DKIMResult & {
  algo?: string;
  signingHeaders?: { keys?: string; headers?: string[] };
  canonBodyLengthLimited?: boolean;
  signatureTimeValid?: boolean;
};

const ADDRESS = /^(?:[^<>]*<)?\s*([^<>\s,;]+@[^<>\s,;]+?)\s*>?$/;

/** The addresses in an address header's value, lowercase. */
function addresses(value: string): string[] {
  return value
    .replace(/\r?\n[ \t]+/g, " ")
    .split(",")
    .flatMap((part) => {
      const match = ADDRESS.exec(part.trim());
      return match ? [match[1].toLowerCase()] : [];
    });
}

/** Bounds every DNS lookup verification makes: TXT for DKIM keys and DMARC records only, a dozen at most. */
function boundedResolver(resolve: DNSResolver): DNSResolver {
  let queries = 0;
  return async (name, rrtype) => {
    if (++queries > RAW_EMAIL_LIMITS.dnsQueries || rrtype !== "TXT" || name.length > 253) throw new Error("EMAIL_DNS_BOUNDS");
    if (!/^[a-z0-9._-]+\._domainkey\.[a-z0-9.-]+$/i.test(name) && !/^_dmarc\.[a-z0-9.-]+$/i.test(name)) throw new Error("EMAIL_DNS_BOUNDS");
    return resolve(name, rrtype);
  };
}

/**
 * Verifies the raw message for `sender` (the From address it will be attributed to) and the business's
 * `inbox`, by the rule above. `resolver` replaces DNS (the fake's, and tests').
 */
export async function verifySender(
  raw: Uint8Array,
  expected: { sender: string; inbox: string },
  options: { resolver?: DNSResolver } = {},
): Promise<SenderAuth> {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (bytes.length === 0 || bytes.length > RAW_EMAIL_LIMITS.bytes) return { ok: false, reason: "malformed" };
  const crlf = bytes.indexOf("\r\n\r\n");
  const headEnd = crlf >= 0 ? crlf : bytes.indexOf("\n\n");
  if (headEnd < 0 || headEnd > RAW_EMAIL_LIMITS.headerBytes) return { ok: false, reason: "malformed" };
  const head = bytes.subarray(0, headEnd).toString("latin1").replace(/\r?\n[ \t]+/g, " ");
  const signatureCount = (head.match(/^(?:DKIM-Signature|ARC-Message-Signature|ARC-Seal)[ \t]*:/gim) ?? []).length;
  if (signatureCount === 0) return { ok: false, reason: "unsigned" };
  if (signatureCount > RAW_EMAIL_LIMITS.signatures) return { ok: false, reason: "malformed" };
  const addressLine = /^(?:From|Return-Path)[ \t]*:/i;
  if (head.split(/\r?\n/).some((line) => line.length > RAW_EMAIL_LIMITS.addressHeaderBytes && addressLine.test(line))) return { ok: false, reason: "malformed" };
  const sender = expected.sender.toLowerCase();
  const inbox = expected.inbox.toLowerCase();
  const fromDomain = sender.split("@")[1];
  if (!fromDomain || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(fromDomain)) return { ok: false, reason: "malformed" };

  const dns = new Resolver({ timeout: 2_500, tries: 1 });
  const resolver = boundedResolver(options.resolver ?? ((name) => dns.resolveTxt(name)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("EMAIL_VERIFY_TIMEOUT")), RAW_EMAIL_LIMITS.verificationMs);
  });
  try {
    const dkim = await Promise.race([dkimVerify(bytes, { resolver, minBitLength: 2048 }), timeout]);
    const parsed = dkim.headers?.parsed ?? [];
    const fromHeaders = parsed.filter((h) => h.key.toLowerCase() === "from");
    if (fromHeaders.length !== 1 || dkim.headerFrom.length !== 1 || dkim.headerFrom[0].toLowerCase() !== sender) return { ok: false, reason: "not_from_sender" };
    // One To and one Cc at most, as with From: a second, unsigned header can't name the inbox.
    const count = (key: string) => parsed.filter((h) => h.key.toLowerCase() === key).length;
    if (count("to") > 1 || count("cc") > 1) return { ok: false, reason: "not_to_inbox" };
    const lineAddresses = (line: string) => addresses(line.replace(/^[^:]*:/, ""));
    if (!parsed.some((h) => /^(to|cc)$/i.test(h.key) && lineAddresses(h.line.toString()).includes(inbox))) return { ok: false, reason: "not_to_inbox" };

    // The inbox counts only where the signature itself covers it: in a To or Cc line it signed.
    const qualifies = (item: FullSignature) => {
      const signed = item.signingHeaders?.headers ?? [];
      return (
        item.status.result === "pass" &&
        Boolean(item.status.aligned) &&
        ["rsa-sha256", "ed25519-sha256"].includes(item.algo ?? "") &&
        item.signatureTimeValid === true &&
        item.canonBodyLengthLimited === false &&
        signed.some((h) => /^from:/i.test(h)) &&
        signed.filter((h) => /^(to|cc):/i.test(h)).some((h) => lineAddresses(h).includes(inbox))
      );
    };
    const aligned = (dkim.results as FullSignature[]).find(qualifies);
    if (!aligned) return { ok: false, reason: "dkim_failed" };

    const verdict = await Promise.race([
      dmarc({
        headerFrom: dkim.headerFrom,
        spfDomains: [],
        dkimDomains: dkim.results
          .filter((r) => r.status.result === "pass")
          .map((r) => ({ id: r.id, domain: r.signingDomain, aligned: r.status.aligned, underSized: r.status.underSized })),
        resolver,
      }),
      timeout,
    ]);
    if (!verdict) return { ok: false, reason: "dmarc_failed" };
    if (verdict.status.result === "pass" && verdict.status.header?.from?.toLowerCase() === fromDomain) return { ok: true, method: "dmarc", domain: fromDomain };
    // No DMARC record at all: the aligned DKIM pass stands on its own.
    if (verdict.status.result === "none") return { ok: true, method: "dkim", domain: fromDomain };
    return { ok: false, reason: "dmarc_failed" };
  } catch {
    return { ok: false, reason: "error" };
  } finally {
    if (timer) clearTimeout(timer);
    dns.cancel();
  }
}
