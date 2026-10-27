import { z } from "zod";
import { requireMember, route } from "@/lib/guards";
import { JOB_STATUSES_SET_FROM_APP, setJobStatusFromApp, threadView } from "@/lib/pages/jobs";

/** One thread, for the chat panel: its session, title, and what it's about. */
export const GET = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  return Response.json({ thread: await threadView(caller, (await params).id) });
});

const body = z.object({ status: z.enum(JOB_STATUSES_SET_FROM_APP) });

/** A member marks their own job done or archived, or reopens it. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  const { status } = body.parse(await request.json().catch(() => null));
  const job = await setJobStatusFromApp(caller, (await params).id, status);
  return Response.json({ job: { id: job.id, status: job.status } });
});
