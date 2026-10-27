// A quote's language on its page: the translated view (gated like the quote itself), writing the quote in
// its customer's language, and new customers and members starting in the business's language.
import assert from "node:assert/strict";
import { afterEach } from "node:test";
import { createMember } from "../../core/members";
import { saveCustomer } from "../../core/customers";
import { saveItems } from "../../core/pricebook";
import { updateProfile } from "../../core/profile";
import { approveQuote, createQuote, getQuote, setQuoteOutcome } from "../../core/quotes";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { setTranslatorForTests, type Translator } from "../../core/translation";
import { POST as languageRoute } from "../../app/api/quotes/[id]/language/route";
import { POST as translationRoute } from "../../app/api/quotes/[id]/translation/route";
import { quoteTexts } from "./quote-language";
import { call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

afterEach(() => setTranslatorForTests(null));

let asked: string[] = [];
const fake: Translator = async ({ text }) => {
  asked.push(text);
  return { sourceLanguage: "en", text: `es:${text}` };
};
const quiet = { post: async () => ({ posted: true }) };

async function seed() {
  installTransport();
  asked = [];
  setTranslatorForTests(fake);
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crew = await person("Sam Crew", "member", "+15555550102");
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.memberId);
  const customer = await saveCustomer(TEST_ORG, { name: "Example Customer" }, owner.memberId);
  const quote = await createQuote(
    { title: "1 Example St", customerId: customer.id, lines: [{ itemId: item.id, quantity: 2 }], customerNotes: "Back gate is open." },
    owner,
    quiet,
  );
  const crewQuote = await createQuote({ title: "5 Sample Ln", lines: [{ itemId: item.id, quantity: 3 }] }, crew, quiet);
  return { owner, crew, item, customer, quote, crewQuote };
}

