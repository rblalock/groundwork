process.env.BLOB_FAKE = "1";

import assert from "node:assert/strict";
import { test } from "node:test";
import { asc, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { conversations, memberPhones, messages, quoteAttachments } from "../schema/schema";
import {
  handleAssistantMessage,
  handleFailure,
  handleInbound,
  handleReaction,
  logWebInbound,
  PHOTO_UNREAD,
  markTurnStarted,
  resolveInboundAttachments,
  toInbound,
  toReaction,
  trackSession,
  type DispatchDeps,
  type InboundMessage,
  type InboundReaction,
} from "./channel-dispatch";
import { startThread } from "./conversations";
import { db } from "./db";
import { setTransportForTests } from "./imessage";
import { addPhone, createMember, recordInbound, removeMember, type Member } from "./members";
import { saveItems } from "./pricebook";
import { updateProfile } from "./profile";
import { logOutbound } from "./outbound";
import { approveQuote, askedApproval, createQuote, getQuote, requestOwnerApproval, reviseQuote, type Poster } from "./quotes";
import { latestInbound } from "./tool-context";
import { TEST_ORG, withTestDb } from "./test-db";

type Sent = Parameters<DispatchDeps["send"]>;

function recorder() {
  const sends: Sent[] = [];
  const posts: Array<{ threadId: string; text: string }> = [];
  const reads: Array<{ threadId: string; messageId: string }> = [];
  let n = 0;
  const deps: DispatchDeps = {
    send: async (...args) => void sends.push(args),
    post: async (threadId, text) => {
      posts.push({ threadId, text });
      return [`out_${++n}`];
    },
    markRead: async (threadId, messageId) => void reads.push({ threadId, messageId }),
    now: new Date(),
  };
  return { sends, posts, reads, deps };
}

const quietPoster: Poster = async () => ({ posted: true });

const OWNER_PHONE = "+13055550100";
const CREW_PHONE = "+13055550142";
let seq = 0;

function text(body: string, from = OWNER_PHONE, extra: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: `in_${++seq}`,
    threadId: `imessage:${from}`,
    text: body,
    authorUserId: from,
    authorIsBot: false,
    attachments: [],
    service: "iMessage",
    thread: { id: `imessage:${from}` },
    ...extra,
  };
}

function tapback(targetMessageId: string, emojiName: string, glyph: string, from = OWNER_PHONE, id?: string): InboundReaction {
  return {
    id: id ?? `rx_${++seq}`,
    threadId: `imessage:${from}`,
    targetMessageId,
    emojiName,
    glyph,
    authorUserId: from,
    thread: { id: `imessage:${from}` },
  };
}

async function owner(opts: { verified?: boolean } = {}): Promise<{ member: Member; phoneId: string }> {
  await updateProfile(TEST_ORG, { name: "Acme Widgets" }, "system");
  const member = await createMember({ orgId: TEST_ORG, name: "Pat Example", role: "owner" });
  const phone = await addPhone(TEST_ORG, member.id, OWNER_PHONE);
  if (opts.verified) await recordInbound(TEST_ORG, phone.id, `imessage:${OWNER_PHONE}`, new Date(Date.now() - 60_000));
  return { member, phoneId: phone.id };
}

const allMessages = () => db().select().from(messages).orderBy(asc(messages.createdAt), asc(messages.id));
const phoneStatus = async (id: string) =>
  (await db().select().from(memberPhones).where(eq(memberPhones.id, id)))[0].status;

withTestDb("unknown phone: no send, no post, no messages row", async () => {
  await owner({ verified: true });
  const { sends, posts, reads, deps } = recorder();
  const decision = await handleInbound(text("hi", "+13055559999"), deps);
  assert.deepEqual(decision, { kind: "ignore", reason: "unknown_phone" });
  assert.equal(sends.length + posts.length + reads.length, 0);
  assert.equal((await allMessages()).length, 0);
});

withTestDb("a removed member is treated like an unknown phone, for texts, START, and tapbacks", async () => {
  const { member: rick } = await owner({ verified: true });
  const crew = await createMember({ orgId: TEST_ORG, name: "Carlos", role: "member", addedByMemberId: rick.id });
  const phone = await addPhone(TEST_ORG, crew.id, CREW_PHONE);
  await recordInbound(TEST_ORG, phone.id, `imessage:${CREW_PHONE}`, new Date());
  await removeMember(TEST_ORG, crew.id);
  const { sends, posts, deps } = recorder();
  assert.deepEqual(await handleInbound(text("hi", CREW_PHONE), deps), { kind: "ignore", reason: "unknown_phone" });
  assert.deepEqual(await handleInbound(text("START", CREW_PHONE), deps), { kind: "ignore", reason: "unknown_phone" });
  assert.deepEqual(await handleInbound(text("STOP", CREW_PHONE), deps), { kind: "ignore", reason: "unknown_phone" });
  assert.deepEqual(await handleReaction(tapback("out_x", "thumbs_up", "👍", CREW_PHONE), deps), {
    kind: "ignore",
    reason: "unknown_phone",
  });
  assert.equal(sends.length + posts.length, 0);
  assert.equal((await allMessages()).length, 0);
  assert.equal(await phoneStatus(phone.id), "stopped");
});

withTestDb("duplicate provider id: second call sends nothing", async () => {
  await owner({ verified: true });
  const { sends, deps } = recorder();
  const message = text("4 widgets at 12 Elm St");
  assert.deepEqual(await handleInbound(message, deps), { kind: "dispatch", welcome: false });
  assert.deepEqual(await handleInbound(message, deps), { kind: "ignore", reason: "duplicate" });
  assert.equal(sends.length, 1);
  assert.equal((await allMessages()).length, 1);
});

withTestDb("first text verifies the phone, posts the welcome, then sends to eve with member auth and context", async () => {
  const { member, phoneId } = await owner();
  const { sends, posts, reads, deps } = recorder();
  const message = text("hi");
  assert.deepEqual(await handleInbound(message, deps), { kind: "dispatch", welcome: true });
  assert.equal(await phoneStatus(phoneId), "verified");
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /^Hi Pat, I'm Acme Widgets's quoting assistant\. I'm automated\./);
  assert.equal(posts[0].threadId, message.threadId);
  assert.equal(sends.length, 1);
  const [content, options] = sends[0];
  assert.equal(content, "hi");
  assert.equal(options.thread, message.thread);
  assert.equal(options.turnPolicy, "queue");
  assert.deepEqual(options.auth, {
    authenticator: "photon-imessage",
    issuer: "photon",
    principalId: `member:${member.id}`,
    principalType: "user",
    subject: OWNER_PHONE,
    attributes: { orgId: TEST_ORG, memberId: member.id, role: "owner", phone: OWNER_PHONE, language: "en" },
  });
  assert.match(options.context[0], /owner/);
  assert.ok(options.context.some((l) => l.startsWith("First text ever from Pat Example.")));
  assert.deepEqual(reads, [{ threadId: message.threadId, messageId: message.id }]);
  const rows = await allMessages();
  const inbound = rows.find((r) => r.direction === "inbound");
  assert.equal(inbound?.providerMessageId, message.id);
  assert.equal(inbound?.kind, "user");
  assert.equal(inbound?.body, "hi");
  const welcome = rows.find((r) => r.direction === "outbound");
  assert.equal(welcome?.kind, "system");
  assert.equal(welcome?.providerMessageId, "out_1");

  // The second text is an ordinary turn: no welcome, no first-contact line.
  await handleInbound(text("4 widgets at 12 Elm St"), deps);
  assert.equal(posts.length, 1);
  assert.equal(sends.length, 2);
  assert.ok(!sends[1][1].context.some((l) => l.startsWith("First text ever")));
});

