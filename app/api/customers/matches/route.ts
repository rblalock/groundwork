import { requireMember, route } from "@/lib/guards";
import { sameCustomersFor } from "@/lib/pages/customers";

/** Customers already saved with the name, phone, or email being typed in (`?name=`, `?phone=`, `?email=`). */
export const GET = route(async (request: Request) => {
  const caller = await requireMember(request.headers);
  const url = new URL(request.url);
  const field = (key: string) => (url.searchParams.get(key) ?? "").slice(0, 200);
  return Response.json({ customers: await sameCustomersFor(caller, { name: field("name"), phone: field("phone"), email: field("email") }) });
});
