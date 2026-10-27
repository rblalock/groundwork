// AgentMail: each business's inbox, where members forward emails to the assistant. Intake only: the app
// never sends email through it (core/email-intake.ts turns an inbound email into a turn in the
// member's thread, and the assistant answers by text).
//
// Behind AGENTMAIL_API_KEY and AGENTMAIL_WEBHOOK_SECRET. A webhook only says which message arrived: the
// message is read back from the API, and its raw bytes too, for sender verification (core/email-auth.ts).
// AGENTMAIL_FAKE=1 (dev, tests, evals) swaps the network calls for a fake that makes inboxes locally, keeps
// each message and its raw bytes (DKIM-signed with a local test key) in a local folder, answers DNS for that
// key, and delivers webhook events signed like AgentMail's (Svix), so the same signature check, re-read,
// verification, dedupe, and handling run end to end. The folder lets the web app and the agent be separate
// processes on one machine.
import { createHash, createHmac, generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dkimSign, type DNSResolver } from "mailauth";

const API = "https://api.agentmail.to/v0";

export const ID_HEADER = "svix-id";
export const TIMESTAMP_HEADER = "svix-timestamp";
export const SIGNATURE_HEADER = "svix-signature";
/** Svix's own window for a signed timestamp's age, either way. */
const TIMESTAMP_TOLERANCE_SEC = 5 * 60;

/** `fake` with `AGENTMAIL_FAKE=1`; `live` with the API key and webhook secret; null when email intake isn't set up. */
export function agentMailMode(): "fake" | "live" | null {
  if (process.env.AGENTMAIL_FAKE === "1" && process.env.VERCEL_ENV !== "production") return "fake";
  return process.env.AGENTMAIL_API_KEY && process.env.AGENTMAIL_WEBHOOK_SECRET ? "live" : null;
}

const FAKE_WEBHOOK_SECRET = `whsec_${Buffer.from("gw-agentmail-fake-local-only").toString("base64")}`;

/** The webhook signing secret: AgentMail's (the webhook's `whsec_…`), or the fake's. */
export function agentMailWebhookSecret(): string | null {
  const mode = agentMailMode();
  if (mode === "fake") return process.env.AGENTMAIL_WEBHOOK_SECRET?.trim() || FAKE_WEBHOOK_SECRET;
  return mode === "live" ? process.env.AGENTMAIL_WEBHOOK_SECRET!.trim() : null;
}

const secretKey = (secret: string): Buffer => Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");

const signatureOf = (secret: string, id: string, timestamp: string, rawBody: string): string =>
  createHmac("sha256", secretKey(secret)).update(`${id}.${timestamp}.${rawBody}`).digest("base64");

/**
 * AgentMail's webhook signature, which is Svix's: `v1,` base64 HMAC-SHA256 of `<svix-id>.<svix-timestamp>.<raw
 * body>`, keyed by the base64 secret after `whsec_`, with the timestamp no more than five minutes off. The
 * header may carry several space-separated signatures (a secret being rotated); any one matching is enough.
 */
export function verifyAgentMailSignature(input: {
  rawBody: string;
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  nowSec?: number;
}): { ok: true } | { ok: false; status: number; reason: string } {
  const { rawBody, secret, id, timestamp, signature } = input;
  if (!id || !timestamp || !signature) return { ok: false, status: 400, reason: "missing signature headers" };
  const age = Math.abs((input.nowSec ?? Math.floor(Date.now() / 1000)) - Number(timestamp));
  if (!/^\d+$/.test(timestamp) || !Number.isFinite(age) || age > TIMESTAMP_TOLERANCE_SEC) {
    return { ok: false, status: 400, reason: "stale or invalid timestamp" };
  }
  const expected = Buffer.from(signatureOf(secret, id, timestamp, rawBody));
  const matches = signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) return false;
    const actual = Buffer.from(value);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
  return matches ? { ok: true } : { ok: false, status: 401, reason: "bad signature" };
}