withTestDb("a crew member's welcome names who added them", async () => {
  const { member: rick } = await owner({ verified: true });
  const crew = await createMember({ orgId: TEST_ORG, name: "Carlos Sample", role: "member", addedByMemberId: rick.id });
  await addPhone(TEST_ORG, crew.id, CREW_PHONE);
  const { sends, posts, deps } = recorder();
  await handleInbound(text("hola", CREW_PHONE), deps);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /Pat Example added you/);
  assert.equal(sends[0][1].auth.attributes.role, "member");
});

withTestDb("STOP posts the stop text and stops the phone; later text is ignored; START restores", async () => {
  const { phoneId } = await owner({ verified: true });
  const { sends, posts, deps } = recorder();
  assert.deepEqual(await handleInbound(text("  Stop "), deps), { kind: "stop" });
  assert.equal(await phoneStatus(phoneId), "stopped");
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /unsubscribed/);
  assert.deepEqual(await handleInbound(text("hi"), deps), { kind: "ignore", reason: "stopped" });
  assert.equal(sends.length, 0);
  assert.equal(posts.length, 1);
  assert.deepEqual(await handleInbound(text("START"), deps), { kind: "start" });
  assert.equal(await phoneStatus(phoneId), "verified");
  assert.equal(posts.length, 2);
  assert.match(posts[1].text, /Welcome back/);
  assert.deepEqual(await handleInbound(text("hi again"), deps), { kind: "dispatch", welcome: false });
  assert.equal(sends.length, 1);
  // STOP, START, and the fixed replies are all logged; the ignored text is not.
  const rows = await allMessages();
  assert.deepEqual(
    rows.map((r) => `${r.direction}:${r.body.slice(0, 12)}`),
    ["inbound:  Stop ", `outbound:${posts[0].text.slice(0, 12)}`, "inbound:START", `outbound:${posts[1].text.slice(0, 12)}`, "inbound:hi again"],
  );
});

withTestDb("HELP from a stopped phone is answered and the phone stays stopped", async () => {
  const { phoneId } = await owner({ verified: true });
  const { sends, posts, deps } = recorder();
  await handleInbound(text("STOP"), deps);
  assert.deepEqual(await handleInbound(text("help"), deps), { kind: "help" });
  assert.equal(posts.length, 2);
  assert.match(posts[1].text, /^I'm Acme Widgets's quoting assistant\..*Reply STOP/);
  assert.equal(await phoneStatus(phoneId), "stopped");
  assert.equal(sends.length, 0);
});

