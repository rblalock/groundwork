import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuoteLinkDetails } from "../components/quotes/quote-link";
import { quoteSlots, type QuoteShown } from "./customer-pages";

/** An open quote as the link sends it when the business hides line prices: each line's scope, the totals priced. */
const hidden: QuoteShown = {
  kind: "open",
  orgId: "org_test",
  business: { name: "Test Co", phone: null, email: null, address: null, licenseNumber: null, logoVersion: null },
  language: "en",
  quote: {
    title: "4512 Palm Ave",
    revisionId: "rev_test",
    customerName: "Pat Example",
    address: null,
    linePrices: false,
    lines: [
      { name: "Hedge trimming", quantity: 150, unitLabel: "cubic foot", unitCents: null, totalCents: null },
      { name: "Mulch installed", quantity: 3, unitLabel: "cubic yard", unitCents: null, totalCents: null },
    ],
    ruleLines: [{ label: "Slope surcharge", cents: null }],
    subtotalCents: 61_800,
    minimumAppliedCents: 0,
    adjustmentCents: 0,
    override: false,
    taxRateBp: null,
    taxCents: 0,
    totalCents: 61_800,
    validUntil: "2099-12-31",
    notes: null,
    pdfUrl: null,
    pricedPhotos: [],
  },
  approval: null,
  deposit: null,
  payments: [],
};

test("with line prices hidden, the customer's quote shows each line's name and quantity and only the total", () => {
  const designed = quoteSlots(hidden, { token: "tok", logoSrc: null }).blocks["quote.items"];
  const standard = renderToStaticMarkup(createElement(QuoteLinkDetails, { page: hidden, token: "tok" }));
  for (const html of [designed, standard]) {
    assert.match(html, /Hedge trimming/);
    assert.match(html, /150 cubic feet/);
    assert.match(html, /3 cubic yards/);
    assert.match(html, /Slope surcharge/);
    assert.match(html, /\$618\.00/, "the total stays");
    assert.doesNotMatch(html, / × /, "no unit price");
    assert.doesNotMatch(html, /—/, "no empty amount");
    assert.equal(html.match(/\$\d/g)?.length, 2, "only the subtotal and the total are money");
  }
  assert.doesNotMatch(designed, />Amount</, "no Amount column");

  const shown = quoteSlots(
    {
      ...hidden,
      quote: {
        ...hidden.quote,
        linePrices: true,
        lines: [{ name: "Hedge trimming", quantity: 150, unitLabel: "cubic foot", unitCents: 412, totalCents: 61_800 }],
        ruleLines: [],
      },
    },
    { token: "tok", logoSrc: null },
  ).blocks["quote.items"];
  assert.match(shown, /150 cubic feet × \$4\.12/);
  assert.match(shown, />Amount</);
});
