import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { NoBusinessScreen } from "@/components/sign-in";
import { languageFromAcceptLanguage } from "@/lib/copy";
import { getViewer, resolveAppCaller } from "@/lib/guards";

/** Signed in, but on no team: a removed member, or an account whose business is gone. */
export default async function NoBusinessPage() {
  const requestHeaders = await headers();
  const viewer = await getViewer(requestHeaders);
  if (!viewer) redirect("/sign-in");
  if (viewer.superAdmin || (await resolveAppCaller(viewer))) redirect("/");
  return <NoBusinessScreen language={languageFromAcceptLanguage(requestHeaders.get("accept-language"))} />;
}
