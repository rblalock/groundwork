// A business's own customer pages, as customers see them: its published template
// (core/customer-page-template.ts) filled with the quote's or invoice's facts as they stand, and our
// Approve and Pay forms in its action slot. The standard pages (`app/q/[token]`, `app/pay/[token]`)
// send a customer here when the business has published a design; previews in Settings use the same
// filling with a sample or one of the business's own documents.
import { BLOCK_BASE_CSS, CUSTOMER_PAGE_CSP, escapeHtml, renderTemplate, type CustomerPageKind, type SlotValues } from "../core/customer-page-template";
import type { Language } from "../core/language";
import { formatDateOnlyShort, money, quantity } from "./format";
import { pageCopyFor } from "./page-copy";
import type { QuoteLinkPage } from "./quote-page";
import type { PayPage } from "./stripe";

export type QuoteShown = Extract<QuoteLinkPage, { quote: unknown }>;
export type PayShown = Exclude<PayPage, { kind: "not_found" }>;

/**
 * Where the page's links and forms go. `logoSrc` is the logo's URL (a data: URL in a preview, which
 * can't load the business's own). In a preview, forms and links go nowhere.
 */
export type PageTarget = {
  token: string;
  logoSrc: string | null;
  preview?: boolean;
  /** The quote link's notices after a post: changed since it was opened, or the name left blank. */
  flags?: { changed?: boolean; nameMissing?: boolean };
};

const e = escapeHtml;
const rateText = (bp: number, language: Language) => (bp / 100).toLocaleString(language === "es" ? "es-US" : "en-US", { maximumFractionDigits: 3 });
const notice = (tone: "ok" | "closed" | "alert", text: string) => `<p class="gw-notice gw-${tone}">${e(text)}</p>`;
const contactLine = (business: { phone: string | null; email: string | null }) => {
  const parts = [business.phone, business.email].filter((v): v is string => Boolean(v));
  return parts.length ? `<p class="gw-contact">${parts.map(e).join(" · ")}</p>` : "";
};
const logo = (target: PageTarget, name: string) => (target.logoSrc ? `<img class="gw-logo" alt="${e(name)}" src="${e(target.logoSrc)}">` : "");
const action = (path: string, target: PageTarget) => (target.preview ? "#" : path);

function totalsList(rows: Array<{ label: string; value: string; total?: boolean }>): string {
  return `<dl class="gw-totals">${rows
    .map((row) => `<div${row.total ? ' class="gw-total"' : ""}><dt>${e(row.label)}</dt><dd>${e(row.value)}</dd></div>`)
    .join("")}</dl>`;
}

function receiptBlock(
  language: Language,
  payments: QuoteShown["payments"],
  totals: Array<{ label: string; value: string; total?: boolean }>,
  extra: string,
): string {
  if (payments.length === 0) return "";
  const p = pageCopyFor(language).pay;
  const items = payments
    .map(
      (payment) =>
        `<li><span>${e(payment.card ?? p.methods[payment.method])} · ${e(formatDateOnlyShort(payment.receivedDate, language))}</span><span class="gw-num">${e(money(payment.amountCents, language))}</span></li>`,
    )
    .join("");
  return `<section class="gw-receipt"><h2 class="gw-heading">${e(p.receipt)}</h2><ul class="gw-payments">${items}</ul>${totalsList(totals)}${extra}</section>`;
}