withTestDb("HELP or START as the very first text verifies the phone and posts the welcome first", async () => {
  const { phoneId } = await owner();
  const { sends, posts, deps } = recorder();
  assert.deepEqual(await handleInbound(text("help"), deps), { kind: "help" });
  assert.equal(await phoneStatus(phoneId), "verified");
  assert.equal(posts.length, 2);
  assert.match(posts[0].text, /I'm automated/);
  assert.match(posts[1].text, /Reply STOP/);
  assert.equal(sends.length, 0);

  await db().update(memberPhones).set({ status: "pending" }).where(eq(memberPhones.id, phoneId));
  assert.deepEqual(await handleInbound(text("START"), deps), { kind: "start" });
  assert.equal(await phoneStatus(phoneId), "verified");
  assert.equal(posts.length, 4);
  assert.match(posts[2].text, /I'm automated/);
  assert.match(posts[3].text, /Welcome back/);
});

withTestDb("a photo message sends file parts", async () => {
  await owner({ verified: true });
  const { sends, deps } = recorder();
  const attachment = { type: "image" as const, url: "https://example.test/p/1.jpg", name: "1.jpg", mimeType: "image/jpeg" };
  await handleInbound(text("", OWNER_PHONE, { attachments: [attachment] }), deps);
  assert.equal(sends.length, 1);
  const content = sends[0][0];
  assert.ok(Array.isArray(content));
  assert.deepEqual(content[0], { type: "text", text: "(photo)" });
  assert.ok(content.some((part) => part.type === "file"));
  const file = content.find((part) => part.type === "file");
  assert.equal(file?.type === "file" && String(file.data), attachment.url);
  assert.equal(file?.type === "file" && file.mediaType, "image/jpeg");

  await handleInbound(text("the back door", OWNER_PHONE, { attachments: [attachment] }), deps);
  const second = sends[1][0];
  assert.ok(Array.isArray(second));
  assert.deepEqual(second[0], { type: "text", text: "the back door" });
  const [row] = (await allMessages()).filter((r) => r.body === "the back door");
  assert.deepEqual(row.attachments, [attachment]);
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const photoNode = (extra: Record<string, unknown> = {}) => ({
  type: "attachment",
  id: "att_1",
  name: "door.jpg",
  mimeType: "image/jpeg",
  size: JPEG.length,
  read: async () => JPEG,
  ...extra,
});
/** A Photon message as the adapter hands it to the Chat SDK: no attachment URL, the tree in `raw.content`. */
const photonMessage = (content: unknown, body = "", count = 1) =>
  toInbound(
    { id: `imessage:${OWNER_PHONE}` },
    {
      id: `in_${++seq}`,
      text: body,
      author: { userId: OWNER_PHONE, isBot: false },
      attachments: Array.from({ length: count }, () => ({ type: "image" as const, name: "door.jpg", mimeType: "image/jpeg" })),
      raw: { id: "photon_1", content, sender: { service: "iMessage" } },
    },
  );

function captureWarnings() {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args);
  return { warnings, restore: () => (console.warn = original) };
}

withTestDb("a photo whose raw node can read() becomes a file part with bytes and a stored blob URL", async () => {
  await owner({ verified: true });
  const { sends, deps } = recorder();
  assert.deepEqual(await handleInbound(photonMessage(photoNode()), deps), { kind: "dispatch", welcome: false });
  const content = sends[0][0];
  assert.ok(Array.isArray(content));
  assert.deepEqual(content[0], { type: "text", text: "(photo)" });
  const file = content.find((part) => part.type === "file");
  assert.ok(file && file.type === "file");
  assert.ok(!(file.data instanceof URL), "a fake:// store falls back to bytes");
  assert.deepEqual(Buffer.from(file.data as Uint8Array), JPEG);
  assert.equal(file.mediaType, "image/jpeg");
  assert.equal(file.filename, "door.jpg");
  const [row] = (await allMessages()).filter((r) => r.direction === "inbound");
  assert.equal(row.attachments.length, 1);
  assert.match(row.attachments[0].url, /^fake:\/\/inbound\/.+door\.jpg$/);
  assert.deepEqual({ ...row.attachments[0], url: "" }, { type: "image", url: "", name: "door.jpg", mimeType: "image/jpeg" });
});

withTestDb("a photo stored at a real https URL goes to the model as that URL, not bytes", async () => {
  await owner({ verified: true });
  const { sends, deps } = recorder();
  const stored: string[] = [];
  const storeAttachment = async (name: string) => {
    stored.push(name);
    return `https://blob.example.test/inbound/${name}`;
  };
  await handleInbound(photonMessage(photoNode()), { ...deps, storeAttachment });
  assert.deepEqual(stored, ["door.jpg"]);
  const content = sends[0][0];
  assert.ok(Array.isArray(content));
  const file = content.find((part) => part.type === "file");
  assert.ok(file && file.type === "file");
  assert.ok(file.data instanceof URL);
  assert.equal(String(file.data), "https://blob.example.test/inbound/door.jpg");
  assert.equal(file.mediaType, "image/jpeg");
  const [row] = (await allMessages()).filter((r) => r.direction === "inbound");
  assert.equal(row.attachments[0].url, "https://blob.example.test/inbound/door.jpg");
});

withTestDb("a photo whose store fails still goes to the model as bytes", async () => {
  await owner({ verified: true });
  const { sends, deps } = recorder();
  const { restore } = silenceErrors();
  try {
    await handleInbound(photonMessage(photoNode()), { ...deps, storeAttachment: async () => Promise.reject(new Error("blob down")) });
  } finally {
    restore();
  }
  const content = sends[0][0];
  assert.ok(Array.isArray(content));
  const file = content.find((part) => part.type === "file");
  assert.ok(file && file.type === "file");
  assert.deepEqual(Buffer.from(file.data as Uint8Array), JPEG);
  const [row] = (await allMessages()).filter((r) => r.direction === "inbound");
  assert.deepEqual(row.attachments, []);
});

withTestDb("attachments nested in reply and group nodes are found", async () => {
  await owner({ verified: true });
  const { sends, deps } = recorder();
  const tree = {
    type: "reply",
    content: {
      type: "group",
      items: [{ content: { type: "text", text: "two doors" } }, { content: photoNode() }, { content: photoNode({ name: "b.jpg" }) }],
    },
  };
  await handleInbound(photonMessage(tree, "two doors", 2), deps);
  const content = sends[0][0];
  assert.ok(Array.isArray(content));
  assert.equal(content.filter((part) => part.type === "file").length, 2);
  const [row] = (await allMessages()).filter((r) => r.direction === "inbound");
  assert.deepEqual(row.attachments.map((a) => a.name), ["door.jpg", "b.jpg"]);
});

withTestDb("an attachment over 25 MB is skipped, by declared size or by actual bytes", async () => {
  await owner({ verified: true });
  const { sends, deps } = recorder();
  const { restore } = captureWarnings();
  try {
    let reads = 0;
    const declared = photoNode({ size: 26 * 1024 * 1024, read: async () => (reads++, JPEG) });
    await handleInbound(photonMessage(declared), deps);
    assert.equal(reads, 0, "a declared oversize file is never read");
    assert.equal(sends[0][0], PHOTO_UNREAD);
    const actual = photoNode({ size: undefined, read: async () => Buffer.alloc(25 * 1024 * 1024 + 1) });
    await handleInbound(photonMessage(actual), deps);
    assert.equal(sends[1][0], PHOTO_UNREAD);
  } finally {
    restore();
  }
  const rows = (await allMessages()).filter((r) => r.direction === "inbound");
  assert.ok(rows.every((r) => r.attachments.length === 0));
});

withTestDb("an attachment with no readable bytes still dispatches, saying it wasn't seen, and warns with its keys only", async () => {
  await owner({ verified: true });
  const { sends, deps } = recorder();
  const { warnings, restore } = captureWarnings();
  try {
    // Webhook JSON: no read(), no URL. Only an id.
    await handleInbound(photonMessage({ type: "attachment", id: "att_secret", name: "door.jpg", mimeType: "image/jpeg" }), deps);
  } finally {
    restore();
  }
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], PHOTO_UNREAD);
  assert.equal(warnings.length, 1);
  const logged = JSON.stringify(warnings[0]);
  assert.match(logged, /"id","mimeType","name","type"/);
  assert.doesNotMatch(logged, /att_secret|door\.jpg/);
});

withTestDb("an attachment node with an http(s) downloadUrl is fetched", async () => {
  await owner({ verified: true });
  const { sends, deps } = recorder();
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetched.push(String(input));
    return new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
  }) as typeof fetch;
  try {
    const node = { type: "attachment", id: "a", name: "door.jpg", mimeType: "image/jpeg", downloadUrl: "https://cdn.example.test/a" };
    await handleInbound(photonMessage(node), deps);
    await handleInbound(photonMessage({ ...node, downloadUrl: "file:///etc/passwd" }), deps);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(fetched, ["https://cdn.example.test/a"]);
  assert.ok(Array.isArray(sends[0][0]) && sends[0][0].some((part) => part.type === "file"));
  assert.equal(sends[1][0], PHOTO_UNREAD);
});

withTestDb("a Chat SDK attachment with fetchData is used when the raw tree has no reader", async () => {
  await owner({ verified: true });
  const { sends, deps } = recorder();
  const inbound = toInbound(
    { id: `imessage:${OWNER_PHONE}` },
    {
      id: `in_${++seq}`,
      text: "",
      author: { userId: OWNER_PHONE, isBot: false },
      attachments: [{ type: "image", name: "door.jpg", mimeType: "image/jpeg", fetchData: async () => JPEG }],
      raw: { id: "photon_2", content: { type: "attachment", id: "a", name: "door.jpg", mimeType: "image/jpeg" } },
    },
  );
  await handleInbound(inbound, deps);
  assert.ok(Array.isArray(sends[0][0]) && sends[0][0].some((part) => part.type === "file"));
});

async function pdfBytes(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  return doc.save();
}
const fileNode = (name: string, mimeType: string, bytes: Uint8Array) => ({
  type: "attachment",
  id: `att_${name}`,
  name,
  mimeType,
  size: bytes.byteLength,
  read: async () => bytes,
});

