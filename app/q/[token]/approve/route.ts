import { approveFromLink } from "@/core/quote-link";

/**
 * The quote link's Approve button (a form post, so a link preview can't approve anything). Back to the
 * page either way: approved, changed since it was opened, or missing the customer's name.
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const back = (query = "") => Response.redirect(new URL(`/q/${token}${query}`, request.url), 303);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back();
  }
  try {
    const result = await approveFromLink(token, { name: String(form.get("name") ?? ""), revisionId: String(form.get("revisionId") ?? "") });
    return back(result.kind === "changed" ? "?changed=1" : "");
  } catch (error) {
    if (error instanceof Error && error.message === "NAME_REQUIRED") return back("?name=1");
    console.error("quote link: approve failed", error);
    return back();
  }
}
