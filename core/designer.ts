import type { SessionAuthContext } from "eve/context";
import { CUSTOMER_PAGE_KINDS, type CustomerPageKind } from "./customer-page-template";
import { isPrivileged, resolveCaller } from "./members";

/**
 * What the page designer (agents/designer/) knows on each turn: who it's talking with, and which
 * customer page this conversation is for. Empty for anyone who isn't an active owner or admin.
 */
export async function designerTurnContext(auth: SessionAuthContext | null | undefined): Promise<string[]> {
  const caller = await resolveCaller(auth ?? null);
  if (!caller || !isPrivileged(caller.role)) return [];
  const page = auth?.attributes.page;
  const usual = caller.language === "es" ? "Spanish" : "English";
  return [
    `Member: ${caller.name} (${caller.role}). Reply in the language of their message; when unclear, ${usual}.`,
    ...(CUSTOMER_PAGE_KINDS.includes(page as CustomerPageKind) ? [`This conversation is for the business's ${page} page; its preview is beside it.`] : []),
  ];
}