/** A quote link's slots, from what the customer may see of it. */
export function quoteSlots(page: QuoteShown, target: PageTarget): SlotValues {
  const { quote, language, business, deposit } = page;
  const q = pageCopyFor(language).quoteLink;
  const p = pageCopyFor(language).pay;

  const lines = [
    ...quote.lines.map((line) => {
      const detail = `${quantity(line.quantity)}${line.unitLabel ? ` ${line.unitLabel}` : ""}${line.unitCents !== null ? ` × ${money(line.unitCents, language)}` : ""}`;
      return `<tr><td><span class="gw-line-name">${e(line.name)}</span><span class="gw-line-detail">${e(detail)}</span></td><td class="gw-num">${e(line.totalCents === null ? "—" : money(line.totalCents, language))}</td></tr>`;
    }),
    ...quote.ruleLines.map((rule) => `<tr class="gw-line-rule"><td><span class="gw-line-name">${e(rule.label)}</span></td><td class="gw-num">${e(money(rule.cents, language))}</td></tr>`),
  ].join("");
  const rows: Array<{ label: string; value: string; total?: boolean }> = [{ label: q.subtotal, value: money(quote.subtotalCents, language) }];
  if (quote.minimumAppliedCents !== 0) rows.push({ label: q.minimum, value: money(quote.minimumAppliedCents, language) });
  if (quote.adjustmentCents !== 0) rows.push({ label: quote.override ? q.override : q.discount, value: money(quote.adjustmentCents, language) });
  if (quote.taxRateBp !== null) rows.push({ label: q.tax(rateText(quote.taxRateBp, language)), value: money(quote.taxCents, language) });
  rows.push({ label: q.total, value: money(quote.totalCents, language), total: true });
  const items = `<div class="gw-items"><table class="gw-lines"><thead><tr><th>${e(q.service)}</th><th class="gw-num">${e(q.amount)}</th></tr></thead><tbody>${lines}</tbody></table>${totalsList(rows)}</div>`;

  const parts: string[] = [];
  if (page.kind === "approved") {
    parts.push(
      notice("ok", `${page.approval ? q.approvedBy(page.approval.name, formatDateOnlyShort(page.approval.at, language)) : q.approvedPlain} ${q.thanks(business.name)}`),
    );
    if (deposit && deposit.dueCents > 0) {
      parts.push(`<p class="gw-label">${e(q.depositTitle)}</p><p class="gw-amount">${e(money(deposit.dueCents, language))}</p>`);
      parts.push(
        deposit.payable
          ? `<form class="gw-form" action="${e(action(`/q/${target.token}/deposit`, target))}" method="post"><button class="gw-button" type="submit">${e(q.payDeposit(money(deposit.dueCents, language)))}</button></form><p class="gw-secure">${e(p.secure(business.name))}</p>`
          : notice("closed", q.depositUnavailable(business.name)),
      );
    } else if (deposit && deposit.dueCents === 0 && deposit.paidCents > 0) parts.push(notice("ok", q.depositPaid));
  } else if (page.kind === "expired") {
    parts.push(notice("closed", q.expired(business.name)));
  } else {
    const form = [
      `<form class="gw-form" action="${e(action(`/q/${target.token}/approve`, target))}" method="post">`,
      `<h2 class="gw-heading">${e(q.approveTitle)}</h2>`,
      target.flags?.changed ? notice("alert", q.changed) : "",
      `<p class="gw-help">${e(q.approveHelp(business.name))}</p>`,
      deposit ? `<p class="gw-help"><strong>${e(q.depositAhead(money(deposit.cents, language)))}</strong></p>` : "",
      `<input name="revisionId" type="hidden" value="${e(quote.revisionId)}">`,
      `<label class="gw-field"><span>${e(q.name)}</span><input class="gw-input" name="name" type="text" required maxlength="60" autocomplete="name"${target.flags?.nameMissing ? ' aria-invalid="true"' : ""}></label>`,
      target.flags?.nameMissing ? `<p class="gw-error" role="alert">${e(q.nameRequired)}</p>` : "",
      `<button class="gw-button" type="submit">${e(q.approve)}</button>`,
      `</form>`,
    ];
    parts.push(form.join(""));
  }

  const paid = page.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  return {
    language,
    text: {
      "business.name": business.name,
      "business.phone": business.phone ?? "",
      "business.email": business.email ?? "",
      "business.address": business.address?.replace(/\s*\n\s*/g, ", ") ?? "",
      "business.license": business.licenseNumber ?? "",
      "quote.title": quote.title,
      "quote.total": money(quote.totalCents, language),
      "quote.valid_until": page.kind === "approved" ? "" : q.validUntil(formatDateOnlyShort(quote.validUntil, language)),
    },
    blocks: {
      "business.logo": logo(target, business.name),
      "business.contact": contactLine(business),
      "quote.customer":
        quote.customerName || quote.address
          ? `<div class="gw-customer"><p class="gw-label">${e(q.preparedFor)}</p>${quote.customerName ? `<p>${e(quote.customerName)}</p>` : ""}${quote.address ? `<p>${e(quote.address)}</p>` : ""}</div>`
          : "",
      "quote.items": items,
      "quote.notes": quote.notes ? `<div class="gw-notes"><p class="gw-label">${e(q.notes)}</p><p>${e(quote.notes)}</p></div>` : "",
      "quote.pdf":
        quote.pdfUrl && !target.preview ? `<a class="gw-button gw-secondary" href="${e(quote.pdfUrl)}" target="_blank" rel="noreferrer">${e(q.pdf)}</a>` : quote.pdfUrl ? `<a class="gw-button gw-secondary" href="#">${e(q.pdf)}</a>` : "",
      "quote.action": `<div class="gw-action">${parts.join("")}</div>`,
      "quote.receipt": receiptBlock(language, page.payments, [{ label: q.depositTotal, value: money(paid, language), total: true }], `<p class="gw-help">${e(q.depositRest)}</p>`),
    },
  };
}

