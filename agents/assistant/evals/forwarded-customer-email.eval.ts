import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { searchCustomers } from "../../../core/customers";
import { listQuotes } from "../../../core/quotes";
import type config from "./evals.config";
import { emailTurnResult, forwardEmail } from "./forwarded-email";

// The owner forwards a customer's request. The assistant saves the customer from the forward (name and
// email) and drafts a quote from its saved prices, then texts the owner a short summary.
export default defineEval<typeof config>({
  description: "A forwarded customer request becomes a customer and a draft quote, summarized by text.",
  timeoutMs: 300_000,
  async test(t) {
    const business = await t.context.seed.emailBusiness();
    const { since } = await forwardEmail(t.target, business, {
      subject: "Fwd: Window cleaning at 12 Example St",
      text: [
        "Can you quote this?",
        "",
        "---------- Forwarded message ---------",
        "From: Jane Doe <jane@example.com>",
        "Date: Mon, Oct 12, 2026 at 9:02 AM",
        "Subject: Window cleaning at 12 Example St",
        "To: <pat@example.com>",
        "",
        "Hi, could you clean 20 windows, inside and out, at 12 Example St? Screens too, there are 20.",
        "Thanks, Jane",
        "(555) 555-0123",
      ].join("\n"),
    });
    const { reply, tools } = await emailTurnResult(business, since, (ms) => t.sleep(ms));
    t.log(`reply: ${reply}`);
    t.log(`tools: ${tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`);

    const [jane] = await searchCustomers(business.orgId, "Jane Doe");
    t.check(jane?.emails ?? [], satisfies((emails: string[]) => emails.includes("jane@example.com"), "Jane Doe saved with her email")).label("customer from the forward");
    const quotes = await listQuotes(business.orgId, { limit: 5 });
    t.check(
      quotes,
      satisfies((list: Array<{ status: string; customerName?: string | null }>) => list.some((q) => q.status === "draft" || q.status === "needs_owner"), "a draft quote"),
    ).label("draft quote");
    t.check(tools.filter((tool) => tool.name === "approve_quote" && tool.status === "ok").length, satisfies((n: number) => n === 0, "nothing approved")).label("not approved");
    t.judge(
      "This is a text to the business owner, summarizing what the assistant did with an email they forwarded from a customer, Jane Doe, asking to clean 20 windows and 20 screens at 12 Example St. " +
        "It is short (a few lines at most), says Jane was saved or found as the customer and that a quote was drafted or is ready for their ok (a total is fine), and invents no facts. No markdown.",
      { on: reply },
    ).gate(0.7);
  },
});
