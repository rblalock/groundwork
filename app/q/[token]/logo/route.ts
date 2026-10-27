import { quoteLinkLogo } from "@/lib/pages/branding";

/** The logo of the business behind a quote's link, for its pages. Anyone with the link sees it, as on the PDF. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  try {
    return await quoteLinkLogo((await params).token);
  } catch (error) {
    console.error("quote link: logo failed", error);
    return new Response(null, { status: 404 });
  }
}
