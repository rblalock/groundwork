import { z } from "zod";
import { requireMember, route } from "@/lib/guards";
import { recentThreads, startThreadFromApp } from "@/lib/pages/jobs";

// Threads (jobs, in the code): the member's open ones for the sidebar, and starting one from the web.

/** The member's open threads (not email ones), most recent first, and how many email threads have news. */
export const GET = route(async (request: Request) => {
  const caller = await requireMember(request.headers);
  return Response.json(await recentThreads(caller));
});

const body = z
  .object({
    topic: z.enum(["new", "quote", "customer", "pricebook", "billing"]).optional(),
    quoteId: z.string().min(1).max(64).optional(),
    invoiceId: z.string().min(1).max(64).optional(),
    customerId: z.string().min(1).max(64).optional(),
    reuse: z.boolean().optional(),
  })
  .strict();

/** Starts a thread, on its own or about a quote, customer, or invoice, and returns it ready to write in. */
export const POST = route(async (request: Request) => {
  const caller = await requireMember(request.headers);
  const input = body.parse(await request.json().catch(() => null));
  return Response.json({ thread: await startThreadFromApp(caller, input) }, { status: 201 });
});
