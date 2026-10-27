import { quoteLinkPricedPhoto } from "@/lib/quote-page";

/** The quote's priced photo, for its link's page. Anyone with the link sees it; nothing of another quote's. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string; id: string }> }): Promise<Response> {
  try {
    const { token, id } = await params;
    const bytes = await quoteLinkPricedPhoto(token, id);
    if (!bytes) return new Response(null, { status: 404 });
    return new Response(Buffer.from(bytes), { headers: { "content-type": "image/png", "cache-control": "private, max-age=300" } });
  } catch (error) {
    console.error("quote link: priced photo failed", error);
    return new Response(null, { status: 404 });
  }
}