/** Signs a body the way AgentMail does: for the fake and tests. */
export function signAgentMailWebhook(
  rawBody: string,
  secret: string,
  options: { id?: string; nowSec?: number } = {},
): Record<string, string> {
  const id = options.id ?? `msg_${randomBytes(12).toString("hex")}`;
  const timestamp = String(options.nowSec ?? Math.floor(Date.now() / 1000));
  return { [ID_HEADER]: id, [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: `v1,${signatureOf(secret, id, timestamp, rawBody)}` };
}

// ---------------------------------------------------------------------------------------------
// The API

/** An attachment as AgentMail describes it on a message. Its bytes are fetched separately. */
export type AgentMailAttachment = { attachment_id: string; filename?: string; content_type?: string; size?: number };

/** What the app asks of AgentMail. The live one calls the API; the fake one stays on this machine. */
export interface AgentMailGateway {
  /** Makes the business's inbox. `clientId` makes a retried call return the same inbox. */
  createInbox(input: { clientId: string; username: string; displayName: string }): Promise<{ inboxId: string; address: string }>;
  /** Deletes the inbox and its mail. An inbox that's already gone counts as deleted. */
  deleteInbox(inboxId: string): Promise<void>;
  /** The message as AgentMail stored it: the source of its content, never the webhook's copy. */
  getMessage(input: { inboxId: string; messageId: string }): Promise<unknown>;
  /** The original message's bytes, refused past `maxBytes`. */
  getRawMessage(input: { inboxId: string; messageId: string; maxBytes: number }): Promise<Uint8Array>;
  /** One attachment's bytes, refused past `maxBytes`. */
  downloadAttachment(input: { inboxId: string; messageId: string; attachmentId: string; maxBytes: number }): Promise<Uint8Array>;
}

export class AgentMailError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`AGENTMAIL_${status}${code ? `:${code}` : ""}`);
    this.name = "AgentMailError";
  }
}

async function request<T>(path: string, init: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {}): Promise<T> {
  const key = process.env.AGENTMAIL_API_KEY;
  if (!key) throw new Error("AGENTMAIL_NOT_CONFIGURED");
  if (!path.startsWith("/") || path.startsWith("//")) throw new AgentMailError(400, "path");
  const response = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) {
    // A validation error names the fields it refused; keep their names (never their values) for the logs.
    const detail = (await response.json().catch(() => ({}))) as { name?: unknown; errors?: unknown };
    const name = typeof detail.name === "string" ? detail.name.slice(0, 80) : undefined;
    const fields = Array.isArray(detail.errors)
      ? detail.errors.flatMap((e) => (e && typeof e === "object" && typeof (e as { field?: unknown }).field === "string" ? [(e as { field: string }).field.slice(0, 40)] : []))
      : [];
    throw new AgentMailError(response.status, name && fields.length ? `${name}(${fields.slice(0, 5).join(",")})` : name);
  }
  return (await response.json().catch(() => undefined)) as T;
}

/**
 * A request about one inbox's messages, scoped to it: the path is always
 * `/inboxes/<that inbox>/messages/<that message>` plus a fixed suffix, each id encoded, so an id from a
 * webhook can't reach another inbox or route.
 */
function messageRequest<T>(inboxId: string, messageId: string, suffix: "" | "/raw" | `/attachments/${string}` = ""): Promise<T> {
  return request<T>(`/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}${suffix}`);
}

/**
 * An inbox's display name, which AgentMail writes unquoted before the address (`Name <address>`): only
 * letters, digits, spaces, and the few marks a name may carry bare there, so "Acme, Inc." is "Acme Inc".
 */
