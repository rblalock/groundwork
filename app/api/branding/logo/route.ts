import { requireMember, requirePrivileged, route } from "@/lib/guards";
import { appLogo, removeLogoFromApp, uploadLogoFromApp } from "@/lib/pages/branding";

/** The open business's logo, for the app's shell. Any member sees their own business's. */
export const GET = route(async (request: Request) => appLogo(await requireMember(request.headers)));

/** An owner or admin uploads a new logo: the image's bytes are the body, up to 5 MB. */
export const POST = route(async (request: Request) => {
  const caller = await requirePrivileged(request.headers);
  return Response.json(await uploadLogoFromApp(caller, request));
});

/** An owner or admin takes the logo off. */
export const DELETE = route(async (request: Request) => {
  const caller = await requirePrivileged(request.headers);
  return Response.json(await removeLogoFromApp(caller));
});
