import { payLogo } from "@/lib/pages/branding";

/** The logo of the business behind a pay link, for the pay page. Anyone with the link sees it, as on the PDF. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  try {
    return await payLogo((await params).token);
  } catch (error) {
    console.error("pay: logo failed", error);
    return new Response(null, { status: 404 });
  }
}
