import { publishedTemplate } from "@/core/customer-pages";
import { customerPageResponse, quoteSlots, renderCustomerPage } from "@/lib/customer-pages";
import { quoteLinkPage } from "@/lib/quote-page";

export const dynamic = "force-dynamic";

/**
 * A quote's link in the business's own design (lib/customer-pages.ts), when it has published one. Anything
 * else (no design, a quote that isn't open to the customer, a design that won't fill) goes back to the
 * standard page.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const url = new URL(request.url);
  const standard = () => {
    const back = new URL(`/q/${encodeURIComponent(token)}`, request.url);
    url.searchParams.forEach((value, key) => back.searchParams.set(key, value));
    back.searchParams.set("standard", "1");
    return Response.redirect(back, 303);
  };
  const page = await quoteLinkPage(token);
  if (!("quote" in page)) return standard();
  try {
    const template = await publishedTemplate(page.orgId, "quote");
    if (!template) return standard();
    const logoSrc = page.business.logoVersion ? `/q/${encodeURIComponent(token)}/logo?v=${page.business.logoVersion}` : null;
    const values = quoteSlots(page, { token, logoSrc, flags: { changed: url.searchParams.has("changed"), nameMissing: url.searchParams.has("name") } });
    return customerPageResponse(renderCustomerPage(template, "quote", values));
  } catch (error) {
    console.error("customer page: a quote's design didn't render", { orgId: page.orgId, error });
    return standard();
  }
}
