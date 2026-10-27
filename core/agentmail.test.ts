import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { agentMailGateway, agentMailMode, inboxDisplayName, agentMailWebhookSecret, fakeReceivedEvent, providerUrl, signAgentMailWebhook, verifyAgentMailSignature } from "./agentmail";
import { emailAttachmentType } from "./blob";

const SECRET = `whsec_${Buffer.from("test-agentmail-secret").toString("base64")}`;
const NOW = 1_792_000_000;

test("the signature check is Svix's: good, rotated, stale, missing, tampered, and wrong", () => {
  const body = JSON.stringify({ event_type: "message.received" });
  const headers = signAgentMailWebhook(body, SECRET, { id: "msg_1", nowSec: NOW });
  // Svix's own construction, computed independently: base64 HMAC of `id.timestamp.body` under the decoded secret.
  const expected = createHmac("sha256", Buffer.from("test-agentmail-secret")).update(`msg_1.${NOW}.${body}`).digest("base64");
  assert.equal(headers["svix-signature"], `v1,${expected}`);
  const check = (over: Partial<Parameters<typeof verifyAgentMailSignature>[0]>) =>
    verifyAgentMailSignature({ rawBody: body, secret: SECRET, id: "msg_1", timestamp: String(NOW), signature: headers["svix-signature"], nowSec: NOW, ...over });
  assert.deepEqual(check({}), { ok: true });
  assert.deepEqual(check({ signature: `v1,bm9wZQ== ${headers["svix-signature"]}` }), { ok: true });
  assert.deepEqual(check({ nowSec: NOW + 301 }), { ok: false, status: 400, reason: "stale or invalid timestamp" });
  assert.deepEqual(check({ nowSec: NOW - 301 }), { ok: false, status: 400, reason: "stale or invalid timestamp" });
  assert.deepEqual(check({ timestamp: "12abc" }), { ok: false, status: 400, reason: "stale or invalid timestamp" });
  assert.deepEqual(check({ signature: null }), { ok: false, status: 400, reason: "missing signature headers" });
  assert.deepEqual(check({ id: null }), { ok: false, status: 400, reason: "missing signature headers" });
  assert.deepEqual(check({ rawBody: `${body} ` }), { ok: false, status: 401, reason: "bad signature" });
  assert.deepEqual(check({ id: "msg_2" }), { ok: false, status: 401, reason: "bad signature" });
  assert.deepEqual(check({ secret: `whsec_${Buffer.from("other").toString("base64")}` }), { ok: false, status: 401, reason: "bad signature" });
  assert.deepEqual(check({ signature: `v2,${expected}` }), { ok: false, status: 401, reason: "bad signature" });
});

test("tests run on the fake: no key, its own secret, inboxes made locally", async () => {
  assert.equal(agentMailMode(), "fake");
  assert.equal(process.env.AGENTMAIL_API_KEY, "");
  assert.match(agentMailWebhookSecret() ?? "", /^whsec_/);
  const inbox = await agentMailGateway().createInbox({ clientId: "c1", username: "acme-widgets", displayName: "Acme" });
  assert.match(inbox.address, /^acme-widgets-[0-9a-f]{4}@agentmail\.test$/);
  assert.match(inbox.inboxId, /^inbox_fake_/);
});

test("a fake email's attachments come back through the fake gateway", async () => {
  const event = await fakeReceivedEvent({
    inboxId: "inbox_fake_1",
    to: "acme@agentmail.test",
    from: "Pat Example <pat@example.com>",
    subject: "Fwd: rates",
    text: "see attached",
    attachments: [{ filename: "rates.csv", contentType: "text/csv", bytes: new TextEncoder().encode("Item,Price\nWidget,$3\n") }],
  });
  const message = event.message as { attachments: Array<{ attachment_id: string; size: number }>; labels: string[] };
  assert.deepEqual(message.labels, ["received", "unread"]);
  const [attachment] = message.attachments;
  const bytes = await agentMailGateway().downloadAttachment({ inboxId: "inbox_fake_1", messageId: "m", attachmentId: attachment.attachment_id, maxBytes: 1000 });
  assert.equal(new TextDecoder().decode(bytes), "Item,Price\nWidget,$3\n");
  await assert.rejects(
    agentMailGateway().downloadAttachment({ inboxId: "inbox_fake_1", messageId: "m", attachmentId: attachment.attachment_id, maxBytes: 4 }),
    /ATTACHMENT_TOO_LARGE/,
  );
});

test("downloads come only from AgentMail's CDN, or a host pinned exactly in AGENTMAIL_DOWNLOAD_HOSTS", () => {
  assert.equal(providerUrl("https://cdn.agentmail.to/raw/abc?sig=1").hostname, "cdn.agentmail.to");
  for (const url of [
    "https://some-bucket.s3.amazonaws.com/raw/abc",
    "https://attacker.example/cdn.agentmail.to",
    "http://cdn.agentmail.to/raw/abc",
    "https://user:pw@cdn.agentmail.to/raw",
    "https://cdn.agentmail.to:8443/raw",
    42,
  ]) {
    assert.throws(() => providerUrl(url), /AGENTMAIL_502/, String(url));
  }
  process.env.AGENTMAIL_DOWNLOAD_HOSTS = "agentmail-raw.s3.us-east-1.amazonaws.com";
  try {
    assert.equal(providerUrl("https://agentmail-raw.s3.us-east-1.amazonaws.com/x").hostname, "agentmail-raw.s3.us-east-1.amazonaws.com");
    assert.throws(() => providerUrl("https://other.s3.us-east-1.amazonaws.com/x"), /AGENTMAIL_502/);
  } finally {
    delete process.env.AGENTMAIL_DOWNLOAD_HOSTS;
  }
});

test("an email's attachments keep their type only as raster images and PDFs; anything else downloads", () => {
  assert.deepEqual(
    ["image/png", "image/JPEG", "application/pdf; name=x", "image/svg+xml", "text/html", "text/csv", "application/javascript", ""].map(emailAttachmentType),
    ["image/png", "image/jpeg", "application/pdf", "application/octet-stream", "application/octet-stream", "application/octet-stream", "application/octet-stream", "application/octet-stream"],
  );
});

test("an inbox's display name keeps only what a name may carry bare before its address", () => {
  assert.equal(inboxDisplayName("Take Over The World, Inc."), "Take Over The World Inc assistant");
  assert.equal(inboxDisplayName("Palm Coast Trees"), "Palm Coast Trees assistant");
  assert.equal(inboxDisplayName("O'Neil & Sons <Roofing> (FL)"), "O'Neil & Sons Roofing FL assistant");
  assert.equal(inboxDisplayName("Limpiezas Núñez"), "Limpiezas Núñez assistant");
  assert.equal(inboxDisplayName("\"@,;:"), "Assistant");
});