withTestDb("the translated view reads the quote's own texts, for whoever may see the quote", async () => {
  const { owner, crew, quote, crewQuote } = await seed();
  const ownerHeaders = await signIn(owner.phoneE164!);

  const result = await call(translationRoute, ownerHeaders, { params: { id: quote.quoteId }, body: { target: "es" } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const byId = Object.fromEntries((result.body?.translations as Array<{ id: string; text: string }>).map((t) => [t.id, t.text]));
  assert.deepEqual(byId, { title: "es:1 Example St", "line:0": "es:widget service", "unit:widget": "es:widget", notes: "es:Back gate is open." });

  // Texts come from the quote, never the browser.
  refused(await call(translationRoute, ownerHeaders, { params: { id: quote.quoteId }, body: { target: "es", texts: ["planted"] } }), 400, "INVALID_INPUT");
  assert.ok(!asked.includes("planted"));

  // Anyone on the team, crew included; nobody outside the business, and no super admin looking in.
  const crewHeaders = await signIn(crew.phoneE164!);
  assert.equal((await call(translationRoute, crewHeaders, { params: { id: quote.quoteId }, body: { target: "es" } })).status, 200);
  assert.equal((await call(translationRoute, crewHeaders, { params: { id: crewQuote.quoteId }, body: { target: "es" } })).status, 200);
  const other = await otherBusiness();
  const outsider = await person("Lee Outsider", "owner", "+15555550109", other);
  refused(await call(translationRoute, await signIn(outsider.phoneE164!), { params: { id: quote.quoteId }, body: { target: "es" } }), 404);
  refused(await call(translationRoute, await superAdminViewing(TEST_ORG), { params: { id: quote.quoteId }, body: { target: "es" } }), 404);
});

withTestDb("a quote in another language than its customer's switches to theirs as a new revision", async () => {
  const { owner, crew, customer, quote, crewQuote } = await seed();
  const ownerHeaders = await signIn(owner.phoneE164!);
  assert.equal((await getQuote(TEST_ORG, quote.quoteId))?.customerLanguage, "en");
  await saveCustomer(TEST_ORG, { customerId: customer.id, language: "es" }, owner.memberId);

  refused(await call(languageRoute, ownerHeaders, { params: { id: quote.quoteId }, body: { language: "es", revision: 99 } }), 409, "REVISION_CHANGED");
  const switched = await call(languageRoute, ownerHeaders, { params: { id: quote.quoteId }, body: { language: "es", revision: 1 } });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  const after = await getQuote(TEST_ORG, quote.quoteId);
  assert.equal(after?.customerLanguage, "es");
  assert.equal(after?.revisionNumber, 2);
  assert.equal(after?.customerNotes, "Back gate is open.", "the notes carry over");
  // The same language again changes nothing.
  await call(languageRoute, ownerHeaders, { params: { id: quote.quoteId }, body: { language: "es", revision: 2 } });
  assert.equal((await getQuote(TEST_ORG, quote.quoteId))?.revisionNumber, 2);

  // An approved quote goes back to draft, as any revision does.
  const approved = await approveQuote(quote.quoteId, owner, { ...quiet, expectedRevisionNumber: 2 });
  assert.equal(approved.ok, true);
  await call(languageRoute, ownerHeaders, { params: { id: quote.quoteId }, body: { language: "en", revision: 2 } });
  assert.equal((await getQuote(TEST_ORG, quote.quoteId))?.status, "draft");

  // Crew change their own quotes, and anyone's while it's a draft; nobody changes a closed one.
  const crewHeaders = await signIn(crew.phoneE164!);
  assert.equal((await call(languageRoute, crewHeaders, { params: { id: crewQuote.quoteId }, body: { language: "es", revision: 1 } })).status, 200);
  assert.equal((await call(languageRoute, crewHeaders, { params: { id: quote.quoteId }, body: { language: "es", revision: 3 } })).status, 200);
  assert.equal((await approveQuote(quote.quoteId, owner, { ...quiet, expectedRevisionNumber: 4 })).ok, true);
  refused(await call(languageRoute, crewHeaders, { params: { id: quote.quoteId }, body: { language: "en", revision: 4 } }), 403, "NOT_ALLOWED");
  await setQuoteOutcome(quote.quoteId, "void", owner, quiet);
  refused(await call(languageRoute, ownerHeaders, { params: { id: quote.quoteId }, body: { language: "en", revision: 4 } }), 403, "NOT_ALLOWED");
});

withTestDb("new customers and members start in the business's language unless told otherwise", async () => {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  assert.equal((await saveCustomer(TEST_ORG, { name: "Before Spanish" }, owner.memberId)).language, "en");
  await updateProfile(TEST_ORG, { language: "es" }, owner.memberId);
  assert.equal((await saveCustomer(TEST_ORG, { name: "Cliente Ejemplo" }, owner.memberId)).language, "es");
  assert.equal((await saveCustomer(TEST_ORG, { name: "English Customer", language: "en" }, owner.memberId)).language, "en");
  assert.equal((await createMember({ orgId: TEST_ORG, name: "Ana Crew", role: "member" })).language, "es");
  assert.equal((await createMember({ orgId: TEST_ORG, name: "Bo Crew", role: "member", language: "en" })).language, "en");
});

withTestDb("a quote's translatable texts are its title, line names, unit labels (once each), rule labels, and notes", async () => {
  const texts = quoteTexts({
    title: "1 Example St",
    lines: [{ name: "widget service", unitLabel: "Widget" }, { name: "", unitLabel: " widget " }, { name: "gadget", unitLabel: "" }] as never,
    ruleLines: [{ ruleId: "rul_1", label: "Rush job" }] as never,
    customerNotes: "  ",
  });
  assert.deepEqual(texts, [
    { id: "title", text: "1 Example St" },
    { id: "line:0", text: "widget service" },
    { id: "line:2", text: "gadget" },
    { id: "unit:widget", text: "widget" },
    { id: "rule:rul_1", text: "Rush job" },
  ]);
});