withTestDb("a PDF goes to the model as a file with a page-count note, by its stored URL when there is one", async () => {
  await owner({ verified: true });
  const { sends, deps } = recorder();
  const bytes = await pdfBytes(2);
  await handleInbound(photonMessage(fileNode("prices.pdf", "application/pdf", bytes)), deps);
  const content = sends[0][0];
  assert.ok(Array.isArray(content));
  assert.deepEqual(content[0], { type: "text", text: "(PDF: prices.pdf, 2 pages)" });
  const file = content.find((part) => part.type === "file");
  assert.ok(file && file.type === "file");
  assert.equal(file.mediaType, "application/pdf");
  assert.deepEqual(Buffer.from(file.data as Uint8Array), Buffer.from(bytes), "a fake:// store falls back to bytes");
  const [row] = (await allMessages()).filter((r) => r.direction === "inbound");
  assert.equal(row.attachments[0].type, "file");
  assert.equal(row.attachments[0].mimeType, "application/pdf");

  const storeAttachment = async (name: string) => `https://blob.example.test/inbound/${name}`;
  // A generic type and no extension: the bytes say it's a PDF.
  await handleInbound(photonMessage(fileNode("scan", "application/octet-stream", bytes), "my prices"), { ...deps, storeAttachment });
  const second = sends[1][0];
  assert.ok(Array.isArray(second));
  assert.deepEqual(second[0], { type: "text", text: "my prices (PDF: scan.pdf, 2 pages)" });
  const url = second.find((part) => part.type === "file");
  assert.ok(url && url.type === "file" && url.data instanceof URL);
  assert.equal(String(url.data), "https://blob.example.test/inbound/scan.pdf");
});

