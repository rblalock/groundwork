process.env.PHOTON_ADMIN_FAKE = "1";
process.env.BLOB_FAKE = "1";

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { memberPhones, members, messages, rules } from "../schema/schema";
import { db, newId } from "./db";
import { setTransportForTests, type Tapback } from "./imessage";
import { addPhone, createMember, findMemberByPhone, recordInbound, removeMember, type Member } from "./members";
import { approveQuotePolicy, privilegedOnly } from "./policies";
import { saveItems } from "./pricebook";
import { updateProfile } from "./profile";
import { TEST_ORG, withTestDb } from "./test-db";
import { toolLabels, toolLabelsEs } from "./tool-labels";
import addMember from "../agents/assistant/agent/tools/add_member";
import approveQuoteTool from "../agents/assistant/agent/tools/approve_quote";
import createQuoteTool from "../agents/assistant/agent/tools/create_quote";
import react from "../agents/assistant/agent/tools/react";
import saveRule from "../agents/assistant/agent/tools/save_rule";

type Recorded = { threadId: string; text?: string; reaction?: { messageId: string; emoji: Tapback } };
let recorded: Recorded[] = [];

function install() {
  recorded = [];
  let counter = 0;
  setTransportForTests({
    postText: async (threadId, text) => {
      recorded.push({ threadId, text });
      return [`sent_${++counter}`];
    },
    postFile: async (threadId) => {
      recorded.push({ threadId });
      return `sent_${++counter}`;
    },
    addReaction: async (threadId, messageId, emoji) => {
      recorded.push({ threadId, reaction: { messageId, emoji } });
    },
  });
}
afterEach(() => setTransportForTests(null));

const sess = (memberId: string) => ({
  auth: { current: { authenticator: "photon-imessage", principalId: `member:${memberId}`, attributes: { orgId: TEST_ORG, memberId } } },
});
const ctx = (memberId: string) => ({ session: sess(memberId) }) as never;

type AnyTool = { inputSchema: unknown; execute: (input: never, ctx: never) => unknown };
type Out = Record<string, any>;
/** Calls a tool the way eve does: input parsed by its schema first, so defaults apply. */
async function run(tool: AnyTool, input: unknown, memberId: string): Promise<Out> {
  const parsed = (tool.inputSchema as z.ZodType).parse(input);
  return (await tool.execute(parsed as never, ctx(memberId))) as Out;
}

/** A member whose phone has texted us, so posts to them go through. */
async function texted(name: string, role: Member["role"], e164: string): Promise<Member> {
  const member = await createMember({ orgId: TEST_ORG, name, role });
  const phone = await addPhone(TEST_ORG, member.id, e164);
  await recordInbound(TEST_ORG, phone.id, `thread:${e164}`, new Date(), "iMessage");
  return member;
}

withTestDb("add_member registers the phone, records addedBy, and posts a forwardable invite", async () => {
  install();
  const owner = await texted("Pat", "owner", "+13055550100");
  const result = (await run(addMember, { name: "Carlos Diaz", phone: "305-555-0142", role: "member" }, owner.id)) as Out;
  assert.equal(result.invitePosted, true);
  assert.equal(result.assignedLine, "+15555550100");
  const found = await findMemberByPhone("+13055550142");
  assert.ok(found);
  assert.equal(found.member.name, "Carlos Diaz");
  assert.equal(found.member.addedByMemberId, owner.id);
  assert.equal(found.phone.status, "pending");
  assert.equal(found.phone.photonUserId, "fake_+13055550142");
  assert.equal(found.phone.assignedLine, "+15555550100");
  // One post, to the owner's thread, carrying the line the new person should text.
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].threadId, "thread:+13055550100");
  assert.match(recorded[0].text ?? "", /Carlos, .*\(555\) 555-0100/);
  const [logged] = await db().select().from(messages).where(eq(messages.memberId, owner.id));
  assert.equal(logged.kind, "system");
});

withTestDb("add_member returns an active member's phone without duplicating and reactivates a removed one", async () => {
  install();
  const owner = await texted("Pat", "owner", "+13055550100");
  const first = (await run(addMember, { name: "Carlos", phone: "3055550142" }, owner.id)) as Out;
  const again = (await run(addMember, { name: "Carlos D", phone: "+1 (305) 555-0142" }, owner.id)) as Out;
  assert.equal(again.member.id, first.member.id);
  assert.equal(again.member.name, "Carlos");
  assert.equal((await db().select().from(members)).length, 2);

  await removeMember(TEST_ORG, first.member.id);
  const back = (await run(addMember, { name: "Carlos Diaz", phone: "305-555-0142", role: "admin" }, owner.id)) as Out;
  assert.equal(back.member.id, first.member.id);
  assert.equal(back.member.status, "active");
  assert.equal(back.member.role, "admin");
  assert.equal(back.member.name, "Carlos Diaz");
  const [phone] = await db().select().from(memberPhones).where(eq(memberPhones.e164, "+13055550142"));
  assert.equal(phone.status, "pending");
});

