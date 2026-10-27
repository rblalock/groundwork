import { publishedTemplate } from "@/core/customer-pages";
import { customerPageResponse, invoiceSlots, renderCustomerPage } from "@/lib/customer-pages";
import { payPage } from "@/lib/stripe";

export const dynamic = "force-dynamic";

/**
 * An invoice's pay link in the business's own design (lib/customer-pages.ts), when it has published one.
 * Anything else goes back to the standard page.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const standard = () => Response.redirect(new URL(`/pay/${encodeURIComponent(token)}?standard=1`, request.url), 303);
  const page = await payPage(token);
  if (page.kind === "not_found") return standard();
  try {
    const template = await publishedTemplate(page.orgId, "invoice");
    if (!template) return standard();
    const logoSrc = page.business.logoVersion ? `/pay/${encodeURIComponent(token)}/logo?v=${page.business.logoVersion}` : null;
    return customerPageResponse(renderCustomerPage(template, "invoice", invoiceSlots(page, { token, logoSrc })));
  } catch (error) {
    console.error("customer page: an invoice's design didn't render", { orgId: page.orgId, error });
    return standard();
  }
}
