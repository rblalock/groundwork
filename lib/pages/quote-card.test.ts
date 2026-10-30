// A quote's card in the chat: the quote as it is now, for whoever may see it, with Approve only for an
// owner or admin on a ready draft.
import assert from "node:assert/strict";
import { pricedPhotos } from "../../schema/schema";
import { db, newId } from "../../core/db";
import { saveItems } from "../../core/pricebook";
import { approveQuote, createQuote, type Poster } from "../../core/quotes";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { GET as cardRoute } from "../../app/api/quotes/[id]/card/route";
import type { QuoteCard } from "./quotes";
import { BASE, call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

const quiet: Poster = async () => ({ posted: true });

withTestDb("a quote's card: anyone on the team sees it, approvable by an owner on a ready draft", async () => {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crew = await person("Sam Crew", "member", "+15555550102");
  const otherCrew = await person("Lu Crew", "member", "+15555550103");
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.memberId);
  const draft = await createQuote({ title: "1 Example St", lines: [{ itemId: item.id, quantity: 2 }] }, crew, { post: quiet });
  const card = async (headers: Headers) => (await call(cardRoute, headers, { params: { id: draft.quoteId } })).body?.quote as QuoteCard;

  const ownerHeaders = await signIn(owner.phoneE164!);
  const forOwner = await card(ownerHeaders);
  assert.deepEqual(
    [forOwner.title, forOwner.totalCents, forOwner.status, forOwner.ready, forOwner.canApprove],
    ["1 Example St", 2400, draft.status, true, true],
  );
  const forCrew = await card(await signIn(crew.phoneE164!));
  assert.equal(forCrew.canApprove, false, "crew see their own quote but don't approve it");

  assert.equal((await card(await signIn(otherCrew.phoneE164!))).canApprove, false, "other crew see it too, and don't approve it");
  const outsider = await person("Lee Outsider", "owner", "+15555550109", await otherBusiness());
  refused(await call(cardRoute, await signIn(outsider.phoneE164!), { params: { id: draft.quoteId } }), 404);
  assert.equal((await card(await superAdminViewing(TEST_ORG))).canApprove, false, "a super admin looking in approves nothing");

  // Approved, it's no longer for approving, and the card says so.
  await approveQuote(draft.quoteId, owner, { post: quiet });
  const after = await card(ownerHeaders);
  assert.deepEqual([after.status, after.canApprove], ["approved", false]);
});

withTestDb("a quote's card: a reply that made a post shows the post, once the quote has a before-and-after", async () => {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const quote = await createQuote({ title: "1 Example St", lines: [{ name: "Mulch installed", quantity: 3, unitLabel: "cubic yard", unitCents: 9500 }] }, owner, { post: quiet });
  const headers = await signIn(owner.phoneE164!);
  const card = async (query: string) => {
    const response = await cardRoute(new Request(`${BASE}/api/quotes/${quote.quoteId}/card${query}`, { headers }), { params: Promise.resolve({ id: quote.quoteId }) });
    return { status: response.status, quote: ((await response.json()) as { quote?: QuoteCard }).quote };
  };

  assert.equal((await card("?post=square")).quote?.post, null, "no before-and-after, no post");
  const photo = (sourceKind: "quote_attachment" | "work_photo") =>
    db()
      .insert(pricedPhotos)
      .values({
        id: newId("ppho"),
        orgId: TEST_ORG,
        quoteId: quote.quoteId,
        revisionNumber: 1,
        sourceKind,
        sourceId: newId("src"),
        sourceUrl: `fake://${sourceKind}.jpg`,
        url: "fake://priced.png",
        width: 400,
        height: 300,
        regions: [],
      })
      .returning()
      .then(([row]) => row);
  await photo("quote_attachment");
  const after = await photo("work_photo");

  const plain = await card("");
  assert.ok(plain.quote?.pricedPhoto);
  assert.equal(plain.quote.post, null, "a card not asked for the post shows the priced photo");
  const story = (await card("?post=story")).quote;
  assert.equal(story?.post?.format, "story");
  assert.match(story?.post?.url ?? "", new RegExp(`^/api/quotes/${quote.quoteId}/post\\?v=${after.createdAt.getTime()}\\.\\d+&format=story&cta=1$`));
  assert.equal((await card("?post=tall")).status, 400);
});
