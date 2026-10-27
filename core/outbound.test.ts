import assert from "node:assert/strict";
import { afterEach } from "node:test";
import { asc, eq } from "drizzle-orm";
import { messages } from "../schema/schema";
import { db } from "./db";
import { setTransportForTests } from "./imessage";
import { addPhone, createMember, recordInbound, setPhoneStatus } from "./members";
import { lastProactiveFor, notifyOwners, postToMember } from "./outbound";
import { getProfile } from "./profile";
import { TEST_ORG, withTestDb } from "./test-db";

type Recorded = { kind: "text" | "file"; threadId: string; text?: string; filename?: string; caption?: string };
let recorded: Recorded[] = [];
let counter = 0;
let failOn: number | null = null;

function install() {
  recorded = [];
  counter = 0;
  setTransportForTests({
    postText: async (threadId, text) => {
      if (failOn !== null && recorded.length === failOn) throw new Error("boom");
      recorded.push({ kind: "text", threadId, text });
      return [`sent_${++counter}`];
    },
    // Any caption argument is recorded, to prove none is passed.
    postFile: async (threadId, file, ...rest: unknown[]) => {
      recorded.push({ kind: "file", threadId, filename: file.filename, caption: rest[0] as string | undefined });
      return `sent_${++counter}`;
    },
    addReaction: async () => {},
  });
}
afterEach(() => {
  setTransportForTests(null);
  failOn = null;
});

const NOON = new Date("2026-10-16T16:00:00Z"); // 12:00 in America/New_York
const LATE = new Date("2026-10-17T02:00:00Z"); // 22:00 in America/New_York

async function memberWithPhone(opts: { name?: string; role?: "owner" | "member"; texted?: boolean; e164?: string } = {}) {
  const member = await createMember({ orgId: TEST_ORG, name: opts.name ?? "Pat", role: opts.role ?? "owner" });
  const phone = await addPhone(TEST_ORG, member.id, opts.e164 ?? "+15555550101");
  if (opts.texted !== false) await recordInbound(TEST_ORG, phone.id, `thread_${member.id}`, new Date("2026-10-16T12:00:00Z"));
  return { member, phone };
}

withTestDb("refuses a phone that never texted", async () => {
  install();
  const { member } = await memberWithPhone({ texted: false });
  assert.deepEqual(await postToMember(TEST_ORG, member.id, { text: "hi" }, "system", { now: NOON }), {
    posted: false,
    reason: "never_texted",
  });
  assert.equal(recorded.length, 0);
});

withTestDb("refuses a member with no phone, an unknown member, and a stopped phone", async () => {
  install();
  const bare = await createMember({ orgId: TEST_ORG, name: "Bare", role: "member" });
  assert.equal((await postToMember(TEST_ORG, bare.id, { text: "hi" }, "system", { now: NOON })).reason, "no_verified_phone");
  assert.equal((await postToMember(TEST_ORG, "mem_missing", { text: "hi" }, "system", { now: NOON })).reason, "no_verified_phone");
  const { member, phone } = await memberWithPhone({ e164: "+15555550102" });
  await setPhoneStatus(TEST_ORG, phone.id, "stopped");
  assert.equal((await postToMember(TEST_ORG, member.id, { text: "hi" }, "system", { now: NOON })).reason, "stopped");
  assert.equal(recorded.length, 0);
});

withTestDb("refuses proactive posts during quiet hours but allows system posts", async () => {
  install();
  const { member } = await memberWithPhone();
  const profile = await getProfile(TEST_ORG);
  assert.deepEqual(await postToMember(TEST_ORG, member.id, { text: "nudge" }, "proactive", { now: LATE, profile }), {
    posted: false,
    reason: "quiet_hours",
  });
  assert.equal(recorded.length, 0);
  assert.deepEqual(await postToMember(TEST_ORG, member.id, { text: "your PDF" }, "system", { now: LATE, profile }), {
    posted: true,
  });
  assert.equal(recorded.length, 1);
  assert.deepEqual(await postToMember(TEST_ORG, member.id, { text: "nudge" }, "proactive", { now: NOON, profile }), {
    posted: true,
  });
});

withTestDb("posts chunks and logs outbound rows", async () => {
  install();
  const { member, phone } = await memberWithPhone();
  const text = "a".repeat(1400) + "\n\n" + "b".repeat(1400);
  const result = await postToMember(TEST_ORG, member.id, { text }, "proactive", { now: NOON });
  assert.deepEqual(result, { posted: true });
  assert.equal(recorded.length, 2);
  const rows = await db().select().from(messages).where(eq(messages.memberId, member.id)).orderBy(asc(messages.createdAt), asc(messages.id));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.direction === "outbound" && r.kind === "proactive" && r.phoneE164 === phone.e164));
  assert.deepEqual(rows.map((r) => r.providerMessageId).sort(), ["sent_1", "sent_2"]);
  assert.deepEqual(rows.map((r) => r.threadId), [`thread_${member.id}`, `thread_${member.id}`]);
  assert.equal(rows.find((r) => r.providerMessageId === "sent_1")?.body, "a".repeat(1400));
});