export function inboxDisplayName(businessName: string): string {
  const name = businessName.normalize("NFC").replace(/[^\p{L}\p{N}&'\- ]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return name ? `${name} assistant` : "Assistant";
}

const ADDRESS = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/;

/**
 * The hosts a download URL may point at: AgentMail's CDN, the one it's been seen to use, and nothing else.
 * Which S3 bucket, if any, AgentMail also serves from isn't documented, so no bucket is trusted by
 * pattern; a host confirmed on a real account can be added, exactly, in AGENTMAIL_DOWNLOAD_HOSTS.
 */
function downloadHosts(): Set<string> {
  const extra = (process.env.AGENTMAIL_DOWNLOAD_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return new Set(["cdn.agentmail.to", ...extra]);
}

export function providerUrl(value: unknown): URL {
  if (typeof value !== "string") throw new AgentMailError(502, "download_shape");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !downloadHosts().has(url.hostname.toLowerCase())) {
    throw new AgentMailError(502, "download_host");
  }
  return url;
}

/**
 * Reads the bytes behind a provider URL: no API credentials, no redirects (so never another host), a
 * timeout, and nothing over `maxBytes`, by its declared length or as it streams in.
 */
async function readCapped(url: URL, maxBytes: number): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new AgentMailError(response.status, "download");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel();
    throw new Error("ATTACHMENT_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AgentMailError(502, "download_body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error("ATTACHMENT_TOO_LARGE");
      chunks.push(next.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return new Uint8Array(Buffer.concat(chunks));
}

const liveGateway = (): AgentMailGateway => ({
  async createInbox({ clientId, username, displayName }) {
    const inbox = await request<{ inbox_id?: unknown; email?: unknown }>("/inboxes", {
      method: "POST",
      body: { client_id: clientId, username, display_name: displayName },
    });
    // Older responses carry the address only as the inbox id; never guess one from an opaque id.
    const inboxId = typeof inbox.inbox_id === "string" ? inbox.inbox_id : null;
    const address = typeof inbox.email === "string" ? inbox.email : inboxId;
    if (!inboxId || !address || !ADDRESS.test(address)) throw new AgentMailError(502, "inbox_shape");
    return { inboxId, address: address.toLowerCase() };
  },
  async deleteInbox(inboxId) {
    try {
      await request(`/inboxes/${encodeURIComponent(inboxId)}`, { method: "DELETE" });
    } catch (error) {
      if (!(error instanceof AgentMailError && error.status === 404)) throw error;
    }
  },
  getMessage({ inboxId, messageId }) {
    return messageRequest<unknown>(inboxId, messageId);
  },
  async getRawMessage({ inboxId, messageId, maxBytes }) {
    const info = await messageRequest<{ message_id?: unknown; size?: unknown; download_url?: unknown; expires_at?: unknown }>(inboxId, messageId, "/raw");
    if (info.message_id !== messageId || typeof info.size !== "number" || !Number.isSafeInteger(info.size) || info.size < 1) throw new AgentMailError(502, "raw_shape");
    if (info.size > maxBytes) throw new Error("RAW_TOO_LARGE");
    if (typeof info.expires_at === "string" && !(Date.parse(info.expires_at) > Date.now())) throw new AgentMailError(502, "raw_expired");
    const bytes = await readCapped(providerUrl(info.download_url), maxBytes);
    if (bytes.byteLength !== info.size) throw new AgentMailError(502, "raw_size");
    return bytes;
  },
  async downloadAttachment({ inboxId, messageId, attachmentId, maxBytes }) {
    const info = await messageRequest<{ attachment_id?: unknown; size?: unknown; download_url?: unknown }>(
      inboxId,
      messageId,
      `/attachments/${encodeURIComponent(attachmentId)}`,
    );
    if (info.attachment_id !== attachmentId) throw new AgentMailError(502, "attachment_shape");
    if (typeof info.size === "number" && info.size > maxBytes) throw new Error("ATTACHMENT_TOO_LARGE");
    return readCapped(providerUrl(info.download_url), maxBytes);
  },
});

// ---------------------------------------------------------------------------------------------
// The fake

export const FAKE_DOMAIN = "agentmail.test";
/** The DKIM selector the fake signs with; its resolver answers for it on any domain. */
export const FAKE_DKIM_SELECTOR = "gwfake";

/** Where the fake keeps messages, raw bytes, attachments, and its signing key: shared by every process on this machine. */
function fakeDir(): string {
  return process.env.AGENTMAIL_FAKE_DIR?.trim() || join(tmpdir(), "gw-agentmail-fake");
}

const fakeId = (prefix: string) => `${prefix}_fake_${randomBytes(8).toString("hex")}`;
const fakeFile = (name: string) => join(fakeDir(), name.replace(/[^\w.-]/g, "_"));
const messageKey = (inboxId: string, messageId: string) => createHash("sha256").update(`${inboxId}\n${messageId}`).digest("hex").slice(0, 32);

type FakeKey = { privateKey: string; publicKey: string };
let fakeKey: Promise<FakeKey> | null = null;

/**
 * The fake's DKIM key: a 2048-bit RSA pair made on first use and kept in the fake folder, so the process
 * that signs (a script, a test) and the one that verifies (the app) agree. Test-only, never a real domain's.
 */
function fakeDkimKey(): Promise<FakeKey> {
  fakeKey ??= (async () => {
    const file = fakeFile("dkim-key.json");
    try {
      return JSON.parse(await readFile(file, "utf8")) as FakeKey;
    } catch {
      const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const key = {
        privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      };
      await mkdir(fakeDir(), { recursive: true });
      // `wx`: two processes making the key at once keep the first one written.
      await writeFile(file, JSON.stringify(key), { flag: "wx" }).catch(() => {});
      return JSON.parse(await readFile(file, "utf8")) as FakeKey;
    }
  })();
  return fakeKey;
}

const notFound = (name: string) => Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: "ENOTFOUND" });

/**
 * DNS for the fake, through mailauth's resolver option: the fake's DKIM key under its selector on any
 * domain, and a `p=reject` DMARC record for every domain. Nothing else exists. Fake mode only.
 */
export function fakeEmailResolver(): DNSResolver {
  return async (name) => {
    if (name.toLowerCase().startsWith(`${FAKE_DKIM_SELECTOR}._domainkey.`)) return [[`v=DKIM1; k=rsa; p=${(await fakeDkimKey()).publicKey}`]];
    if (name.toLowerCase().startsWith("_dmarc.")) return [["v=DMARC1; p=reject"]];
    throw notFound(name);
  };
}

/** The resolver sender verification uses: DNS, or the fake's in fake mode. */
export function emailResolver(): DNSResolver | undefined {
  return agentMailMode() === "fake" ? fakeEmailResolver() : undefined;
}

const fakeGateway = (): AgentMailGateway => ({
  async createInbox({ username }) {
    const local = `${username.replace(/[^a-z0-9-]/g, "").slice(0, 40) || "business"}-${randomBytes(2).toString("hex")}`;
    return { inboxId: fakeId("inbox"), address: `${local}@${FAKE_DOMAIN}` };
  },
  async deleteInbox() {},
  async getMessage({ inboxId, messageId }) {
    try {
      return JSON.parse(await readFile(fakeFile(`msg-${messageKey(inboxId, messageId)}.json`), "utf8"));
    } catch {
      throw new AgentMailError(404, "NotFoundError");
    }
  },
  async getRawMessage({ inboxId, messageId, maxBytes }) {
    const bytes = new Uint8Array(await readFile(fakeFile(`raw-${messageKey(inboxId, messageId)}.eml`)).catch(() => {
      throw new AgentMailError(404, "NotFoundError");
    }));
    if (bytes.byteLength > maxBytes) throw new Error("RAW_TOO_LARGE");
    return bytes;
  },
  async downloadAttachment({ attachmentId, maxBytes }) {
    const bytes = new Uint8Array(await readFile(fakeFile(attachmentId)));
    if (bytes.byteLength > maxBytes) throw new Error("ATTACHMENT_TOO_LARGE");
    return bytes;
  },
});

let gatewayForTests: AgentMailGateway | null = null;
/** Tests swap in their own gateway; null restores the default. */
export function setAgentMailGatewayForTests(gateway: AgentMailGateway | null): void {
  gatewayForTests = gateway;
}

export function agentMailGateway(): AgentMailGateway {
  if (gatewayForTests) return gatewayForTests;
  const mode = agentMailMode();
  if (mode === "fake") return fakeGateway();
  if (mode === "live") return liveGateway();
  throw new Error("AGENTMAIL_NOT_CONFIGURED");
}

/** An email to deliver through the fake, as someone would send it. */
export type FakeEmail = {
  inboxId: string;
  to: string;
  from: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; contentType: string; bytes: Uint8Array }>;
  labels?: string[];
  headers?: Record<string, string | string[]>;
  messageId?: string;
  at?: Date;
  /**
   * How the raw message is signed: `pass` (default) with the fake's key for the From domain; `forged`
   * with a key no DNS publishes, as someone forging From would; `unsigned`; or `misaligned`, a valid
   * signature for another domain.
   */
  authentication?: "pass" | "forged" | "unsigned" | "misaligned";
  /** What the webhook event says the message is, when it should differ from what AgentMail stored. */
  eventOverrides?: Record<string, unknown>;
};