withTestDb("a PDF the model can't read is stored but sent only as a note saying why", async () => {
  await owner({ verified: true });
  const { sends, deps } = recorder();
  await handleInbound(photonMessage(fileNode("long.pdf", "application/pdf", await pdfBytes(25))), deps);
  await handleInbound(photonMessage(fileNode("broken.pdf", "application/pdf", new TextEncoder().encode("%PDF-1.4 garbage"))), deps);
  assert.match(String(sends[0][0]), /^\(file long\.pdf was not read: it has 25 pages and up to 20 can be read at a time\./);
  assert.match(String(sends[1][0]), /^\(file broken\.pdf was not read: it could not be opened\./);
  const rows = (await allMessages()).filter((r) => r.direction === "inbound");
  assert.deepEqual(rows.map((r) => r.attachments.length), [1, 1]);
});

withTestDb("a CSV goes to the model as text; a spreadsheet it can't open gets a note", async () => {
  await owner({ verified: true });
  const { sends, deps } = recorder();
  const csv = new TextEncoder().encode("Item,Price\r\nWidget service,$12 each\r\n");
  await handleInbound(photonMessage(fileNode("prices.csv", "text/csv", csv), "here you go"), deps);
  const content = sends[0][0];
  assert.ok(Array.isArray(content));
  assert.deepEqual(content, [
    { type: "text", text: "here you go" },
    { type: "text", text: "(file prices.csv, its text follows.)\nItem,Price\nWidget service,$12 each" },
  ]);
  const xlsx = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  await handleInbound(photonMessage(fileNode("prices.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsx)), deps);
  assert.match(String(sends[1][0]), /^\(file prices\.xlsx was not read: that kind of file can't be opened here\./);
});

withTestDb("an attachment with a URL goes to the model only when it reads that type", async () => {
  await owner({ verified: true });
  const { sends, deps } = recorder();
  const attachments = [
    { type: "file" as const, url: "https://example.test/p/prices.pdf", name: "prices.pdf", mimeType: "application/pdf" },
    { type: "file" as const, url: "https://example.test/p/prices.xlsx", name: "prices.xlsx", mimeType: "application/octet-stream" },
  ];
  await handleInbound(text("prices", OWNER_PHONE, { attachments }), deps);
  const content = sends[0][0];
  assert.ok(Array.isArray(content));
  assert.deepEqual(content[0], { type: "text", text: "prices (file: prices.xlsx)" });
  const files = content.filter((part) => part.type === "file");
  assert.equal(files.length, 1);
  assert.equal(files[0].type === "file" && String(files[0].data), "https://example.test/p/prices.pdf");
});

withTestDb("a failing send after the claim is logged, not thrown", async () => {
  await owner({ verified: true });
  const { deps } = recorder();
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    const decision = await handleInbound(text("hi"), { ...deps, send: async () => Promise.reject(new Error("eve down")) });
    assert.deepEqual(decision, { kind: "dispatch", welcome: false });
    const bad = await handleInbound(
      text("", OWNER_PHONE, { attachments: [{ type: "image", url: "not a url" }] }),
      deps,
    );
    assert.deepEqual(bad, { kind: "dispatch", welcome: false });
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 2);
});

withTestDb("pending owner request appears in context for the owner", async () => {
  const { member: rick } = await owner({ verified: true });
  const crew = await createMember({ orgId: TEST_ORG, name: "Carlos", role: "member", addedByMemberId: rick.id });
  const crewPhone = await addPhone(TEST_ORG, crew.id, CREW_PHONE);
  await recordInbound(TEST_ORG, crewPhone.id, `imessage:${CREW_PHONE}`, new Date());
  const [widget] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], rick.id);
  const crewCaller = { orgId: TEST_ORG, memberId: crew.id, name: "Carlos", role: "member" as const, language: "en" as const, phoneE164: CREW_PHONE };
  const draft = await createQuote({ title: "12 Elm St", lines: [{ itemId: widget.id, quantity: 20 }] }, crewCaller, {
    post: quietPoster,
  });
  await requestOwnerApproval(draft.quoteId, crewCaller, { post: quietPoster });
  const { sends, deps } = recorder();
  await handleInbound(text("what's waiting?"), deps);
  const waiting = sends[0][1].context.find((l) => l.startsWith("Waiting on them:"));
  assert.ok(waiting, "context has the pending line");
  assert.match(waiting, /Carlos/);
  assert.match(waiting, /12 Elm St/);
});

/**
 * Creates a quote through the real poster. The transport mirrors the Photon adapter, whose post returns
 * the first bubble it sends: a caption's id when there is one, else the file bubble's ("pdf_1").
 */
async function quoteWithPdfPost(member: Member) {
  const [widget] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], member.id);
  const caller = { orgId: TEST_ORG, memberId: member.id, name: member.name, role: "owner" as const, language: "en" as const, phoneE164: OWNER_PHONE };
  setTransportForTests({
    postText: async () => ["caption_1"],
    postFile: async (...args: unknown[]) => (args[2] ? "caption_1" : "pdf_1"),
    addReaction: async () => {},
  });
  try {
    return await createQuote({ title: "12 Elm St", lines: [{ itemId: widget.id, quantity: 20 }] }, caller, {
      now: new Date(Date.now() - 5_000),
    });
  } finally {
    setTransportForTests(null);
  }
}

withTestDb("a thumbs-up tapback on a quote's PDF post sends the quoted text with the quote in context", async () => {
  const { member } = await owner({ verified: true });
  const quote = await quoteWithPdfPost(member);
  const { sends, deps } = recorder();
  const reaction = tapback("pdf_1", "thumbs_up", "👍");
  assert.deepEqual(await handleReaction(reaction, deps), { kind: "dispatch", welcome: false });
  assert.equal(sends.length, 1);
  const [content, options] = sends[0];
  assert.equal(typeof content, "string");
  assert.ok((content as string).startsWith("👍"));
  assert.match(content as string, /12 Elm St/);
  assert.equal(options.auth.attributes.memberId, member.id);
  assert.ok(options.context.some((l) => l.includes(quote.quoteId)));
  assert.ok(options.context.some((l) => l.includes("expectedRevisionNumber 1")));
  const pdfRow = (await allMessages()).find((r) => r.providerMessageId === "pdf_1");
  assert.equal(pdfRow?.asksApproval, true);
  const [row] = (await allMessages()).filter((r) => r.kind === "reaction");
  assert.equal(row.body, "👍");
  assert.equal(row.direction, "inbound");
  assert.equal(row.targetProviderMessageId, "pdf_1");
  assert.equal(row.providerMessageId, reaction.id);
});

withTestDb("a laugh tapback is logged and starts no turn", async () => {
  const { member } = await owner({ verified: true });
  await quoteWithPdfPost(member);
  const { sends, posts, deps } = recorder();
  const decision = await handleReaction(tapback("pdf_1", "laugh", "😂"), deps);
  assert.equal(decision.kind, "ignore");
  assert.equal(sends.length + posts.length, 0);
  const rows = (await allMessages()).filter((r) => r.kind === "reaction");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, "😂");
});

withTestDb("a tapback from an unknown phone is ignored and not logged", async () => {
  const { member } = await owner({ verified: true });
  await quoteWithPdfPost(member);
  const { sends, deps } = recorder();
  assert.deepEqual(await handleReaction(tapback("pdf_1", "thumbs_up", "👍", "+13055559999"), deps), {
    kind: "ignore",
    reason: "unknown_phone",
  });
  assert.equal(sends.length, 0);
  assert.equal((await allMessages()).filter((r) => r.kind === "reaction").length, 0);
});

withTestDb("a duplicate tapback delivery starts no second turn", async () => {
  const { member } = await owner({ verified: true });
  await quoteWithPdfPost(member);
  const { sends, deps } = recorder();
  const reaction = tapback("pdf_1", "heart", "❤️");
  await handleReaction(reaction, deps);
  assert.deepEqual(await handleReaction(reaction, deps), { kind: "ignore", reason: "duplicate" });
  assert.equal(sends.length, 1);
  assert.equal((await allMessages()).filter((r) => r.kind === "reaction").length, 1);
});

withTestDb("a tapback on a message we never logged still reaches the model, without a quote", async () => {
  await owner({ verified: true });
  const { sends, deps } = recorder();
  await handleReaction(tapback("unknown_target", "question", "❓"), deps);
  assert.equal(sends[0][0], "❓ (tapback)");
  assert.ok(!sends[0][1].context.some((l) => l.includes("tapback is on")));
});

const replyAuth = (member: Member) => ({
  authenticator: "photon-imessage",
  principalId: `member:${member.id}`,
  principalType: "user",
  attributes: { orgId: TEST_ORG, memberId: member.id, phone: OWNER_PHONE },
});

withTestDb("assistant replies post and log with this turn's quote; tool-call messages are not posted", async () => {
  const { member } = await owner({ verified: true });
  const auth = replyAuth(member);
  await markTurnStarted(auth);
  const quote = await quoteWithPdfPost(member);
  const posts: string[] = [];
  const post = async (_threadId: string, body: string) => (posts.push(body), [`reply_${posts.length}`]);
  const state: { pendingToolCallMessage?: string | null } = {};
  const target = { state, threadId: `imessage:${OWNER_PHONE}`, auth };

  assert.deepEqual(
    await handleAssistantMessage({ finishReason: "tool-calls", message: "\nChecking prices\nmore" }, target, { post, now: new Date() }),
    { posted: false },
  );
  assert.equal(state.pendingToolCallMessage, "Checking prices");
  assert.equal(posts.length, 0);

  assert.deepEqual(
    await handleAssistantMessage({ finishReason: "stop", message: "Done. Reply ok to approve." }, target, { post, now: new Date() }),
    { posted: true },
  );
  assert.equal(state.pendingToolCallMessage, null);
  assert.deepEqual(posts, ["Done. Reply ok to approve."]);
  const [row] = (await allMessages()).filter((r) => r.providerMessageId === "reply_1");
  assert.equal(row.kind, "assistant");
  assert.equal(row.quoteId, quote.quoteId);
  assert.equal(row.asksApproval, true, "the quote was created this turn and is still a draft");

  assert.deepEqual(await handleAssistantMessage({ finishReason: "stop", message: "" }, target, { post, now: new Date() }), {
    posted: false,
  });
});

withTestDb("a reply is tagged only with a quote touched this turn, and asks approval only after a new revision", async () => {
  const { member } = await owner({ verified: true });
  const auth = replyAuth(member);
  const quote = await quoteWithPdfPost(member); // an earlier turn
  const caller = { orgId: TEST_ORG, memberId: member.id, name: member.name, role: "owner" as const, language: "en" as const, phoneE164: OWNER_PHONE };
  let n = 0;
  const post = async () => [`reply_${++n}`];
  const reply = async (message: string) => {
    await handleAssistantMessage({ finishReason: "stop", message }, { state: {}, threadId: `imessage:${OWNER_PHONE}`, auth }, { post, now: new Date() });
    return (await allMessages()).find((r) => r.providerMessageId === `reply_${n}`)!;
  };

  // A plain acknowledgment in a later turn ("Saved.") is about no quote.
  await markTurnStarted(auth);
  const saved = await reply("Saved.");
  assert.equal(saved.quoteId, null);
  assert.equal(saved.asksApproval, false);

  // A turn that revises the quote replies with its summary, which asks for approval.
  await markTurnStarted(auth);
  await reviseQuote({ quoteId: quote.quoteId, title: "12 Elm Street" }, caller, { post: quietPoster });
  const summary = await reply("Quote for 12 Elm Street: $240");
  assert.equal(summary.quoteId, quote.quoteId);
  assert.equal(summary.asksApproval, true);

  // A turn that approves it names the quote but asks nothing.
  await markTurnStarted(auth);
  await approveQuote(quote.quoteId, caller, { post: quietPoster });
  const approved = await reply("Approved. Forward the PDF when you're ready.");
  assert.equal(approved.quoteId, quote.quoteId);
  assert.equal(approved.asksApproval, false);
});

withTestDb("over text, an ok approves only the quote that was put to the member; another one is confirmed first", async () => {
  const { member } = await owner({ verified: true });
  const auth = replyAuth(member);
  const caller = { orgId: TEST_ORG, memberId: member.id, name: member.name, role: "owner" as const, language: "en" as const, phoneE164: OWNER_PHONE };
  const [widget] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], member.id);
  const { deps } = recorder();
  let n = 0;
  const post = async () => [`reply_${++n}`];
  const reply = async (message: string) => {
    await handleAssistantMessage({ finishReason: "stop", message }, { state: {}, threadId: `imessage:${OWNER_PHONE}`, auth }, { post, now: new Date() });
    return `reply_${n}`;
  };
  // One turn of the conversation: the member's text, then whatever the agent's tools do, then its reply.
  const turn = async (body: string, act: () => Promise<unknown>, answer: string) => {
    await handleInbound(text(body), deps);
    await markTurnStarted(auth);
    await act();
    return reply(answer);
  };
  const asked = async () => askedApproval(TEST_ORG, member.id, await latestInbound(TEST_ORG, member.id, ["user", "reaction"]));
  const create = (title: string) =>
    createQuote({ title, lines: [{ itemId: widget.id, quantity: 20 }] }, caller, { post: quietPoster });
  const status = async (quoteId: string) => (await getQuote(TEST_ORG, quoteId))?.status;

  let oak!: Awaited<ReturnType<typeof create>>;
  let elm!: Awaited<ReturnType<typeof create>>;
  const oakSummary = await turn("quote oak st, 20 widgets", async () => (oak = await create("Oak St")), "Quote for Oak St: $240");
  await turn("and elm st, 20 widgets", async () => (elm = await create("Elm St")), "Quote for Elm St: $240");

  // "approve oak" answers Elm's summary, the last one put to them: Oak's summary goes out instead.
  let result!: Awaited<ReturnType<typeof approveQuote>>;
  await turn("approve oak", async () => (result = await approveQuote(oak.quoteId, caller, { post: quietPoster, asked: await asked() })), "Quote for Oak St: $240. Reply ok to approve.");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "confirm");
  assert.equal(await status(oak.quoteId), "draft");

  // That summary asked about Oak, so the next ok approves Oak, and Elm stays a draft.
  await turn("ok", async () => (result = await approveQuote(oak.quoteId, caller, { post: quietPoster, asked: await asked() })), "Approved.");
  assert.equal(result.ok, true);
  assert.equal(await status(oak.quoteId), "approved");
  assert.equal(await status(elm.quoteId), "draft");

  // A tapback answers the message it is on, even an older one: a 👍 on Oak's first summary is about Oak,
  // and the newest request (Oak's confirm) doesn't make it about anything else.
  assert.deepEqual((await askedApproval(TEST_ORG, member.id, { kind: "reaction", targetProviderMessageId: oakSummary, createdAt: new Date() }))?.quoteId, oak.quoteId);
});

