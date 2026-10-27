import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignInScreen } from "@/components/sign-in";
import { languageFromAcceptLanguage } from "@/lib/copy";
import { getViewer } from "@/lib/guards";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ lang?: string; mode?: string }> }) {
  const requestHeaders = await headers();
  if (await getViewer(requestHeaders)) redirect("/");
  const { lang, mode } = await searchParams;
  const language = lang === "es" || lang === "en" ? lang : languageFromAcceptLanguage(requestHeaders.get("accept-language"));
  return <SignInScreen initialMode={mode === "admin" ? "admin" : "phone"} language={language} />;
}