const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");
const b64 = (bytes: Uint8Array) => (Buffer.from(bytes).toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
const headerText = (value: string) => value.replace(/[\r\n]+/g, " ");

/** The message as it went over the wire: MIME, with its attachments, CRLF line ends. */
function rawMime(email: FakeEmail, messageId: string, at: Date): string {
  const boundary = `gw-${randomBytes(8).toString("hex")}`;
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(new TextEncoder().encode(crlf(email.text ?? "")))}`,
    ...(email.html ? [`--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(new TextEncoder().encode(email.html))}`] : []),
    ...(email.attachments ?? []).map(
      (a) =>
        `--${boundary}\r\nContent-Type: ${headerText(a.contentType)}; name="${headerText(a.filename)}"\r\nContent-Disposition: attachment; filename="${headerText(a.filename)}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(a.bytes)}`,
    ),
  ];
  const extra = Object.entries(email.headers ?? {}).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((v) => `${key}: ${headerText(v)}`));
  return [
    `From: ${headerText(email.from)}`,
    `To: ${headerText(email.to)}`,
    `Subject: ${headerText(email.subject)}`,
    `Date: ${at.toUTCString()}`,
    `Message-ID: ${messageId}`,
    ...extra,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `${parts.join("\r\n")}\r\n--${boundary}--\r\n`,
  ].join("\r\n");
}