withTestDb("the owner's ok on a crew draft's notice approves that draft", async () => {
  const { member } = await owner({ verified: true });
  await updateProfile(TEST_ORG, { quietStartHour: 0, quietEndHour: 0 }, member.id);
  const crew = await createMember({ orgId: TEST_ORG, name: "Sam Sample", role: "member" });
  const crewPhone = await addPhone(TEST_ORG, crew.id, CREW_PHONE);
  await recordInbound(TEST_ORG, crewPhone.id, `imessage:${CREW_PHONE}`, new Date(Date.now() - 60_000));
  const crewCaller = { orgId: TEST_ORG, memberId: crew.id, name: crew.name, role: "member" as const, language: "en" as const, phoneE164: CREW_PHONE };
  const caller = { orgId: TEST_ORG, memberId: member.id, name: member.name, role: "owner" as const, language: "en" as const, phoneE164: OWNER_PHONE };
  const [widget] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], member.id);
  const draft = await createQuote({ title: "Pine St", lines: [{ itemId: widget.id, quantity: 20 }] }, crewCaller, { post: quietPoster });
  let n = 0;
  setTransportForTests({ postText: async () => [`notice_${++n}`], postFile: async () => `file_${++n}`, addReaction: async () => {} });
  try {
    // The real poster, which checks quiet hours against the real clock: with them off, the notice is sent
    // and logged as asking the owner whatever time the test runs.
    await requestOwnerApproval(draft.quoteId, crewCaller);
  } finally {
    setTransportForTests(null);
  }
  const { deps } = recorder();
  await handleInbound(text("ok"), deps);
  const asked = await askedApproval(TEST_ORG, member.id, await latestInbound(TEST_ORG, member.id, ["user", "reaction"]));
  assert.equal(asked?.quoteId, draft.quoteId);
  const result = await approveQuote(draft.quoteId, caller, { post: quietPoster, asked });
  assert.equal(result.ok, true);
});

withTestDb("an ok pins the revision it was asked about: a quote revised since is re-sent, not approved", async () => {
  const { member } = await owner({ verified: true });
  const auth = replyAuth(member);
  const caller = { orgId: TEST_ORG, memberId: member.id, name: member.name, role: "owner" as const, language: "en" as const, phoneE164: OWNER_PHONE };
  const [widget] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], member.id);
  const { deps } = recorder();
  await handleInbound(text("quote oak st, 20 widgets"), deps);
  await markTurnStarted(auth);
  const oak = await createQuote({ title: "Oak St", lines: [{ itemId: widget.id, quantity: 20 }] }, caller, { post: quietPoster });
  await handleAssistantMessage(
    { finishReason: "stop", message: "Quote for Oak St: $240" },
    { state: {}, threadId: `imessage:${OWNER_PHONE}`, auth },
    { post: async () => ["reply_1"], now: new Date() },
  );
  // Someone else revises it before the owner answers. Later, not within the same millisecond: a
  // revision's time is the app's clock to the millisecond, the reply's is the database's to the microsecond.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await reviseQuote({ quoteId: oak.quoteId, lines: [{ itemId: widget.id, quantity: 25 }] }, caller, { post: quietPoster });

  await handleInbound(text("ok"), deps);
  const asked = await askedApproval(TEST_ORG, member.id, await latestInbound(TEST_ORG, member.id, ["user", "reaction"]));
  assert.deepEqual(asked, { quoteId: oak.quoteId, revisionNumber: 1 });
  const result = await approveQuote(oak.quoteId, caller, { post: quietPoster, asked });
  assert.equal(!result.ok && result.reason, "revision_changed");
  assert.equal((await getQuote(TEST_ORG, oak.quoteId))?.status, "draft");
});

withTestDb("a thumbs-up on a message about a quote that asked nothing gets no approve hint", async () => {
  const { member } = await owner({ verified: true });
  const quote = await quoteWithPdfPost(member);
  await logOutbound({
    orgId: TEST_ORG,
    memberId: member.id,
    phoneE164: OWNER_PHONE,
    threadId: `imessage:${OWNER_PHONE}`,
    providerMessageIds: ["ack_1"],
    chunks: ["Saved. Gadget fitting is $2 each."],
    kind: "assistant",
    quoteId: quote.quoteId,
  });
  const { sends, deps } = recorder();
  await handleReaction(tapback("ack_1", "thumbs_up", "👍"), deps);
  const { context } = sends[0][1];
  assert.ok(context.some((l) => l.includes(quote.quoteId) && l.includes("did not ask for approval")));
  assert.ok(!context.some((l) => l.includes("expectedRevisionNumber")));
});

withTestDb("assistant replies are not posted to a phone that stopped mid-turn", async () => {
  const { member, phoneId } = await owner({ verified: true });
  await db().update(memberPhones).set({ status: "stopped" }).where(eq(memberPhones.id, phoneId));
  const posts: string[] = [];
  const post = async (_threadId: string, body: string) => (posts.push(body), ["x"]);
  const auth = {
    authenticator: "photon-imessage",
    principalId: `member:${member.id}`,
    principalType: "user",
    attributes: { orgId: TEST_ORG, memberId: member.id, phone: OWNER_PHONE },
  };
  const result = await handleAssistantMessage(
    { finishReason: "stop", message: "hello" },
    { state: {}, threadId: `imessage:${OWNER_PHONE}`, auth },
    { post, now: new Date() },
  );
  assert.deepEqual(result, { posted: false });
  assert.equal(posts.length, 0);
});