withTestDb("add_member on an active member applies a stated role, keeps it when none is stated, and never demotes an owner", async () => {
  install();
  const owner = await texted("Pat", "owner", "+13055550100");
  const first = await run(addMember, { name: "Carlos", phone: "3055550142" }, owner.id);
  assert.equal(first.member.role, "member");
  const promoted = await run(addMember, { name: "Carlos", phone: "3055550142", role: "admin" }, owner.id);
  assert.equal(promoted.member.id, first.member.id);
  assert.equal(promoted.member.role, "admin");
  assert.equal(promoted.roleChanged, true);
  const unstated = await run(addMember, { name: "Carlos", phone: "3055550142" }, owner.id);
  assert.equal(unstated.member.role, "admin");
  assert.equal(unstated.roleChanged, undefined);
  const [row] = await db().select().from(members).where(eq(members.id, first.member.id));
  assert.equal(row.role, "admin");

  const self = await run(addMember, { name: "Pat", phone: "+13055550100", role: "member" }, owner.id);
  assert.equal(self.member.role, "owner");
  assert.equal(self.roleUnchanged, true);
  assert.equal(self.invitePosted, false);
});

withTestDb("add_member refuses a phone it cannot read", async () => {
  install();
  const owner = await texted("Pat", "owner", "+13055550100");
  const result = (await run(addMember, { name: "Carlos", phone: "12" }, owner.id)) as Out;
  assert.match(result.error ?? "", /INVALID_PHONE/);
  assert.equal(recorded.length, 0);
});

withTestDb("privilegedOnly passes owner and admin, denies crew with a reason", async () => {
  const owner = await createMember({ orgId: TEST_ORG, name: "O", role: "owner" });
  const admin = await createMember({ orgId: TEST_ORG, name: "A", role: "admin" });
  const crew = await createMember({ orgId: TEST_ORG, name: "C", role: "member" });
  const policy = privilegedOnly("do it");
  assert.equal(await policy({ session: sess(owner.id) } as never), "not-applicable");
  assert.equal(await policy({ session: sess(admin.id) } as never), "not-applicable");
  assert.deepEqual(await policy({ session: sess(crew.id) } as never), {
    type: "denied",
    reason: "Only the owner or an admin can do it.",
  });
  assert.deepEqual(await policy({ session: { auth: { current: null } } } as never), {
    type: "denied",
    reason: "Only the owner or an admin can do it.",
  });
  assert.deepEqual(await approveQuotePolicy({ session: sess(crew.id) } as never), {
    type: "denied",
    reason: "Only the owner or an admin can approve quotes. Use request_owner_approval to ask the owner.",
  });
});

withTestDb("save_rule from crew is a suggestion the owners hear about", async () => {
  install();
  const owner = await texted("Pat", "owner", "+13055550100");
  const crew = await texted("Carlos", "member", "+13055550142");
  await updateProfile(TEST_ORG, { quietStartHour: 0, quietEndHour: 0 }, owner.id); // no quiet window, whatever the hour
  const result = (await run(saveRule, { text: "+$50 for rush jobs", kind: "pricing_modifier" }, crew.id)) as Out;
  assert.equal(result.status, "suggested");
  const [row] = await db().select().from(rules);
  assert.equal(row.status, "suggested");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].threadId, "thread:+13055550100");
  assert.match(recorded[0].text ?? "", /Carlos suggested/);
  // The notice must not invite an approval word: "yes" or "ok" here would read as approving a quote.
  assert.doesNotMatch(recorded[0].text ?? "", /\b(yes|ok|approve)\b/i);
  assert.match(recorded[0].text ?? "", /add the rule/);

  const own = (await run(saveRule, { text: "No work after dark", kind: "process" }, owner.id)) as Out;
  assert.equal(own.status, "active");
  assert.equal(recorded.length, 1);
});

