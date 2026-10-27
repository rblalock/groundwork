import { requireMember, route } from "@/lib/guards";
import { memberEmailSchema, setOwnEmailFromApp } from "@/lib/pages/team";

/** The signed-in member sets the address they forward emails from; blank removes it. */
export const PUT = route(async (request: Request) => {
  const caller = await requireMember(request.headers);
  const { email } = memberEmailSchema.parse(await request.json().catch(() => null));
  return Response.json({ member: await setOwnEmailFromApp(caller, email) });
});
