import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { getCustomer } from "../../../core/customers";
import { listQuotes } from "../../../core/quotes";
import type config from "./evals.config";

// A merge can't be taken back by text, so the assistant asks first, and only a yes in the member's next
// message merges.
export default defineEval<typeof config>({
  description: "\"Jane Smith and J. Smith are the same\" asks to confirm, then merges on yes.",
  async test(t) {
    const business = await t.context.seed.duplicateCustomers();

    const first = await t.send("Jane Smith and J. Smith are the same person");
    t.succeeded();
    first.calledTool("find_customer");
    t.judge(
      "The reply asks the member to confirm merging J. Smith into Jane Smith (or the two customers into one), naming both, before doing it. It doesn't say they are already merged. No markdown.",
    ).gate(0.7);
    t.check((await getCustomer(business.orgId, business.j.id))?.archivedAt ?? null, equals(null)).label("nothing merged before the yes");

    const next = await first.session.send("yes");
    next.calledTool("merge_customers");
    t.judge("The reply confirms in a line or two that the two are now one customer, Jane Smith. No markdown.").gate(0.7);

    const merged = await getCustomer(business.orgId, business.j.id);
    t.check(merged?.mergedIntoId, equals(business.jane.id)).label("J. Smith merged into Jane Smith");
    const quotes = await listQuotes(business.orgId, { customerId: business.jane.id });
    t.check(
      quotes.map((q) => q.quoteId).sort(),
      satisfies((ids: string[]) => ids.length === 2 && ids.includes(business.j.quoteId), "both quotes are Jane Smith's"),
    ).label("quotes moved");
    const jane = await getCustomer(business.orgId, business.jane.id);
    t.check(jane?.emails, satisfies((emails: string[] | undefined) => Boolean(emails?.includes("jsmith@example.test")), "J. Smith's email is Jane's now"));
  },
});