withTestDb("create_quote gives crew the crew next step in summaryText", async () => {
  install();
  const owner = await texted("Pat", "owner", "+13055550100");
  const crew = await texted("Carlos", "member", "+13055550142");
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.id);
  const result = (await run(createQuoteTool, 
    { title: "12 Test St", lines: [{ itemId: item.id, quantity: 3 }] },
    crew.id,
  )) as Out;
  assert.equal(result.totalCents, 3600);
  assert.match(result.summaryText, /send it to the owner for approval/);
  assert.doesNotMatch(result.summaryText, /Reply ok to approve/);
});

withTestDb("react tapbacks the caller's latest inbound text and nothing on SMS", async () => {
  install();
  const owner = await texted("Pat", "owner", "+13055550100");
  for (const [i, providerMessageId] of ["p_old", "p_new"].entries()) {
    await db().insert(messages).values({
      id: newId("msg"),
      orgId: TEST_ORG,
      memberId: owner.id,
      phoneE164: "+13055550100",
      direction: "inbound",
      kind: "user",
      providerMessageId,
      threadId: "thread:+13055550100",
      body: "hi",
      createdAt: new Date(Date.now() - (2 - i) * 1000),
    });
  }
  assert.deepEqual(await run(react, { emoji: "thumbs_up" }, owner.id), { reacted: true });
  assert.deepEqual(recorded, [{ threadId: "thread:+13055550100", reaction: { messageId: "p_new", emoji: "thumbs_up" } }]);

  await db().update(memberPhones).set({ lastService: "SMS" }).where(eq(memberPhones.memberId, owner.id));
  assert.deepEqual(await run(react, { emoji: "thumbs_up" }, owner.id), { reacted: false });
  assert.equal(recorded.length, 1);
});

test("approve_quote requires a quoteId", () => {
  const schema = approveQuoteTool.inputSchema as unknown as z.ZodType;
  assert.equal(schema.safeParse({}).success, false);
  assert.equal(schema.safeParse({ expectedRevisionNumber: 1 }).success, false);
  assert.equal(schema.safeParse({ quoteId: "quo_1" }).success, true);
});

test("every tool file exports a defineTool definition with a description", async () => {
  const dir = new URL("../agents/assistant/agent/tools/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.length >= 21, `expected at least 21 tools, found ${files.length}`);
  type Tool = { description?: unknown; execute?: unknown };
  type Dynamic = { kind: "eve:dynamic"; events: Record<string, (event: unknown, ctx: unknown) => Tool | null> };
  // The job tools are thread-only: resolved per turn, they're a tool in a member's thread.
  const inThread = { session: { id: "ses_thread", auth: { current: { authenticator: "photon-imessage", principalId: "member:m", attributes: {} } } } };
  for (const file of files) {
    const mod = (await import(new URL(file, dir).href)) as { default?: Tool | Dynamic };
    const tool = mod.default && "kind" in mod.default && mod.default.kind === "eve:dynamic" ? mod.default.events["turn.started"](undefined, inThread) : (mod.default as Tool | undefined);
    assert.equal(typeof tool?.description, "string", `${file} has no description`);
    assert.equal(typeof tool?.execute, "function", `${file} has no execute`);
  }
});

test("every tool has a label in English and Spanish, and every label a tool", async () => {
  // Every agent's tools, since every agent's chat shows them with these labels, and eve's skill loader.
  const tools: string[] = ["eve__skill"];
  // The designer's browser extension (agents/designer/agent/extensions/browser), less the tools it turns off.
  const browserTools = Object.keys(await import("@agent-browser/eve/tools"));
  const browserDir = new URL("../agents/designer/agent/extensions/browser/tools/", import.meta.url);
  const disabled = new Set<string>();
  for (const f of await readdir(browserDir)) {
    if ((await readFile(new URL(f, browserDir), "utf8")).includes("disableTool()")) disabled.add(f.slice(0, -3));
  }
  tools.push(...browserTools.filter((t) => !disabled.has(t)).map((t) => `browser__${t}`));
  for (const agent of ["assistant", "designer"]) {
    const dir = new URL(`../agents/${agent}/agent/tools/`, import.meta.url);
    tools.push(...(await readdir(dir)).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3)));
  }
  // Agents may share a tool's name (set_logo, update_branding) when it does the same thing; it shares the label.
  const names = [...new Set(tools)].sort();
  assert.deepEqual(Object.keys(toolLabels).sort(), names);
  assert.deepEqual(Object.keys(toolLabelsEs).sort(), names);
  for (const tool of names) assert.equal(Boolean(toolLabelsEs[tool].detail), Boolean(toolLabels[tool].detail), tool);
});