/** An invoice pay link's slots. */
export function invoiceSlots(page: PayShown, target: PageTarget): SlotValues {
  const { invoice, business } = page;
  const language = invoice.language;
  const p = pageCopyFor(language).pay;
  const open = page.kind === "payable" || page.kind === "unavailable";
  const actionHtml =
    page.kind === "payable"
      ? `<form class="gw-form" action="${e(action(`/pay/${target.token}/checkout`, target))}" method="post"><button class="gw-button" type="submit">${e(p.pay(money(invoice.balanceCents, language)))}</button></form><p class="gw-secure">${e(p.secure(business.name))}</p>`
      : page.kind === "paid"
        ? notice("ok", p.paid)
        : page.kind === "void"
          ? notice("closed", p.void(business.name))
          : notice("closed", p.unavailable(business.name));
  const totals: Array<{ label: string; value: string; total?: boolean }> = [
    { label: p.invoiceTotal, value: money(invoice.totalCents, language) },
    { label: p.paidSoFar, value: money(invoice.paidCents, language) },
    invoice.balanceCents > 0 ? { label: p.balanceLeft, value: money(invoice.balanceCents, language), total: true } : { label: p.paidInFull, value: "", total: true },
  ];
  const download = `<a class="gw-button gw-secondary" href="${e(action(`/pay/${target.token}/receipt`, target))}" download>${e(p.download)}</a>`;
  return {
    language,
    text: {
      "business.name": business.name,
      "business.phone": business.phone ?? "",
      "business.email": business.email ?? "",
      "business.address": business.address?.replace(/\s*\n\s*/g, ", ") ?? "",
      "business.license": business.licenseNumber ?? "",
      "invoice.number": invoice.label,
      "invoice.title": invoice.title,
      "invoice.balance": money(invoice.balanceCents, language),
      "invoice.total": money(invoice.totalCents, language),
      "invoice.paid": money(invoice.paidCents, language),
      "invoice.due": open ? (invoice.dueDate && invoice.dueDate !== invoice.issueDate ? p.due(formatDateOnlyShort(invoice.dueDate, language)) : p.dueOnReceipt) : "",
    },
    blocks: {
      "business.logo": logo(target, business.name),
      "business.contact": contactLine(business),
      "invoice.action": `<div class="gw-action">${actionHtml}</div>`,
      "invoice.receipt": receiptBlock(language, page.payments, totals, download),
    },
  };
}

const HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="icon" href="data:,"><style>${BLOCK_BASE_CSS}</style>`;

/** A template filled for one view. A preview also carries the page's policy, as it's shown without its headers. */
export function renderCustomerPage(template: string, page: CustomerPageKind, values: SlotValues, options: { preview?: boolean } = {}): string {
  const head = options.preview ? `<meta http-equiv="Content-Security-Policy" content="${e(PREVIEW_CSP)}">${HEAD}` : HEAD;
  return renderTemplate(template, page, values, head);
}

/** A preview in Settings: nothing loads but the fonts and what's inline, and nothing posts anywhere. */
const PREVIEW_CSP = CUSTOMER_PAGE_CSP.replace("img-src 'self' data:", "img-src data:").replace("form-action 'self' https://checkout.stripe.com", "form-action 'none'").replace("; frame-ancestors 'none'", "");

/** A filled page as the response a customer gets: no script runs, nothing frames it, nothing caches it. */
export function customerPageResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CUSTOMER_PAGE_CSP,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
