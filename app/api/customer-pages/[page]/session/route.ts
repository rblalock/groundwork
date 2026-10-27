import { z } from "zod";
import { requirePrivileged, route } from "@/lib/guards";
import { designSessionFor, pageKindSchema } from "@/lib/pages/customer-pages";

const body = z.object({ ended: z.string().min(1).max(200) });

/**
 * A fresh conversation with the designer, for an owner or admin whose send was refused because eve no
 * longer runs their conversation (`ended`). A session that isn't theirs, or is still theirs, is kept.
 */
export const POST = route(async (request: Request, { params }: { params: Promise<{ page: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const page = pageKindSchema.parse((await params).page);
  const { ended } = body.parse(await request.json());
  return Response.json({ sessionId: await designSessionFor(caller, page, request.headers.get("cookie") ?? "", ended) });
});
