import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PausedScreen } from "@/components/sign-in";
import { isLanguage } from "@/core/language";
import { languageFromAcceptLanguage } from "@/lib/copy";
import { getViewer, resolveAppCaller } from "@/lib/guards";

/** Signed in to a business a super admin has paused. Anyone else goes back to the app. */
export default async function PausedPage() {
  const requestHeaders = await headers();
  const viewer = await getViewer(requestHeaders);
  if (!viewer) redirect("/sign-in");
  const caller = await resolveAppCaller(viewer);
  if (viewer.superAdmin || !caller?.suspended) redirect("/");
  const language = isLanguage(caller.language) ? caller.language : languageFromAcceptLanguage(requestHeaders.get("accept-language"));
  return <PausedScreen language={language} />;
}
