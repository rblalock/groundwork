import { requirePrivileged, route } from "@/lib/guards";
import { brandingPreview, previewInputSchema } from "@/lib/pages/branding";

/** A sample quote or invoice PDF with the logo and the form's PDF settings, saved or not. Made-up data only. */
export const POST = route(async (request: Request) => {
  const caller = await requirePrivileged(request.headers);
  const input = previewInputSchema.parse(await request.json().catch(() => null));
  const bytes = await brandingPreview(caller, { kind: input.kind, patch: input.branding });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="sample-${input.kind}.pdf"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
