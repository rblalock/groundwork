// The record open beside a web thread (a quote, invoice, or customer page), which a message in the
// thread panel carries to the assistant unless the member leaves it out. The browser names it in a
// header; the eve channel's auth checks the member may see it and resolves its name
// (lib/pages/on-screen.ts), and only then does the turn's context mention it.

export type OnScreenKind = "quote" | "invoice" | "customer";
export type OnScreenRecord = { kind: OnScreenKind; id: string; label: string };

export const ON_SCREEN_HEADER = "x-gw-on-screen";

/** `quote:quo_…`, `invoice:inv_…`, or `customer:cus_…`, or null for anything else. */
export function parseOnScreen(value: string | null | undefined): { kind: OnScreenKind; id: string } | null {
  const match = value?.match(/^(quote|invoice|customer):([A-Za-z0-9_-]{1,64})$/);
  return match ? { kind: match[1] as OnScreenKind, id: match[2] } : null;
}

export const onScreenHeader = (record: Pick<OnScreenRecord, "kind" | "id">) => `${record.kind}:${record.id}`;
