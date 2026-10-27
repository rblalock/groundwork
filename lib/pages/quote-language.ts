import { z } from "zod";
import type { Language } from "../../core/language";
import { isPrivileged } from "../../core/members";
import { getQuote, quoteCreatorId, reviseQuote, type QuoteDetail } from "../../core/quotes";
import { translateTexts, TranslationLimitedError, type TranslationResult } from "../../core/translation";
import { copyFor } from "../copy";
import { HttpError, memberCaller, type AppCaller } from "../guards";
import { pageCopyFor } from "../page-copy";
import { assertVisible } from "./quotes";
import { notFound, refuse } from "./access";

// A quote's language on its page: a translated view of what it says, for whoever may see the quote, and
// switching the language it's written in (a new revision, with its PDF in that language).

/** What the quote says that a translation can change, by id: its title, line names, rule labels, and notes. */
/** A unit label's id in the translated view: one per label, however many lines use it ("window"). */
export function unitTextId(label: string): string {
  return `unit:${label.trim().toLowerCase()}`;
}

export function quoteTexts(quote: Pick<QuoteDetail, "title" | "lines" | "ruleLines" | "customerNotes">): Array<{ id: string; text: string }> {
  const texts = [{ id: "title", text: quote.title }];
  quote.lines.forEach((line, index) => texts.push({ id: `line:${index}`, text: line.name }));
  const units = new Map<string, string>();
  for (const line of quote.lines) if (line.unitLabel?.trim()) units.set(unitTextId(line.unitLabel), line.unitLabel.trim());
  for (const [id, text] of units) texts.push({ id, text });
  for (const rule of quote.ruleLines) texts.push({ id: `rule:${rule.ruleId}`, text: rule.label });
  if (quote.customerNotes?.trim()) texts.push({ id: "notes", text: quote.customerNotes });
  return texts.filter((item) => item.text.trim() !== "");
}

const translateSchema = z.object({ target: z.enum(["en", "es"]) }).strict();

/**
 * The quote's texts in `target`, read on the server from the quote the caller may see (never text the
 * browser sent: the translation cache is the business's). A 404 for a quote they can't see, or for a
 * super admin looking in; `TranslationLimitedError` over the business's hourly usage limit.
 */
export async function translateQuoteForApp(
  caller: AppCaller,
  quoteId: string,
  body: unknown,
): Promise<{ target: Language; translations: Array<TranslationResult & { id: string }> }> {
  if (!caller.memberId) throw notFound();
  await assertVisible(caller, quoteId);
  const quote = await getQuote(caller.orgId, quoteId);
  if (!quote) throw notFound();
  const { target } = translateSchema.parse(body);
  const texts = quoteTexts(quote);
  if (texts.length === 0) return { target, translations: [] };
  try {
    const results = await translateTexts({ orgId: caller.orgId, memberId: caller.memberId, conversationId: null, target, texts: texts.map((t) => t.text) });
    return { target, translations: texts.map((t, i) => ({ id: t.id, ...results[i] })) };
  } catch (error) {
    if (error instanceof Error && error.message === "TRANSLATION_UNAVAILABLE") {
      throw new HttpError(503, "TRANSLATION_UNAVAILABLE", copyFor(caller.language).translation.unavailable);
    }
    throw error;
  }
}

/**
 * Whether the caller may change the quote (its lines, photos, language): an owner or admin while it's
 * still open to revising; crew the same on a quote they started, and on anyone's while it's a draft.
 */
export async function mayChangeQuoteLanguage(caller: AppCaller, quote: Pick<QuoteDetail, "quoteId" | "status">): Promise<boolean> {
  if (!caller.memberId || ["won", "lost", "void"].includes(quote.status)) return false;
  if (isPrivileged(caller.role) || DRAFTS.includes(quote.status)) return true;
  return (await quoteCreatorId(caller.orgId, quote.quoteId)) === caller.memberId;
}

const DRAFTS = ["draft", "needs_owner"];

const languageSchema = z.object({ language: z.enum(["en", "es"]), revision: z.number().int().positive() }).strict();

/**
 * Writes the quote in another language: a new revision, as revising it by text would make (an approved
 * quote goes back to draft), with its PDF re-rendered in that language. Nothing is texted: the member
 * is on the page. Refused when the quote changed since the page loaded.
 */
export async function setQuoteLanguageFromApp(caller: AppCaller, quoteId: string, body: unknown): Promise<{ language: Language; revision: number }> {
  const actor = memberCaller(caller);
  await assertVisible(caller, quoteId);
  const { language, revision } = languageSchema.parse(body);
  const quote = await getQuote(caller.orgId, quoteId);
  if (!quote) throw notFound();
  if (!(await mayChangeQuoteLanguage(caller, quote))) throw new HttpError(403, "NOT_ALLOWED", pageCopyFor(caller.language).quotes.errors.languageNotAllowed);
  if (quote.revisionNumber !== revision) throw new HttpError(409, "REVISION_CHANGED", pageCopyFor(caller.language).quotes.errors.quoteChanged);
  if (quote.customerLanguage === language) return { language, revision };
  try {
    const revised = await reviseQuote({ quoteId, customerLanguage: language }, actor, { post: async () => ({ posted: true }) });
    return { language, revision: revised.revisionNumber };
  } catch (error) {
    refuse(error, { QUOTE_CLOSED: [409, pageCopyFor(caller.language).quotes.errors.quoteClosed], QUOTE_NOT_FOUND: [404, "That isn't here."] });
  }
}

export { TranslationLimitedError };
