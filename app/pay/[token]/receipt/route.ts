import { fileResponse } from "@/lib/pages/quotes";
import { payReceipt } from "@/lib/stripe";

/**
 * The receipt behind a pay link, as a PDF made fresh each time: anyone with the link may have it, as
 * with the pay page itself. Not for a draft or an invoice nothing's been paid on, and never cached.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  try {
    const receipt = await payReceipt((await params).token);
    if (!receipt) return Response.json({ error: "That isn't here.", code: "NOT_FOUND" }, { status: 404 });
    const response = fileResponse({ bytes: receipt.bytes, contentType: "application/pdf", filename: receipt.filename });
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("x-content-type-options", "nosniff");
    return response;
  } catch (error) {
    console.error("pay: receipt failed", error);
    return new Response(null, { status: 404 });
  }
}