/** DKIM-signs a raw message the way the sender's server would, by the email's `authentication`. */
async function signRaw(raw: string, email: FakeEmail): Promise<string> {
  const mode = email.authentication ?? "pass";
  if (mode === "unsigned") return raw;
  const fromDomain = (/<([^>]+)>/.exec(email.from)?.[1] ?? email.from).split("@")[1]?.trim().toLowerCase() ?? "example.com";
  const privateKey =
    mode === "forged"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
      : (await fakeDkimKey()).privateKey;
  const signingDomain = mode === "misaligned" ? "mailer.example.net" : fromDomain;
  return `${await dkimSignature(raw, { signingDomain, selector: FAKE_DKIM_SELECTOR, privateKey })}${raw}`;
}

/**
 * The DKIM-Signature header for `raw`, as a sender's server would add it. mailauth's signer takes its keys
 * as `signatureData`, which its type declarations leave out. Fake and tests only.
 */
export async function dkimSignature(raw: string, key: { signingDomain: string; selector: string; privateKey: string }): Promise<string> {
  const options = { canonicalization: "relaxed/relaxed", algorithm: "rsa-sha256", signatureData: [key] };
  const signed = await dkimSign(raw, options as unknown as Parameters<typeof dkimSign>[1]);
  if (signed.errors.length > 0 || !signed.signatures.trim()) throw new Error("DKIM_SIGN_FAILED");
  return signed.signatures;
}

/**
 * The `message.received` event AgentMail would send for this email. The message, its raw bytes, and its
 * attachments are kept where the fake gateway reads them back, as AgentMail stores them.
 */
export async function fakeReceivedEvent(email: FakeEmail): Promise<Record<string, unknown>> {
  await mkdir(fakeDir(), { recursive: true });
  const attachments: AgentMailAttachment[] = [];
  for (const file of email.attachments ?? []) {
    const attachmentId = fakeId("att");
    await writeFile(fakeFile(attachmentId), file.bytes);
    attachments.push({ attachment_id: attachmentId, filename: file.filename, content_type: file.contentType, size: file.bytes.byteLength });
  }
  const messageId = email.messageId ?? `<${randomBytes(8).toString("hex")}@mail.example.com>`;
  const at = email.at ?? new Date();
  const raw = await signRaw(rawMime(email, messageId, at), email);
  const message = {
    inbox_id: email.inboxId,
    thread_id: fakeId("thd"),
    message_id: messageId,
    labels: email.labels ?? ["received", "unread"],
    timestamp: at.toISOString(),
    from: email.from,
    to: [email.to],
    subject: email.subject,
    ...(email.text !== undefined ? { text: email.text } : {}),
    ...(email.html !== undefined ? { html: email.html } : {}),
    ...(email.headers ? { headers: email.headers } : {}),
    attachments,
    size: Buffer.byteLength(raw),
  };
  const key = messageKey(email.inboxId, messageId);
  await writeFile(fakeFile(`msg-${key}.json`), JSON.stringify(message));
  await writeFile(fakeFile(`raw-${key}.eml`), raw);
  return { type: "event", event_type: "message.received", event_id: fakeId("evt"), message: { ...message, ...email.eventOverrides } };
}

/** A fake event's body and headers, signed with the webhook secret: what the fake delivers. */
export async function signedFakeEmail(email: FakeEmail, options: { nowSec?: number } = {}): Promise<{ body: string; headers: Record<string, string> }> {
  if (agentMailMode() !== "fake") throw new Error("AGENTMAIL_NOT_FAKE");
  const body = JSON.stringify(await fakeReceivedEvent(email));
  return { body, headers: { "content-type": "application/json", ...signAgentMailWebhook(body, agentMailWebhookSecret()!, options) } };
}

/** Delivers a fake email the way AgentMail would: signed, over HTTP to this app's webhook. */
export async function deliverFakeEmail(origin: string, email: FakeEmail): Promise<{ status: number; body: Record<string, unknown> }> {
  const { body, headers } = await signedFakeEmail(email);
  const response = await fetch(`${origin}/api/webhooks/agentmail`, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}