withTestDb("a text joins the thread the member started on the web, instead of starting another session", async () => {
  const { member } = await owner({ verified: true });
  const { sends, deps } = recorder();
  await handleInbound(text("before any thread"), deps);
  assert.equal(sends[0][1].session, null);
  const started = await startThread(TEST_ORG, member.id, "ses_web");
  assert.equal(started.eveSessionId, "ses_web");
  await handleInbound(text("hi from my phone"), deps);
  assert.equal(sends[1][1].session, "ses_web");
  // A second start (another tab, or a text that got there first) keeps the thread's session.
  assert.equal((await startThread(TEST_ORG, member.id, "ses_other")).eveSessionId, "ses_web");
  assert.deepEqual((await db().select().from(conversations)).map((c) => [c.id, c.kind, c.eveSessionId]), [[started.id, "thread", "ses_web"]]);
});

withTestDb("trackSession keeps the member's thread on their latest session, and only for a photon member", async () => {
  const member = await createMember({ orgId: TEST_ORG, name: "Pat Example", role: "owner" });
  const auth = {
    authenticator: "photon-imessage",
    principalId: `member:${member.id}`,
    principalType: "user",
    attributes: { orgId: TEST_ORG, memberId: member.id, phone: OWNER_PHONE },
  };
  const sessions = () => db().select().from(conversations);
  await trackSession(auth, "ses_1");
  await trackSession(auth, "ses_1");
  assert.deepEqual((await sessions()).map((s) => [s.orgId, s.memberId, s.kind, s.eveSessionId]), [[TEST_ORG, member.id, "thread", "ses_1"]]);
  await trackSession(null, "ses_2");
  await trackSession({ ...auth, authenticator: "local-dev" }, "ses_3");
  // An org that isn't the member's finds nobody.
  await trackSession({ ...auth, attributes: { ...auth.attributes, orgId: "org_other" } }, "ses_4");
  assert.deepEqual((await sessions()).map((s) => s.eveSessionId), ["ses_1"]);
  const [thread] = await sessions();
  await trackSession(auth, "ses_5");
  assert.deepEqual((await sessions()).map((s) => [s.id, s.eveSessionId]), [[thread.id, "ses_5"]]);
  // A web turn's auth never moves the thread.
  await trackSession({ ...auth, authenticator: "app-web", principalId: "usr_1" }, "ses_6");
  assert.deepEqual((await sessions()).map((s) => s.eveSessionId), ["ses_5"]);
});

withTestDb("trackSession leaves a thread started on the web on its session when a new iMessage thread texts", async () => {
  const member = await createMember({ orgId: TEST_ORG, name: "Pat Example", role: "owner" });
  const auth = {
    authenticator: "photon-imessage",
    principalId: `member:${member.id}`,
    principalType: "user",
    attributes: { orgId: TEST_ORG, memberId: member.id, phone: OWNER_PHONE },
  };
  const started = await startThread(TEST_ORG, member.id, "ses_web");
  await trackSession(auth, "ses_new_imessage_thread");
  assert.deepEqual((await db().select().from(conversations)).map((c) => [c.id, c.eveSessionId]), [[started.id, "ses_web"]]);
});

test("toInbound maps a Chat SDK message and reads the service defensively", () => {
  const thread = { id: "imessage:abc" };
  const inbound = toInbound(thread, {
    id: "m1",
    text: "hi",
    author: { userId: "+13055550100", isBot: false },
    attachments: [{ type: "image", url: "https://example.test/a.jpg", name: "a.jpg", mimeType: "image/jpeg" }, { type: "file" }],
    raw: { sender: { id: "+13055550100", service: "SMS" } },
  });
  const { attachmentSources, ...rest } = inbound;
  assert.deepEqual(rest, {
    id: "m1",
    threadId: "imessage:abc",
    text: "hi",
    authorUserId: "+13055550100",
    authorIsBot: false,
    attachments: [{ type: "image", url: "https://example.test/a.jpg", name: "a.jpg", mimeType: "image/jpeg" }],
    service: "SMS",
    thread,
  });
  assert.equal(attachmentSources?.length, 1);
  assert.equal(attachmentSources?.[0].load, null);
  assert.equal(toInbound(thread, { id: "m2", text: "", author: { userId: "x", isBot: "unknown" }, raw: null }).service, null);
  assert.equal(toInbound(thread, { id: "m3", text: "", author: { userId: "x", isBot: true }, raw: { sender: { service: "Fax" } } }).service, null);
});

test("resolveInboundAttachments walks reply and group nodes, including voice", () => {
  const { direct, sources } = resolveInboundAttachments({
    attachments: [],
    raw: {
      content: {
        type: "group",
        items: [
          { content: { type: "reply", content: { type: "attachment", name: "a.png", mimeType: "image/png", read: async () => JPEG } } },
          { content: { type: "voice", mimeType: "audio/x-m4a" } },
          { content: { type: "text", text: "x" } },
        ],
      },
    },
  });
  assert.deepEqual(direct, []);
  assert.deepEqual(
    sources.map((s) => [s.type, s.name, s.mimeType, typeof s.load]),
    [
      ["image", "a.png", "image/png", "function"],
      ["audio", "voice", "audio/x-m4a", "object"],
    ],
  );
});

test("resolveInboundAttachments downloads a webhook attachment that carries only its id", async () => {
  const asked: string[] = [];
  const message = {
    attachments: [],
    raw: { content: { type: "attachment", id: "att_1", name: "IMG_1.jpeg", mimeType: "image/jpeg", size: 3 } },
  };
  const { sources } = resolveInboundAttachments(message, {
    download: async (id) => {
      asked.push(id);
      return JPEG;
    },
  });
  assert.equal(sources.length, 1);
  assert.deepEqual(await sources[0].load?.(), JPEG);
  assert.deepEqual(asked, ["att_1"]);
  assert.equal(resolveInboundAttachments(message).sources[0].load, null);
});

test("toReaction uses the raw Photon id, falling back to a stable composite id", () => {
  const base = {
    messageId: "target_1",
    emoji: { name: "thumbs_up" },
    rawEmoji: "👍",
    user: { userId: "+13055550100" },
    threadId: "imessage:abc",
    thread: { id: "imessage:abc" },
  };
  assert.equal(toReaction({ ...base, raw: { id: "photon_9" } }).id, "photon_9");
  const fallback = toReaction({ ...base, raw: undefined });
  assert.equal(fallback.id, "target_1:+13055550100:thumbs_up");
  assert.equal(fallback.targetMessageId, "target_1");
  assert.equal(fallback.glyph, "👍");
  assert.equal(fallback.emojiName, "thumbs_up");
});

