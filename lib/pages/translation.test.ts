import assert from "node:assert/strict";
import { afterEach } from "node:test";
import { eq } from "drizzle-orm";
import { conversations, members } from "../../schema/schema";
import type { Translator } from "../../core/translation";
import { threadFor, upsertThread } from "../../core/conversations";
import { db } from "../../core/db";
import { listGlossary } from "../../core/glossary";
import { openJob } from "../../core/jobs";
import { saveItems } from "../../core/pricebook";
import { createQuote } from "../../core/quotes";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { setTranslatorForTests } from "../../core/translation";
import { admitTurn, setUsageLimits } from "../../core/usage-limits";
import type { EveMessage } from "eve/client";
import { messages as messageRows, translations } from "../../schema/schema";
import { newId } from "../../core/db";
import { POST as translateRoute } from "../../app/api/conversations/[id]/translate/route";
import { setSessionReaderForTests } from "./translation";
import { PUT as glossaryRoute } from "../../app/api/glossary/route";
import { call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

afterEach(() => {
  setTranslatorForTests(null);
  setSessionReaderForTests(null);
});

/** Every text the fake model was asked to translate. */
let asked: string[] = [];
const fake: Translator = async ({ text }) => {
  asked.push(text);
  return { sourceLanguage: "en", text: `es:${text}` };
};

/** One finished message per text, as eve's stream reduces to, with ids `<session>-<n>`. */
const sessionOf = (sessionId: string, texts: string[]): EveMessage[] =>
  texts.map((text, n) => ({ id: `${sessionId}-${n}`, role: n % 2 ? "assistant" : "user", parts: [{ type: "text", text, state: "done" }], metadata: {} }) as unknown as EveMessage);

/** The sessions eve would stream, by session id, and the cookies each read came with. */
let sessions: Record<string, EveMessage[]> = {};
let readWith: string[] = [];

/** An owner and a crew member, each with a thread and a job; the crew's first job is about their own quote. */
async function seed() {
  installTransport();
  asked = [];
  readWith = [];
  setTranslatorForTests(fake);
  setSessionReaderForTests(async (sessionId, headers) => {
    readWith.push(headers.get("cookie") ?? "");
    return sessions[sessionId] ?? [];
  });
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crew = await person("Sam Crew", "member", "+15555550102");
  const crew2 = await person("Lee Crew", "member", "+15555550103");
  for (const member of [owner, crew, crew2]) await upsertThread(TEST_ORG, member.memberId, `ses_${member.memberId}`);
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.memberId);
  const crewQuote = await createQuote({ title: "5 Sample Ln", lines: [{ itemId: item.id, quantity: 3 }] }, crew, { post: async () => ({ posted: true }) });
  const crewThread = (await threadFor(TEST_ORG, crew.memberId))!;
  const crewJob = await openJob(crew, { id: "job_crew", thread: crewThread, title: "5 Sample Ln", quoteId: crewQuote.quoteId });
  const crewLoose = await openJob(crew, { id: "job_loose", thread: crewThread, title: "Something else" });
  const ownerThread = (await threadFor(TEST_ORG, owner.memberId))!;
  const ownerJob = await openJob(owner, { id: "job_owner", thread: ownerThread, title: "Owner's job" });
  const crew2Thread = (await threadFor(TEST_ORG, crew2.memberId))!;
  // Jobs get sessions when they start; these have.
  for (const job of [crewJob, crewLoose, ownerJob]) {
    await db().update(conversations).set({ eveSessionId: `ses_${job.id}` }).where(eq(conversations.id, job.id));
  }
  sessions = {
    [ownerThread.eveSessionId!]: sessionOf(ownerThread.eveSessionId!, ["Quote 12 Oak St", "Done, $280"]),
    [crewThread.eveSessionId!]: sessionOf(crewThread.eveSessionId!, ["¿Mañana a las 9?", "Sí"]),
    [crew2Thread.eveSessionId!]: sessionOf(crew2Thread.eveSessionId!, ["Lee's own message"]),
    "ses_job_crew": sessionOf("ses_job_crew", ["See you at 9"]),
    "ses_job_loose": sessionOf("ses_job_loose", ["Something else"]),
    "ses_job_owner": sessionOf("ses_job_owner", ["Owner's job text"]),
  };
  // What the assistant texted the owner on its own: part of the owner's thread.
  await db().insert(messageRows).values({
    id: "msg_morning",
    orgId: TEST_ORG,
    memberId: owner.memberId,
    phoneE164: owner.phoneE164!,
    direction: "outbound",
    kind: "proactive",
    providerMessageId: `pm_${newId("x")}`,
    threadId: `thread:${owner.phoneE164}`,
    body: "Good morning, two visits today",
  });
  return { owner, crew, crew2, crewThread, crewJob, crewLoose, ownerThread, ownerJob, crew2Thread };
}

