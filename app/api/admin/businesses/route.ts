import { z } from "zod";
import { createPhotonAdmin } from "@/core/photon-admin";
import { provision, provisionSchema } from "@/core/provision";
import { listBusinessesForAdmin } from "@/lib/admin";
import { requireSuperAdmin, route } from "@/lib/guards";

/** Every business, for super admins. */
export const GET = route(async (request: Request) => {
  await requireSuperAdmin(request.headers);
  return Response.json({ businesses: await listBusinessesForAdmin() });
});

const form = z.object({
  name: z.string(),
  timeZone: z.string(),
  ownerName: z.string(),
  ownerPhone: z.string(),
  slug: z.string().optional(),
});

/**
 * "New business": what `npm run provision` does after a sales call, through the same code, but only
 * ever creating a business. Answers with the number the owner should text.
 */
export const POST = route(async (request: Request) => {
  await requireSuperAdmin(request.headers);
  const input = form.parse(await request.json().catch(() => null));
  const parsed = provisionSchema.safeParse({
    orgSlug: input.slug?.trim() || undefined,
    profile: { name: input.name, timeZone: input.timeZone },
    owner: { name: input.ownerName, phone: input.ownerPhone },
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.join(".");
    return Response.json({ error: `${field ? `${field}: ` : ""}${issue.message}`, code: "INVALID_INPUT" }, { status: 400 });
  }
  try {
    const { org, rows } = await provision(parsed.data, { admin: createPhotonAdmin(), createOnly: true });
    const owner = rows[0];
    return Response.json(
      { business: { id: org.id, name: org.name, slug: org.slug }, owner: { name: owner.name, phone: owner.phone }, line: owner.assignedLine },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const known = /already|SLUG_TAKEN/.test(message);
    if (!known) console.error("admin: provisioning failed", error);
    return Response.json(
      { error: known ? message.charAt(0).toUpperCase() + message.slice(1) + "." : "Couldn't set up the business. Try again.", code: known ? "CONFLICT" : "FAILED" },
      { status: known ? 409 : 502 },
    );
  }
});
