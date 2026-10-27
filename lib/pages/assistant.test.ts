import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import type { EveMessage } from "eve/client";
import { messages } from "../../schema/schema";
import { db, newId } from "../../core/db";
import { logOutbound, postToMember } from "../../core/outbound";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { GET as textsRoute } from "../../app/api/assistant/texts/route";
import { CODE_MASK } from "../login-codes";
import { interleave, messageTimes } from "../thread-merge";
import { presentTexted, textedFor, type TextedJson } from "./assistant";
import { appCaller, call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

const at = (iso: string) => new Date(iso);

test("assistant texts: a file post's text rows fold into it, and only real URLs are links", () => {
  const base = { quoteId: null as string | null, attachments: [] as (typeof messages.$inferSelect)["attachments"] };
  const shown = presentTexted([
    { ...base, id: "m1", kind: "proactive", body: "Morning. Two visits today.", createdAt: at("2026-10-18T13:00:00Z") },
    { ...base, id: "m2", kind: "system", body: "Invoice 12 for $120.00,", createdAt: at("2026-10-18T14:00:00Z") },
    { ...base, id: "m3", kind: "system", body: "due Nov 1.", createdAt: at("2026-10-18T14:00:00Z") },
    {
      ...base,
      id: "m4",
      kind: "system",
      body: "Invoice 12 for $120.00, due Nov 1.",
      attachments: [{ type: "file", url: "https://blob.example.test/invoice-12.pdf", name: "Invoice 12.pdf", mimeType: "application/pdf" }],
      createdAt: at("2026-10-18T14:00:01Z"),
    },
    // A quote's PDF sent alone, logged before files carried their URL: its file name, and the quote.
    { ...base, id: "m5", kind: "system", body: "Quote 3 - Example job.pdf", quoteId: "q_3", createdAt: at("2026-10-18T15:00:00Z") },
    // A stand-in URL from local dev isn't a link.
    {
      ...base,
      id: "m6",
      kind: "system",
      body: "Notes.pdf",
      attachments: [{ type: "file", url: "fake://notes.pdf", name: "Notes.pdf" }],
      createdAt: at("2026-10-18T16:00:00Z"),
    },
    { ...base, id: "m7", kind: "assistant", body: "A reply the session shows", createdAt: at("2026-10-18T17:00:00Z") },
  ]);
  assert.deepEqual(
    shown.map((t) => [t.id, t.text, t.file]),
    [
      ["m1", "Morning. Two visits today.", null],
      ["m4", "Invoice 12 for $120.00, due Nov 1.", { name: "Invoice 12.pdf", href: "https://blob.example.test/invoice-12.pdf" }],
      ["m5", "", { name: "Quote 3 - Example job.pdf", href: "/api/quotes/q_3/pdf" }],
      ["m6", "", { name: "Notes.pdf", href: null }],
    ],
  );
});

test("assistant texts: they go between the session's messages by time, and the session keeps its order", () => {
  const message = (id: string, role: "user" | "assistant", turnId: string, extra: Partial<EveMessage["metadata"]> = {}): EveMessage => ({
    id,
    role,
    parts: [{ type: "text", text: id, state: "done" }],
    metadata: { status: "complete", turnId, ...extra },
  });
  const events = [
    { type: "message.received", meta: { id: "e1", at: "2026-10-18T13:00:00Z" }, data: { turnId: "t1", sequence: 0 } },
    { type: "turn.completed", meta: { id: "e2", at: "2026-10-18T13:00:30Z" }, data: { turnId: "t1" } },
    { type: "message.received", meta: { id: "e3", at: "2026-10-18T15:00:00Z" }, data: { turnId: "t2", sequence: 0 } },
    { type: "turn.completed", meta: { id: "e4", at: "2026-10-18T15:01:00Z" }, data: { turnId: "t2" } },
  ];
  const session = [
    message("e1:user", "user", "t1"),
    message("t1:assistant", "assistant", "t1"),
    message("e3:user", "user", "t2"),
    message("t2:assistant", "assistant", "t2"),
    message("optimistic", "user", "t3", { optimistic: true, status: "submitted" }),
  ];
  const texted = (id: string, iso: string): TextedJson => ({ id, at: iso, kind: "proactive", text: id, file: null });
  const items = interleave(session, messageTimes(session, events), [
    texted("before-anything", "2026-10-18T12:00:00Z"),
    texted("morning-line", "2026-10-18T14:00:00Z"),
    // Texted during the second turn (its PDF): before the reply that followed it.
    texted("pdf-mid-turn", "2026-10-18T15:00:40Z"),
    texted("later", "2026-10-18T16:00:00Z"),
  ]);
  assert.deepEqual(
    items.map((item) => (item.kind === "message" ? item.message.id : `texted:${item.texted.id}`)),
    [
      "texted:before-anything",
      "e1:user",
      "t1:assistant",
      "texted:morning-line",
      "e3:user",
      "texted:pdf-mid-turn",
      "t2:assistant",
      "texted:later",
      "optimistic",
    ],
  );
});

withTestDb("assistant texts: only the member's own, in their business, never a sign-in code or the session's replies", async () => {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crew = await person("Sam Crew", "member", "+15555550102");
  const other = await otherBusiness();
  const otherOwner = await person("Kim Other", "owner", "+15555550201", other);

  // Signing in texts a code, logged masked in the owner's thread.
  const ownerHeaders = await signIn("+15555550101");
  const crewHeaders = await signIn("+15555550102");
  const codeRows = await db()
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, TEST_ORG), eq(messages.memberId, owner.memberId), eq(messages.kind, "system")));
  assert.equal(codeRows.length, 1, "the sign-in code's text was logged");
  assert.ok(codeRows[0].body.includes(CODE_MASK));
  assert.doesNotMatch(codeRows[0].body, /\d{6}/);

  const log = (who: { orgId: string; memberId: string; phoneE164: string | null }, kind: "assistant" | "proactive" | "system", body: string) =>
    logOutbound({
      orgId: who.orgId,
      memberId: who.memberId,
      phoneE164: who.phoneE164!,
      threadId: `thread:${who.phoneE164}`,
      providerMessageIds: [newId("pm")],
      chunks: [body],
      kind,
    });
  await log(owner, "proactive", "Morning. Two visits today.");
  await log(owner, "assistant", "The session's own reply.");
  await log(crew, "proactive", "Crew notice for Sam.");
  await log(otherOwner, "proactive", "Other business's morning line.");
  await db().insert(messages).values({
    id: newId("msg"),
    orgId: TEST_ORG,
    memberId: owner.memberId,
    phoneE164: owner.phoneE164!,
    direction: "inbound",
    kind: "user",
    body: "What the owner texted.",
    threadId: `thread:${owner.phoneE164}`,
  });
  // A PDF with its caption: one text row and the file row, which carries the stored URL.
  const pdf = await postToMember(
    TEST_ORG,
    owner.memberId,
    { text: "Invoice 1 for $50.00.", file: { filename: "Invoice 1.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF") }, fileUrl: "https://blob.example.test/i1.pdf" },
    "system",
  );
  assert.equal(pdf.posted, true);

  const ownerTexts = await call(textsRoute, ownerHeaders);
  assert.equal(ownerTexts.status, 200);
  assert.deepEqual(
    (ownerTexts.body?.texts as TextedJson[]).map((t) => [t.kind, t.text, t.file]),
    [
      ["proactive", "Morning. Two visits today.", null],
      ["system", "Invoice 1 for $50.00.", { name: "Invoice 1.pdf", href: "https://blob.example.test/i1.pdf" }],
    ],
  );
  const crewTexts = await textedFor(await appCaller(crewHeaders));
  assert.deepEqual(
    crewTexts.map((t) => t.text),
    ["Crew notice for Sam."],
    "crew see only their own, and not their own sign-in code",
  );

  // A super admin looking at the business has no thread here.
  refused(await call(textsRoute, await superAdminViewing(TEST_ORG)), 403, "NOT_A_MEMBER");
});