withTestDb("two first texts at once get exactly one welcome and one first-contact turn", async () => {
  const { phoneId } = await owner();
  const { sends, posts, deps } = recorder();
  const decisions = await Promise.all([handleInbound(text("hi"), deps), handleInbound(text("need a quote"), deps)]);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /I'm automated/);
  assert.equal(sends.length, 2);
  assert.equal(sends.filter(([, o]) => o.context.some((l) => l.startsWith("First text ever"))).length, 1);
  assert.deepEqual(decisions.map((d) => d.kind === "dispatch" && d.welcome).sort(), [false, true]);
  assert.equal(await phoneStatus(phoneId), "verified");
});

withTestDb("two HELP texts at once from a pending phone get one welcome", async () => {
  await owner();
  const { posts, deps } = recorder();
  await Promise.all([handleInbound(text("help"), deps), handleInbound(text("HELP"), deps)]);
  assert.equal(posts.filter((p) => /I'm automated/.test(p.text)).length, 1);
  assert.equal(posts.filter((p) => /Reply STOP/.test(p.text)).length, 2);
});

function failurePoster() {
  const posts: Array<{ threadId: string; text: string }> = [];
  const post = async (threadId: string, body: string) => (posts.push({ threadId, text: body }), [`fail_${posts.length}`]);
  return { posts, post };
}

function silenceErrors() {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  return { errors, restore: () => (console.error = original) };
}

withTestDb("a failed turn posts one fixed line in the member's language, logged, without error text", async () => {
  const { member } = await owner({ verified: true });
  const { posts, post } = failurePoster();
  const auth = {
    authenticator: "photon-imessage",
    principalId: `member:${member.id}`,
    principalType: "user",
    attributes: { orgId: TEST_ORG, memberId: member.id, phone: OWNER_PHONE },
  };
  const { errors, restore } = silenceErrors();
  try {
    await handleFailure({ threadId: `imessage:${OWNER_PHONE}`, auth }, new Error("db password=hunter2"), { post, now: new Date() });
  } finally {
    restore();
  }
  assert.deepEqual(posts, [{ threadId: `imessage:${OWNER_PHONE}`, text: "Something went wrong on my end. Try that again in a minute." }]);
  assert.equal(errors.length, 1);
  const [row] = (await allMessages()).filter((r) => r.providerMessageId === "fail_1");
  assert.equal(row.kind, "system");
  assert.equal(row.direction, "outbound");
});

withTestDb("a failed session with no auth finds the member by thread and replies in Spanish", async () => {
  const member = await createMember({ orgId: TEST_ORG, name: "Ana", role: "owner", language: "es" });
  const phone = await addPhone(TEST_ORG, member.id, CREW_PHONE);
  await recordInbound(TEST_ORG, phone.id, `imessage:${CREW_PHONE}`, new Date());
  const { posts, post } = failurePoster();
  const { restore } = silenceErrors();
  try {
    await handleFailure({ threadId: `imessage:${CREW_PHONE}`, auth: null }, { message: "boom" }, { post, now: new Date() });
  } finally {
    restore();
  }
  assert.deepEqual(posts.map((p) => p.text), ["Algo falló de mi lado. Inténtalo de nuevo en un minuto."]);
});

withTestDb("a failure posts nothing to a stopped phone, a removed member, or an unknown thread", async () => {
  const { member: rick, phoneId } = await owner({ verified: true });
  const crew = await createMember({ orgId: TEST_ORG, name: "Carlos", role: "member", addedByMemberId: rick.id });
  const crewPhone = await addPhone(TEST_ORG, crew.id, CREW_PHONE);
  await recordInbound(TEST_ORG, crewPhone.id, `imessage:${CREW_PHONE}`, new Date());
  await removeMember(TEST_ORG, crew.id);
  await db().update(memberPhones).set({ status: "stopped" }).where(eq(memberPhones.id, phoneId));
  const { posts, post } = failurePoster();
  const { restore } = silenceErrors();
  try {
    const authFor = (m: Member, phone: string) => ({
      authenticator: "photon-imessage",
      principalId: `member:${m.id}`,
      principalType: "user",
      attributes: { orgId: TEST_ORG, memberId: m.id, phone },
    });
    await handleFailure({ threadId: `imessage:${OWNER_PHONE}`, auth: authFor(rick, OWNER_PHONE) }, new Error("x"), { post, now: new Date() });
    await handleFailure({ threadId: `imessage:${CREW_PHONE}`, auth: authFor(crew, CREW_PHONE) }, new Error("x"), { post, now: new Date() });
    await handleFailure({ threadId: `imessage:${CREW_PHONE}`, auth: null }, new Error("x"), { post, now: new Date() });
    await handleFailure({ threadId: "imessage:nobody", auth: null }, new Error("x"), { post, now: new Date() });
    await handleFailure({ threadId: null, auth: null }, new Error("x"), { post, now: new Date() });
  } finally {
    restore();
  }
  assert.equal(posts.length, 0);
});

withTestDb("a failure reply whose post rejects is logged and does not throw", async () => {
  const { member } = await owner({ verified: true });
  const auth = {
    authenticator: "photon-imessage",
    principalId: `member:${member.id}`,
    principalType: "user",
    attributes: { orgId: TEST_ORG, memberId: member.id, phone: OWNER_PHONE },
  };
  const { errors, restore } = silenceErrors();
  let result: { posted: boolean };
  try {
    result = await handleFailure(
      { threadId: `imessage:${OWNER_PHONE}`, auth },
      new Error("turn broke"),
      { post: async () => Promise.reject(new Error("photon down")), now: new Date() },
    );
  } finally {
    restore();
  }
  assert.deepEqual(result, { posted: false });
  assert.equal(errors.length, 2);
  assert.equal((await allMessages()).filter((r) => r.direction === "outbound").length, 0);
});

withTestDb("a photo sent from web chat is logged with no phone or thread, and a quote made after it carries it", async () => {
  const { member } = await owner();
  const caller = { orgId: TEST_ORG, memberId: member.id, name: "Pat Example", role: "owner" as const, language: "en" as const, phoneE164: null };
  const since = new Date(Date.now() - 60_000);
  const photo = { type: "image" as const, url: "https://blob.example/inbound/yard.jpg", name: "yard.jpg", mimeType: "image/jpeg" };
  const id = await logWebInbound({ caller, attachment: photo });
  const [row] = await allMessages();
  assert.equal(row.id, id);
  assert.equal(row.phoneE164, null);
  assert.equal(row.threadId, null);
  assert.equal(row.providerMessageId, null);
  assert.equal(row.direction, "inbound");
  assert.equal(row.kind, "user");
  assert.deepEqual(row.attachments, [photo]);

  const [item] = await saveItems(TEST_ORG, [{ name: "mowing", unitKind: "visit", unitLabel: "visit", priceCents: 6000 }], member.id);
  const quote = await createQuote({ title: "412 Oak", lines: [{ itemId: item.id, quantity: 1 }] }, caller, { post: quietPoster, photosSince: since });
  const linked = await db().select().from(quoteAttachments).where(eq(quoteAttachments.quoteId, quote.quoteId));
  assert.deepEqual(
    linked.map((a) => [a.messageId, a.url, a.mimeType]),
    [[id, photo.url, "image/jpeg"]],
  );
});
