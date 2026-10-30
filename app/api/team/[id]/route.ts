import { requirePrivileged, route } from "@/lib/guards";
import { memberEmailSchema, memberUpdateSchema, removeMemberFromApp, setMemberEmailFromApp, updateMemberFromApp } from "@/lib/pages/team";

/** An owner or admin removes someone. The last owner stays. */
export const DELETE = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  await removeMemberFromApp(caller, (await params).id);
  return Response.json({ removed: true });
});

/**
 * An owner or admin sets the address a member forwards emails from (`{ email }`, blank removes it), or
 * changes their name, language, role, or equipment (`{ name?, language?, role?, equipment? }`; roles only by the owner).
 */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const body: unknown = await request.json().catch(() => null);
  const id = (await params).id;
  if (body && typeof body === "object" && "email" in body) {
    const { email } = memberEmailSchema.parse(body);
    return Response.json({ member: await setMemberEmailFromApp(caller, id, email) });
  }
  return Response.json({ member: await updateMemberFromApp(caller, id, memberUpdateSchema.parse(body)) });
});
