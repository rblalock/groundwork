import { defineTool } from "eve/tools";
import { z } from "zod";
import { searchRecords } from "../../../../core/records";
import { plain, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Search everything the business has on record by words: notes and documents (procedures, site notes like gate codes, kept files), customers, quotes, and invoices (owners and admins only). Use it for \"what's the gate code at 12 Oak St?\", \"do we have the warranty for the Lee job?\", \"what did we do at Pine Ave?\". Pass the key words (\"gate code 12 Oak\"), not the whole question. Every word must match; matched any means nothing matched them all and these match some, so check they answer the question. Results are short: use read_note, get_quote, or get_invoice for the full record. Crew get only what's on their own work.",
  inputSchema: z.object({
    query: z.string().min(1),
    kinds: z.array(z.enum(["note", "customer", "quote", "invoice"])).optional().describe("Only these kinds. Omit for all."),
    limit: z.number().int().min(1).max(20).default(8),
  }),
  async execute({ query, kinds, limit }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const { results, matched } = await searchRecords(caller, query, { kinds, limit });
      return plain({
        matched,
        results: results.map((r) => ({
          kind: r.kind,
          id: r.id,
          title: r.title,
          ...(r.snippet ? { snippet: r.snippet } : {}),
          ...(r.customerName ? { customerId: r.customerId, customerName: r.customerName } : {}),
          ...(r.address ? { address: r.address } : {}),
          ...(r.status ? { status: r.status } : {}),
          ...(r.totalCents !== null ? { totalCents: r.totalCents } : {}),
          updatedAt: r.updatedAt,
        })),
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
