import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { searchCustomers } from "../../../../core/customers";
import type config from "../evals.config";

// A new customer named in a quote request is saved with the job's address.
export default defineEval<typeof config>({
  description: "Quoting Maria at 412 Oak St saves Maria as a customer with that address.",
  tags: ["landscaping"],
  async test(t) {
    const business = await t.context.seed.landscaping();

    await t.send("Maria at 412 Oak St wants her front yard mowed, 3 yards of mulch in the beds and about 40 feet of edging.");
    t.succeeded();

    const matches = await searchCustomers(business.orgId, "Maria");
    t.check(matches.length, equals(1)).label("customers named Maria");
    t.check(
      matches[0]?.properties.map((property) => property.address) ?? [],
      satisfies((addresses: string[]) => addresses.some((address) => /412 Oak/i.test(address)), "an address at 412 Oak"),
    ).label("Maria's addresses");
  },
});
