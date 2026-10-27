import { defineTool } from "eve/tools";
import { z } from "zod";
import { balancesByCustomer, invoiceTotals, listInvoices, owedText, readyToInvoice } from "../../../../core/invoices";
import { requireMoneyCaller } from "../../../../core/invoice-tools";
import { plain, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Invoices and who owes what, for \"who owes me money?\", \"what's overdue?\", \"did Jane pay?\", \"what's ready to invoice?\". Owners and admins only. status: draft, open (sent and not fully paid), overdue (past due in the business's time zone), paid, or void; query matches the customer, title, address, or number. owedText is the reply for who owes money (with status overdue, only what's past due); send it as it is. totals are what's outstanding and overdue. readyToInvoice is finished work with no invoice yet, to offer invoicing.",
  inputSchema: z.object({
    status: z.enum(["draft", "open", "overdue", "paid", "void"]).optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(15),
  }),
  async execute({ status, query, limit }, ctx) {
    try {
      const caller = await requireMoneyCaller(ctx);
      const [list, totals, balances, ready] = await Promise.all([
        listInvoices(caller.orgId, { status, query, limit }),
        invoiceTotals(caller.orgId),
        balancesByCustomer(caller.orgId),
        readyToInvoice(caller.orgId),
      ]);
      const owing =
        status === "overdue"
          ? balances
              .map((b) => ({ ...b, invoices: b.invoices.filter((i) => i.overdue) }))
              .filter((b) => b.invoices.length > 0)
              .map((b) => ({ ...b, balanceCents: b.overdueCents }))
          : balances;
      return plain({
        invoices: list.map((i) => ({
          invoiceId: i.id,
          number: i.label,
          title: i.title,
          customerName: i.customerName,
          status: i.status,
          totalCents: i.totalCents,
          balanceCents: i.balanceCents,
          dueDate: i.dueDate,
          overdue: i.overdue,
          daysOverdue: i.daysOverdue,
        })),
        totals: { outstandingCents: totals.outstandingCents, overdueCents: totals.overdueCents, overdueCount: totals.counts.overdue, drafts: totals.counts.draft },
        owedText: owedText(owing, caller.language),
        readyToInvoice: ready.slice(0, 10).map((r) => ({ serviceJobId: r.jobId, title: r.title, customerName: r.customerName, quoteId: r.quoteId, quoteTotalCents: r.quoteTotalCents })),
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
