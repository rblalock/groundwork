import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { searchCustomers } from "../../../../core/customers";
import { listQuotes } from "../../../../core/quotes";
import type config from "../evals.config";

// A new customer named in a quote request is saved with the job's address, and the quote is theirs,
// even from a run-on text.
export default defineEval<typeof config>({
  description: "Quoting maria at 412 oak st saves Maria as a customer with that address and puts the quote on her.",
  tags: ["landscaping"],
  async test(t) {
    const business = await t.context.seed.landscaping();

    await t.send("maria 412 oak st 3 yards of mulch in beds trim 159 c ft of hedge and mow front");
    t.succeeded();

    const matches = await searchCustomers(business.orgId, "Maria");
    t.check(matches.length, equals(1)).label("customers named Maria");
    t.check(
      matches[0]?.properties.map((property) => property.address) ?? [],
      satisfies((addresses: string[]) => addresses.some((address) => /412 Oak/i.test(address)), "an address at 412 Oak"),
    ).label("Maria's addresses");

    const [quote] = await listQuotes(business.orgId, {});
    t.check(quote?.customerId ?? null, equals(matches[0]?.id ?? "a saved Maria")).label("the quote's customer");
  },
});
