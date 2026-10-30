import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";
import { saveCustomer } from "../../../../core/customers";
import { updateItem } from "../../../../core/pricebook";
import { createQuote, listQuotes } from "../../../../core/quotes";
import type config from "../evals.config";

// Maria's spring quote at 412 Oak St, then mulch goes from $95 to $100 a yard. "Same as last time"
// proposes the same lines at today's prices and waits; "yes" makes the new quote.
export default defineEval<typeof config>({
  description: "Same as last time for Maria proposes her last quote's lines at today's prices, and yes makes a new quote.",
  tags: ["landscaping"],
  async test(t) {
    const business = await t.context.seed.landscaping();
    const ids = business.itemIdsByName;
    const noPost = async () => ({ posted: false as const, reason: "eval" });
    const maria = await saveCustomer(business.orgId, { name: "Maria Alvarez", phone: "305 555 0142", address: "412 Oak St" }, business.owner.memberId);
    // $65 mowing + 3 x $95 mulch + 40 x $2.50 edging = $450.
    const spring = await createQuote(
      {
        title: "412 Oak St",
        customerId: maria.id,
        propertyId: maria.properties[0].id,
        lines: [
          { itemId: ids["Lawn mowing"], quantity: 1 },
          { itemId: ids["Mulch installed"], quantity: 3 },
          { itemId: ids["Bed edging"], quantity: 40 },
        ],
      },
      business.owner,
      { post: noPost },
    );
    await updateItem(business.orgId, ids["Mulch installed"], { priceCents: 10000 }, business.owner.memberId);

    const turn = await t.send("same as last time for maria");
    t.succeeded();
    turn.calledTool("repeat_quote");
    turn.notCalledTool("create_quote");
    // Today: $65 + 3 x $100 + $100 = $465.
    t.check(turn.message, includes("465"));
    t.judge("The reply lists the lines from last time with their quantities, gives the old and new totals, notes the mulch price went up, and asks whether to quote it. It states no total other than $450 and $465.").gate(0.7);

    await turn.session.send("yes");
    t.calledTool("create_quote");
    const quotes = await listQuotes(business.orgId, { customerId: maria.id });
    t.check(quotes.length, equals(2)).label("Maria's quotes");
    const repeat = quotes.find((quote) => quote.quoteId !== spring.quoteId);
    t.check(repeat?.totalCents, equals(46500)).label("new quote total cents");
    t.check(repeat?.propertyAddress ?? null, equals("412 Oak St")).label("new quote's address");
  },
});