const translate = (headers: Headers, id: string, ids: string[]) => call(translateRoute, headers, { params: { id }, body: { target: "es", ids } });

withTestDb("members translate only conversations they may read: their own, and for owners a crew job about a quote", async () => {
  const s = await seed();
  const ownerHeaders = await signIn(s.owner.phoneE164!);
  const crewHeaders = await signIn(s.crew.phoneE164!);
  const ownerFirst = `${s.ownerThread.eveSessionId}-0:0`;

  const own = await translate(ownerHeaders, s.ownerThread.id, [ownerFirst, "texted:msg_morning"]);
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.deepEqual(own.body, {
    target: "es",
    translations: [
      { id: ownerFirst, text: "es:Quote 12 Oak St", sourceLanguage: "en", translated: true },
      { id: "texted:msg_morning", text: "es:Good morning, two visits today", sourceLanguage: "en", translated: true },
    ],
  });
  assert.equal(own.response.headers.get("cache-control"), "private, no-store");
  // The session is read as the caller, with their own cookie, so eve's channel auth checks it too.
  assert.equal(readWith.at(-1), ownerHeaders.get("cookie"));
  assert.equal((await translate(crewHeaders, s.crewThread.id, [`${s.crewThread.eveSessionId}-1:0`])).status, 200);
  assert.equal((await translate(crewHeaders, s.crewJob.id, ["ses_job_crew-0:0"])).status, 200);
  assert.equal((await translate(ownerHeaders, s.ownerJob.id, ["ses_job_owner-0:0"])).status, 200);
  // An owner reads a crew member's job about a quote, as the job page lets them.
  assert.equal((await translate(ownerHeaders, s.crewJob.id, ["ses_job_crew-0:0"])).status, 200);

  // Nobody else's thread, not even the owner's view of crew's; crew get no one else's job.
  refused(await translate(ownerHeaders, s.crewThread.id, [`${s.crewThread.eveSessionId}-0:0`]), 404, "NOT_FOUND");
  refused(await translate(ownerHeaders, s.crewLoose.id, ["ses_job_loose-0:0"]), 404, "NOT_FOUND");
  refused(await translate(crewHeaders, s.ownerThread.id, [ownerFirst]), 404, "NOT_FOUND");
  refused(await translate(crewHeaders, s.crew2Thread.id, [`${s.crew2Thread.eveSessionId}-0:0`]), 404, "NOT_FOUND");
  refused(await translate(crewHeaders, s.ownerJob.id, ["ses_job_owner-0:0"]), 404, "NOT_FOUND");
  refused(await translate(crewHeaders, "conv_nope", ["x"]), 404, "NOT_FOUND");

  refused(await call(translateRoute, crewHeaders, { params: { id: s.crewThread.id }, body: { target: "fr", ids: ["x"] } }), 400, "INVALID_INPUT");
  refused(await translate(crewHeaders, s.crewThread.id, []), 400, "INVALID_INPUT");
  refused(await translate(crewHeaders, s.crewThread.id, Array(41).fill("x")), 400, "INVALID_INPUT");
});

withTestDb("crew can't cache a translation of text that isn't in a conversation they can read", async () => {
  const s = await seed();
  const crewHeaders = await signIn(s.crew.phoneE164!);
  const before = asked.length;
  // Text from the browser isn't taken at all.
  const forged = await call(translateRoute, crewHeaders, {
    params: { id: s.crewThread.id },
    body: { target: "es", texts: ["Done, $280"], ids: undefined },
  });
  refused(forged, 400, "INVALID_INPUT");
  // Another conversation's message, or the owner's own texted line, asked for on crew's thread: refused, whole.
  const ownId = `${s.crewThread.eveSessionId}-0:0`;
  refused(await translate(crewHeaders, s.crewThread.id, [ownId, `${s.ownerThread.eveSessionId}-1:0`]), 404, "NOT_FOUND");
  refused(await translate(crewHeaders, s.crewThread.id, ["texted:msg_morning"]), 404, "NOT_FOUND");
  refused(await translate(crewHeaders, s.crewJob.id, [ownId]), 404, "NOT_FOUND");
  assert.equal(asked.length, before, "nothing went to the model");
  assert.equal((await db().select().from(translations)).length, 0, "nothing was cached");
});

