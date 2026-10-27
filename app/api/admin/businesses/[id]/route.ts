import { z } from "zod";
import { renameBusiness } from "@/core/business-admin";
import { businessFootprint, deleteBusiness } from "@/core/business-removal";
import { HttpError, requireSuperAdmin, route } from "@/lib/guards";

const noSuchBusiness = () => new HttpError(404, "NO_SUCH_BUSINESS", "That business doesn't exist.");

/** What deleting the business would remove, for super admins to read first. */
export const GET = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  await requireSuperAdmin(request.headers);
  const { id } = await params;
  const footprint = await businessFootprint(id);
  if (!footprint) throw noSuchBusiness();
  const { files, signIns, ...rest } = footprint;
  return Response.json({ business: { ...rest, files: files.length, signIns: signIns.length } });
});

const body = z.object({ confirmName: z.string() });

/**
 * Deletes the business and everything it has, here and at Photon, AgentMail, and Blob, for super admins.
 * `confirmName` must be its name exactly, so a stray request can't delete the wrong one.
 */
export const DELETE = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const viewer = await requireSuperAdmin(request.headers);
  const { id } = await params;
  const { confirmName } = body.parse(await request.json().catch(() => null));
  const footprint = await businessFootprint(id);
  if (!footprint) throw noSuchBusiness();
  if (confirmName.trim() !== footprint.name) throw new HttpError(400, "NAME_MISMATCH", "Type the business's name exactly to delete it.");
  try {
    await deleteBusiness(id);
  } catch (error) {
    console.error("admin: deleting a business failed", { orgId: id, by: viewer.userId }, error);
    if (error instanceof Error && error.message === "NO_SUCH_BUSINESS") throw noSuchBusiness();
    throw new HttpError(502, "DELETE_FAILED", "Couldn't finish deleting it. It's paused; try again.");
  }
  console.info("admin: business deleted", { orgId: id, by: viewer.userId });
  return Response.json({ deleted: { id, name: footprint.name } });
});

const rename = z.object({ name: z.string(), slug: z.string() });

/** Renames the business (its name and slug), for super admins. */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const viewer = await requireSuperAdmin(request.headers);
  const { id } = await params;
  const input = rename.parse(await request.json().catch(() => null));
  try {
    const business = await renameBusiness(id, input);
    console.info("admin: business renamed", { orgId: id, by: viewer.userId });
    return Response.json({ business: { id, ...business } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "NO_SUCH_BUSINESS") throw noSuchBusiness();
    if (code === "INVALID_NAME") throw new HttpError(400, code, "Give it a name, up to 120 characters.");
    if (code === "INVALID_SLUG") throw new HttpError(400, code, "Use lowercase letters, digits, and single dashes, like example-services.");
    if (code === "SLUG_TAKEN") throw new HttpError(409, code, "Another business has that slug.");
    throw error;
  }
});