withTestDb("a file post sends its text first and the file alone, logging both with the quote id", async () => {
  install();
  const { member } = await memberWithPhone();
  const { quoteId } = await seedQuote(member.id);
  const file = { filename: "quote-1.pdf", mimeType: "application/pdf", data: Buffer.from("pdf") };
  await postToMember(TEST_ORG, member.id, { text: "Quote ready: $392", file, quoteId }, "system", { now: NOON });
  await postToMember(TEST_ORG, member.id, { file }, "system", { now: NOON });
  // A caption would come back as the post's id and hide the file bubble's, so the file goes alone.
  assert.deepEqual(
    recorded.map((r) => [r.kind, r.text ?? r.caption]),
    [["text", "Quote ready: $392"], ["file", undefined], ["file", undefined]],
  );
  const rows = await db().select().from(messages).orderBy(asc(messages.providerMessageId));
  assert.deepEqual(rows.map((r) => [r.providerMessageId, r.body, r.quoteId]), [
    ["sent_1", "Quote ready: $392", quoteId],
    ["sent_2", "Quote ready: $392", quoteId],
    ["sent_3", "quote-1.pdf", null],
  ]);
});

withTestDb("a failed send reports send_failed and logs only what went out", async () => {
  install();
  const { member } = await memberWithPhone();
  failOn = 1; // second chunk fails
  const text = "a".repeat(1400) + "\n\n" + "b".repeat(1400);
  assert.deepEqual(await postToMember(TEST_ORG, member.id, { text }, "system", { now: NOON }), {
    posted: false,
    reason: "send_failed",
  });
  const rows = await db().select().from(messages);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].providerMessageId, "sent_1");
});

withTestDb("notifyOwners posts to owners and admins only and returns their names", async () => {
  install();
  await memberWithPhone({ name: "Pat", role: "owner", e164: "+15555550101" });
  await memberWithPhone({ name: "Carlos", role: "member", e164: "+15555550102" });
  await memberWithPhone({ name: "Ana", role: "owner", e164: "+15555550103", texted: false });
  assert.deepEqual(await notifyOwners(TEST_ORG, "heads up", "system"), { notified: ["Pat"], queued: [] });
  assert.equal(recorded.length, 1);
});

withTestDb("notifyOwners queues a text held by quiet hours, and the 07:00 tick sends it", async () => {
  install();
  await memberWithPhone({ name: "Pat", role: "owner", e164: "+15555550101" });
  assert.deepEqual(await notifyOwners(TEST_ORG, "Carlos suggested a rule", "proactive", { now: LATE }), {
    notified: [],
    queued: ["Pat"],
  });
  assert.equal(recorded.length, 0);
  const { runHourlyTick } = await import("./followups");
  assert.equal((await runHourlyTick(new Date("2026-10-17T05:00:00Z"))).notices, 0, "01:00 is still quiet");
  assert.equal((await runHourlyTick(new Date("2026-10-17T11:00:00Z"))).notices, 1, "07:00 sends it");
  assert.deepEqual(recorded.map((r) => r.text), ["Carlos suggested a rule"]);
  assert.equal((await runHourlyTick(new Date("2026-10-17T12:00:00Z"))).notices, 0, "and only once");
});

withTestDb("lastProactiveFor returns the newest proactive text since the cutoff", async () => {
  install();
  const { member } = await memberWithPhone();
  assert.equal(await lastProactiveFor(TEST_ORG, member.id, new Date("2026-10-01T00:00:00Z")), null);
  await postToMember(TEST_ORG, member.id, { text: "first nudge" }, "proactive", { now: NOON });
  await postToMember(TEST_ORG, member.id, { text: "a system note" }, "system", { now: NOON });
  const found = await lastProactiveFor(TEST_ORG, member.id, new Date("2000-01-01T00:00:00Z"));
  assert.equal(found?.text, "first nudge");
  assert.ok(found?.at instanceof Date);
  assert.equal(await lastProactiveFor(TEST_ORG, member.id, new Date("2999-01-01T00:00:00Z")), null);
});

async function seedQuote(memberId: string): Promise<{ quoteId: string }> {
  const { quotes } = await import("../schema/schema");
  const { newId } = await import("./db");
  const quoteId = newId("q");
  await db().insert(quotes).values({ id: quoteId, orgId: TEST_ORG, title: "Palm Ave", createdByMemberId: memberId });
  return { quoteId };
}