withTestDb("another business and a super admin's look-only view translate nothing here", async () => {
  const s = await seed();
  const other = await otherBusiness();
  const outsider = await person("Lee Outsider", "owner", "+15555550109", other);
  const outsiderHeaders = await signIn(outsider.phoneE164!);
  const ownerFirst = `${s.ownerThread.eveSessionId}-0:0`;
  refused(await translate(outsiderHeaders, s.ownerThread.id, [ownerFirst]), 404, "NOT_FOUND");
  refused(await translate(outsiderHeaders, s.crewJob.id, ["ses_job_crew-0:0"]), 404, "NOT_FOUND");
  refused(await translate(await superAdminViewing(TEST_ORG), s.ownerThread.id, [ownerFirst]), 404, "NOT_FOUND");
  refused(await translate(new Headers(), s.ownerThread.id, [ownerFirst]), 401, "UNAUTHENTICATED");
  assert.equal(readWith.length, 0, "no session was read");
});

withTestDb("over the business's usage limit, a 429 says so in the member's language, with when to try again", async () => {
  const s = await seed();
  await db().update(members).set({ language: "es" }).where(eq(members.id, s.crew.memberId));
  const crewHeaders = await signIn(s.crew.phoneE164!);
  await setUsageLimits(TEST_ORG, { hourlyOutputTokens: 1_000 }, "test");
  assert.ok((await admitTurn({ orgId: TEST_ORG, channel: "text", key: "text:busy" })).ok);
  const crewFirst = `${s.crewThread.eveSessionId}-0:0`;
  const limited = await translate(crewHeaders, s.crewThread.id, [crewFirst]);
  refused(limited, 429, "USAGE_LIMIT");
  assert.match(String(limited.body?.error), /límite de uso/);
  assert.ok(Number(limited.response.headers.get("retry-after")) > 0);

  // A model, or a session, that can't be read is a 503, never a crash.
  setTranslatorForTests(async () => {
    throw new Error("down");
  });
  await setUsageLimits(TEST_ORG, { hourlyOutputTokens: null }, "test");
  const original = console.error;
  console.error = () => {};
  try {
    refused(await translate(crewHeaders, s.crewThread.id, [crewFirst]), 503, "TRANSLATION_UNAVAILABLE");
    setSessionReaderForTests(async () => {
      throw new Error("eve down");
    });
    refused(await translate(crewHeaders, s.crewThread.id, [crewFirst]), 503, "TRANSLATION_UNAVAILABLE");
  } finally {
    console.error = original;
  }
});

withTestDb("owners and admins save the glossary from Settings; crew and a super admin's view can't", async () => {
  const s = await seed();
  const ownerHeaders = await signIn(s.owner.phoneE164!);
  const crewHeaders = await signIn(s.crew.phoneE164!);
  const terms = [{ term: "quote", spanish: "presupuesto", note: "On every PDF" }, { term: "visit", spanish: "visita" }];

  const saved = await call(glossaryRoute, ownerHeaders, { method: "PUT", body: { terms } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body?.terms, [
    { term: "quote", spanish: "presupuesto", note: "On every PDF" },
    { term: "visit", spanish: "visita", note: "" },
  ]);
  refused(await call(glossaryRoute, ownerHeaders, { method: "PUT", body: { terms: [...terms, { term: "Quote", spanish: "cotización" }] } }), 400, "GLOSSARY_DUPLICATE");
  refused(await call(glossaryRoute, ownerHeaders, { method: "PUT", body: { terms: [{ term: "quote", spanish: "" }] } }), 400, "GLOSSARY_INVALID");
  refused(await call(glossaryRoute, crewHeaders, { method: "PUT", body: { terms: [] } }), 403, "NOT_PRIVILEGED");
  refused(await call(glossaryRoute, await superAdminViewing(TEST_ORG), { method: "PUT", body: { terms: [] } }), 403, "NOT_A_MEMBER");
  assert.equal((await listGlossary(TEST_ORG)).length, 2);
});
