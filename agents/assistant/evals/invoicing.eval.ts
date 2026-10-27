import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";
import { and, asc, eq, isNull } from "drizzle-orm";
import { invoices, payments } from "../../../schema/schema";
import { db } from "../../../core/db";
import type config from "./evals.config";

// Read straight from the tables: the invoices library pulls in a lazily loaded module the eval bundler
// can't put in one file.
const invoicesOf = (orgId: string) => db().select().from(invoices).where(eq(invoices.orgId, orgId)).orderBy(asc(invoices.number));
const invoiceById = async (orgId: string, id: string) =>
  (await db().select().from(invoices).where(and(eq(invoices.orgId, orgId), eq(invoices.id, id))))[0];
const paymentsOn = (orgId: string, invoiceId: string) =>
  db().select().from(payments).where(and(eq(payments.orgId, orgId), eq(payments.invoiceId, invoiceId), isNull(payments.removedAt)));

// Invoicing by text: the agreed quote's total, a partial payment and its balance, and who owes what,
// every number from the tools.
export default [
  defineEval<typeof config>({
    description: "\"The Oak St job is done, invoice it\" makes the invoice with the quote's total, without asking for prices.",
    async test(t) {
      const business = await t.context.seed.workToInvoice();
      const turn = await t.send("the Oak St job is done, invoice it");
      t.succeeded();
      turn.calledTool("create_invoice");
      t.check(turn.message, includes("240"));
      t.judge(
        "The reply says an invoice for 12 Oak St was made (or sent) for $240, in a few lines, without asking for any price and without saying the customer was texted or emailed.",
      ).gate(0.7);
      const made = await invoicesOf(business.orgId);
      t.check(made.length, equals(1)).label("invoices made");
      t.check(made[0]?.totalCents, equals(business.oakSt.totalCents)).label("invoice total is the quote's");
      t.check(made[0]?.quoteId, equals(business.oakSt.quoteId)).label("invoice's quote");
      t.check(made[0]?.serviceJobId, equals(business.jobId)).label("invoice's work");
    },
  }),

  defineEval<typeof config>({
    description: "\"Jane paid $150 cash\" records a partial payment on her invoice and gives the right balance.",
    async test(t) {
      const business = await t.context.seed.invoices();
      const turn = await t.send("Jane paid $150 cash");
      t.succeeded();
      turn.calledTool("record_payment");
      t.check(turn.message, includes("90")).label("says the $90 balance");
      t.judge("The reply confirms a $150 cash payment from Jane and that $90 is still due, in a line or two.").gate(0.7);
      const invoice = await invoiceById(business.orgId, business.jane.invoiceId);
      t.check(invoice?.status, equals("partially_paid")).label("status");
      t.check(invoice?.amountPaidCents, equals(15000)).label("paid");
      t.check(invoice ? invoice.totalCents - invoice.amountPaidCents : null, equals(9000)).label("balance");
      t.check((await paymentsOn(business.orgId, business.jane.invoiceId)).map((p) => p.method), equals(["cash"])).label("method");
      const bo = await invoiceById(business.orgId, business.bo.invoiceId);
      t.check(bo?.amountPaidCents, equals(0)).label("nobody else's invoice changed");
    },
  }),

  defineEval<typeof config>({
    description: "\"Who owes me money?\" lists Bo ($420, overdue) and Jane ($240), and not the customer who paid.",
    async test(t) {
      await t.context.seed.invoices();
      const turn = await t.send("who owes me money?");
      t.succeeded();
      turn.calledTool("list_invoices");
      t.check(turn.message, includes("Bo")).label("names Bo");
      t.check(turn.message, includes("Jane")).label("names Jane");
      t.check(turn.message, includes("420")).label("Bo's balance");
      t.check(turn.message, includes("240")).label("Jane's balance");
      t.check(/\bCy\b/.test(turn.message ?? ""), equals(false)).label("not the customer who paid");
      t.judge(
        "The reply says two customers owe $660 in all: Bo Example $420, which is overdue, and Jane Sample $240. Plain text, no markdown, and nothing made up.",
      ).gate(0.7);
    },
  }),
];
