import { defineTool } from "eve/tools";
import { z } from "zod";
import { listQuotes } from "../../../../core/quotes";
import { quoteStatusSchema } from "../../../../core/tool-schemas";
import { plain, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "List quotes, newest first, to answer status questions (\"what's open?\", \"where are we on the Oak St job?\", \"what did we quote Maria?\"). query matches the title, customer name, or address. Open work is status draft and needs_owner; approved and sent are waiting on the customer.",
  inputSchema: z.object({
    status: z.array(quoteStatusSchema).optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  async execute({ status, query, limit }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const quotes = await listQuotes(caller.orgId, { status, query, limit });
      return plain({
        quotes: quotes.map((q) => ({
          quoteId: q.quoteId,
          title: q.title,
          status: q.status,
          state: q.state,
          revisionNumber: q.revisionNumber,
          totalCents: q.totalCents,
          customerId: q.customerId,
          customerName: q.customerName,
          propertyAddress: q.propertyAddress,
          createdBy: q.createdBy,
          updatedAt: q.updatedAt,
        })),
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
