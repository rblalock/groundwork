import { getCustomer } from "../../core/customers";
import { getInvoice } from "../../core/invoices";
import { isPrivileged } from "../../core/members";
import { loadSummary } from "../../core/quotes";
import type { AppCaller } from "../guards";
import { parseOnScreen, type OnScreenRecord } from "../on-screen";
import { assertVisible } from "./quotes";

/**
 * The record a web message says is on screen, named, when the member may see it: a quote they can
 * open, an invoice for an owner or admin, or a customer of the business. Null for anything else, and
 * never throws: a message goes through without it.
 */
export async function onScreenRecord(caller: AppCaller, header: string | null): Promise<OnScreenRecord | null> {
  const named = parseOnScreen(header);
  if (!named) return null;
  try {
    if (named.kind === "quote") {
      await assertVisible(caller, named.id);
      const quote = await loadSummary(caller.orgId, named.id);
      return { ...named, label: quote.title };
    }
    if (named.kind === "invoice") {
      if (!isPrivileged(caller.role)) return null;
      const invoice = await getInvoice(caller.orgId, named.id);
      return invoice ? { ...named, label: `${invoice.label} · ${invoice.title}` } : null;
    }
    const customer = await getCustomer(caller.orgId, named.id);
    return customer ? { ...named, label: customer.name } : null;
  } catch {
    return null;
  }
}
