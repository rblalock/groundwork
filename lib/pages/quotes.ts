import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { workPhotos } from "../../schema/schema";
import type { PricedBox, PricedPhotoEditorState } from "../../schema/types";
import { BEFORE_AFTER_DRAWING, beforeAfterFor, pairOf, renderBeforeAfter, type BeforeAfter } from "../../core/before-after";
import { readStoredFile } from "../../core/blob";
import { db } from "../../core/db";
import { quoteDeposits } from "../../core/invoices";
import { isLanguage } from "../../core/language";
import { isPrivileged } from "../../core/members";
import { pdfFileName } from "../../core/pdf";
import { getProfile } from "../../core/profile";
import {
  assignPricedPhoto,
  createPricedPhoto,
  findInPricedPhoto,
  pricedPhotoOnQuote,
  pricedPhotoSize,
  pricedPhotosFor,
  MAX_FIND_PHRASE,
  type PricedPhoto,
  type PricedPhotoResult,
} from "../../core/priced-photo";
import type { Assignment } from "../../core/priced-photo-select";
import { customerLinkFor } from "../../core/quote-link";
import { quoteTimeline, type TimelineEntry } from "../../core/quote-timeline";
import { callToAction, POST_FORMATS, postLines, SOCIAL_POST_DRAWING, socialCaption, socialPostFor, type PostFormat } from "../../core/social-post";
import {
  approveQuote,
  countQuotes,
  countQuotesByStatus,
  getQuote,
  listQuotes,
  quoteCursor,
  type QuoteCursor,
  loadSummary,
  quoteCreatorId,
  setQuoteOutcome,
  type QuoteDetail,
  type QuoteSummary,
} from "../../core/quotes";
import { HttpError, memberCaller, type AppCaller } from "../guards";
import { pageCopyFor } from "../page-copy";
import { notFound, privilegedActor, refuse } from "./access";

export const QUOTE_STATUSES = ["draft", "needs_owner", "approved", "sent", "won", "lost", "void"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const QUOTE_OUTCOMES = ["sent", "won", "lost", "void"] as const;
export type QuoteOutcome = (typeof QUOTE_OUTCOMES)[number];
/** Quotes per page of the list. */
export const QUOTE_PAGE_SIZE = 50;

export const isQuoteStatus = (value: unknown): value is QuoteStatus =>
  typeof value === "string" && (QUOTE_STATUSES as readonly string[]).includes(value);

/** A quote cursor from a page link (`?before=` / `?after=`), `<changed at>~<id>`, or nothing for anything malformed. */
export function parseQuoteCursor(value: unknown): QuoteCursor | undefined {
  const match = typeof value === "string" ? value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~(quo_[\w-]{1,64})$/) : null;
  if (!match || Number.isNaN(Date.parse(match[1]))) return undefined;
  return { at: match[1], id: match[2] };
}

export const formatQuoteCursor = (cursor: QuoteCursor) => `${cursor.at}~${cursor.id}`;

export type QuoteList = {
  quotes: QuoteSummary[];
  counts: Partial<Record<QuoteStatus, number>>;
  /** Where the first quote shown sits in the whole list, from 1. */
  from: number;
  /** Whether there are quotes past this page: older ones, and newer ones. */
  hasOlder: boolean;
  hasNewer: boolean;
  /** How many quotes the list holds across every page, when that's known without the search words. */
  matching?: number;
};

/**
 * One page of the business's quotes, most recently changed first. It
 * pages from a quote (`before` it for older ones, `after` it for newer), so a quote that changes while
 * someone pages moves to the top without making another skip a page or show twice. The counts are per
 * status over every page, so the tabs stay right on any page.
 */
export async function quotesFor(
  caller: AppCaller,
  filter: { status?: QuoteStatus; query?: string; before?: QuoteCursor; after?: QuoteCursor },
): Promise<QuoteList> {
  const scope = { status: filter.status ? [filter.status] : undefined, query: filter.query };
  const newer = filter.after !== undefined && filter.before === undefined;
  const [fetched, counts] = await Promise.all([
    listQuotes(caller.orgId, { ...scope, before: newer ? undefined : filter.before, after: newer ? filter.after : undefined, limit: QUOTE_PAGE_SIZE + 1 }),
    countQuotesByStatus(caller.orgId),
  ]);
  const more = fetched.length > QUOTE_PAGE_SIZE;
  // Newer pages come back newest first, so their extra quote is the first.
  const quotes = more ? (newer ? fetched.slice(1) : fetched.slice(0, QUOTE_PAGE_SIZE)) : fetched;
  const first = quotes[0];
  const paged = filter.before !== undefined || filter.after !== undefined;
  const ahead = paged && first ? await countQuotes(caller.orgId, { ...scope, after: quoteCursor(first) }) : 0;
  const last = quotes.at(-1);
  const hasOlder = newer ? Boolean(last && (await listQuotes(caller.orgId, { ...scope, before: quoteCursor(last), limit: 1 })).length > 0) : more;
  const searching = Boolean(filter.query?.trim());
  const matching = searching
    ? undefined
    : filter.status
      ? (counts[filter.status] ?? 0)
      : Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
  return { quotes, counts, from: ahead + 1, hasOlder, hasNewer: newer ? more : ahead > 0, matching };
}

/** Throws a 404 unless the quote is the caller's business's. Everyone on the team sees every quote. */
export async function assertVisible(caller: AppCaller, quoteId: string): Promise<void> {
  if (!(await quoteCreatorId(caller.orgId, quoteId))) throw notFound();
}

/**
 * `depositPaidCents` is what's been paid of the quote's deposit, for owners and admins (null otherwise, or
 * with none asked). `pricedPhoto` is its latest priced photo, and the lines it couldn't find in it.
 * `beforeAfter` is its before-and-after, when it has a priced photo from before the job and one after,
 * and `socialPost` the post made from it: its image in each format, with and without the line asking
 * for the next job, and the caption for each. `ctaAvailable` is false when the business has no phone or
 * email for that line, so both are the same.
 */
export type QuotePage = {
  quote: QuoteDetail;
  timeline: TimelineEntry[];
  depositPaidCents: number | null;
  pricedPhoto: { id: string; url: string; notLocated: string[] } | null;
  beforeAfter: { href: string; outlinedHref: string } | null;
  socialPost: {
    images: Record<PostFormat, { withCta: string; withoutCta: string }>;
    captions: { withCta: string; withoutCta: string };
    ctaAvailable: boolean;
  } | null;
};

export async function quoteFor(caller: AppCaller, quoteId: string): Promise<QuotePage> {
  await assertVisible(caller, quoteId);
  const [quote, timeline, photos] = await Promise.all([getQuote(caller.orgId, quoteId), quoteTimeline(caller.orgId, quoteId), pricedPhotosFor(caller.orgId, quoteId)]);
  if (!quote) throw notFound();
  const [priced] = photos;
  const pair = pairOf(photos);
  // A quote approved before links existed gets its link the first time it's looked at.
  const customerLink = quote.customerLink ?? (await customerLinkFor(caller.orgId, quoteId));
  const deposits = quote.depositCents && isPrivileged(caller.role) ? await quoteDeposits(caller.orgId, quoteId) : null;
  const profile = pair ? await getProfile(caller.orgId) : null;
  return {
    quote: { ...quote, customerLink },
    timeline: timeline ?? [],
    depositPaidCents: deposits ? deposits.reduce((sum, p) => sum + p.amountCents, 0) : null,
    pricedPhoto: priced
      ? { id: priced.id, url: pricedPhotoHref(priced), notLocated: priced.regions.filter((region) => !region.located).map((region) => region.name) }
      : null,
    beforeAfter: pair
      ? { href: beforeAfterHref({ quoteId, version: pair.version }), outlinedHref: beforeAfterHref({ quoteId, version: pair.version }, { outlines: true }) }
      : null,
    socialPost:
      pair && profile
        ? {
            images: Object.fromEntries(
              POST_FORMATS.map((format) => [
                format,
                { withCta: socialPostHref({ quoteId, version: pair.version }, { format, cta: true }), withoutCta: socialPostHref({ quoteId, version: pair.version }, { format, cta: false }) },
              ]),
            ) as Record<PostFormat, { withCta: string; withoutCta: string }>,
            captions: {
              withCta: socialCaption(postLines(pair), profile, { cta: true, language: caller.language }),
              withoutCta: socialCaption(postLines(pair), profile, { cta: false, language: caller.language }),
            },
            ctaAvailable: callToAction(profile, caller.language) !== null,
          }
        : null,
  };
}

/** What a quote's card in the chat shows: the quote as it is now, and whether the viewer may approve it there. */
export type QuoteCard = {
  quoteId: string;
  title: string;
  customerName: string | null;
  totalCents: number;
  status: QuoteStatus;
  revisionNumber: number;
  ready: boolean;
  canApprove: boolean;
  /** The quote's latest priced photo, as the app serves it. */
  pricedPhoto: { id: string; url: string } | null;
};

/** Where the app serves a priced photo; the version changes when it's made again or edited, so a cached one isn't shown. */
export const pricedPhotoHref = (photo: Pick<PricedPhoto, "id" | "quoteId" | "createdAt" | "editedAt">) =>
  `/api/quotes/${encodeURIComponent(photo.quoteId)}/priced/${encodeURIComponent(photo.id)}?v=${Math.max(photo.createdAt.getTime(), photo.editedAt?.getTime() ?? 0)}`;

/**
 * A before-and-after's or a post's version as its address carries it: the pair's version and the
 * drawing's, so a photo made again or a change to how it's drawn is a new address.
 */
const beforeAfterVersion = (version: number) => `${version}.${BEFORE_AFTER_DRAWING}`;
const socialPostVersion = (version: number) => `${version}.${SOCIAL_POST_DRAWING}`;

/**
 * Where the app serves a quote's before-and-after, plain or with `outlines`; the version changes when
 * either photo is made again or edited, or the drawing changes.
 */
export const beforeAfterHref = (pair: Pick<BeforeAfter, "quoteId" | "version">, options: { outlines?: boolean } = {}) =>
  `/api/quotes/${encodeURIComponent(pair.quoteId)}/before-after?v=${beforeAfterVersion(pair.version)}${options.outlines ? "&outlines=1" : ""}`;

const flag = z.enum(["0", "1"]).transform((value) => value === "1");

/** The before-and-after route's query: `outlines=1` outlines the quoted things. Anything else is a 400. */
export const beforeAfterQuery = z.object({ v: z.string().optional(), outlines: flag.optional() });

/** Where the app serves a quote's social post in one format, with or without the line asking for the next job. */
export const socialPostHref = (pair: Pick<BeforeAfter, "quoteId" | "version">, options: { format: PostFormat; cta: boolean }) =>
  `/api/quotes/${encodeURIComponent(pair.quoteId)}/post?v=${socialPostVersion(pair.version)}&format=${options.format}&cta=${options.cta ? 1 : 0}`;

/** The social post route's query: a square unless `format=story`, and the line asking for the next job unless `cta=0`. */
export const socialPostQuery = z.object({ v: z.string().optional(), format: z.enum(POST_FORMATS).default("square"), cta: flag.default(true) });

/**
 * A quote's card for the chat, for whoever may see the quote (`assertVisible`); a 404 for anyone else.
 * Only an owner or admin acting as themselves approves, and only a ready draft or one waiting on them.
 */
export async function quoteCardFor(caller: AppCaller, quoteId: string): Promise<QuoteCard> {
  await assertVisible(caller, quoteId);
  const quote = await loadSummary(caller.orgId, quoteId).catch((error: unknown) => {
    refuse(error, { QUOTE_NOT_FOUND: [404, "That isn't here."] });
  });
  const ready = quote.state === "ready";
  const [priced] = await pricedPhotosFor(caller.orgId, quoteId);
  return {
    quoteId: quote.quoteId,
    title: quote.title,
    customerName: quote.customerName,
    totalCents: quote.totalCents,
    status: quote.status,
    revisionNumber: quote.revisionNumber,
    ready,
    canApprove: caller.memberId !== null && isPrivileged(caller.role) && ready && (quote.status === "draft" || quote.status === "needs_owner"),
    pricedPhoto: priced ? { id: priced.id, url: pricedPhotoHref(priced) } : null,
  };
}

/**
 * An owner or admin approves the revision they're looking at, through the same `approveQuote` the
 * assistant uses: an unready revision is refused, and so is one that changed since the page loaded.
 */
export async function approveFromApp(caller: AppCaller, quoteId: string, revision: number): Promise<QuoteSummary> {
  const actor = privilegedActor(caller);
  await assertVisible(caller, quoteId);
  const errors = pageCopyFor(caller.language).quotes.errors;
  let result: Awaited<ReturnType<typeof approveQuote>>;
  try {
    result = await approveQuote(quoteId, actor, { expectedRevisionNumber: revision });
  } catch (error) {
    refuse(error, { QUOTE_NOT_FOUND: [404, "That isn't here."] });
  }
  if (result.ok) return result.quote;
  switch (result.reason) {
    case "revision_changed":
      throw new HttpError(409, "REVISION_CHANGED", errors.revisionChanged);
    case "not_ready":
      throw new HttpError(409, "NOT_READY", errors.notReady);
    case "not_privileged":
      throw new HttpError(403, "NOT_PRIVILEGED", "Only the owner or an admin can do that.");
    default:
      throw new HttpError(409, "NOT_OPEN", errors.notOpen);
  }
}

/** Marks a quote sent, won, lost, or void through `setQuoteOutcome`, which keeps its own rules. */
export async function setOutcomeFromApp(caller: AppCaller, quoteId: string, outcome: QuoteOutcome): Promise<QuoteSummary> {
  const actor = privilegedActor(caller);
  await assertVisible(caller, quoteId);
  const errors = pageCopyFor(caller.language).quotes.errors;
  try {
    return await setQuoteOutcome(quoteId, outcome, actor);
  } catch (error) {
    refuse(error, {
      QUOTE_NOT_FOUND: [404, "That isn't here."],
      QUOTE_CLOSED: [409, errors.closed],
      NOT_APPROVED: [409, errors.notApproved],
      NOT_READY: [409, errors.notReady],
    });
  }
}

export type StoredFile = { bytes: Uint8Array; contentType: string; filename: string };

/** Image types a browser may show inline; anything else downloads. */
function sniffImage(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

/**
 * The quote's current PDF, or one of its photos, read back from storage. Served through the app so the
 * same visibility rule covers files as the page, and local file:// storage works in development.
 */
export async function quoteFile(caller: AppCaller, quoteId: string, which: { pdf: true } | { photoId: string }): Promise<StoredFile> {
  await assertVisible(caller, quoteId);
  const quote = await getQuote(caller.orgId, quoteId);
  if (!quote) throw notFound();
  if ("pdf" in which) {
    if (!quote.pdfUrl) throw notFound();
    const bytes = await readStoredFile(quote.pdfUrl);
    if (!bytes) throw notFound();
    const language = isLanguage(quote.customer?.language) ? quote.customer.language : "en";
    return { bytes, contentType: "application/pdf", filename: pdfFileName(quote.title, quote.revisionNumber, language) };
  }
  const photo = quote.attachments.find((a) => a.id === which.photoId);
  if (!photo) throw notFound();
  const bytes = await readStoredFile(photo.url);
  if (!bytes) throw notFound();
  const image = sniffImage(bytes);
  return {
    bytes,
    contentType: image ?? "application/octet-stream",
    filename: (photo.name ?? "attachment").replace(/[^\w.-]+/g, "_"),
  };
}

/** One of the quote's priced photos, read back from storage, for anyone who may see the quote. */
export async function pricedPhotoFile(caller: AppCaller, quoteId: string, pricedId: string): Promise<StoredFile> {
  await assertVisible(caller, quoteId);
  const photo = (await pricedPhotosFor(caller.orgId, quoteId)).find((p) => p.id === pricedId);
  const bytes = photo ? await readStoredFile(photo.url) : null;
  if (!bytes) throw notFound();
  return { bytes, contentType: "image/png", filename: `priced-photo-${quoteId}.png` };
}

/**
 * The quote's before-and-after, drawn for anyone who may see the quote, in their language and with the
 * total. A 404 when it has no pair, or when either photo can't be read anymore.
 */
export async function beforeAfterFile(caller: AppCaller, quoteId: string, options: { outlines?: boolean } = {}): Promise<StoredFile & { version: string }> {
  await assertVisible(caller, quoteId);
  const pair = await beforeAfterFor(caller.orgId, quoteId);
  if (!pair) throw notFound();
  const drawn = await renderBeforeAfter(pair, caller.language, { linePrices: true, outlines: options.outlines }).catch((error: unknown) => {
    console.error("before and after: drawing failed", { quoteId, error });
    throw notFound();
  });
  return { bytes: drawn.png, contentType: "image/png", filename: `before-after-${quoteId}.png`, version: beforeAfterVersion(pair.version) };
}

/**
 * The quote's social post, drawn for anyone who may see the quote, in their language. A 404 when it has
 * no before-and-after, or when either photo can't be read anymore.
 */
export async function socialPostFile(caller: AppCaller, quoteId: string, options: { format: PostFormat; cta: boolean }): Promise<StoredFile & { version: string }> {
  await assertVisible(caller, quoteId);
  const post = await socialPostFor(caller.orgId, quoteId, { ...options, language: caller.language }).catch((error: unknown) => {
    console.error("social post: drawing failed", { quoteId, error });
    throw notFound();
  });
  if (!post) throw notFound();
  return { bytes: post.png, contentType: "image/png", filename: `before-after-${options.format}.png`, version: socialPostVersion(post.pair.version) };
}

/** Makes (or makes again) the quote's priced photo from its latest photo, as the assistant's price_photo does. */
export async function pricePhotoFromApp(caller: AppCaller, quoteId: string): Promise<PricedPhotoResult> {
  await assertVisible(caller, quoteId);
  return createPricedPhoto(memberCaller(caller), { quoteId });
}

// The priced photo editor on the quote page: anyone on the team who may see the quote moves the objects
// SAM found between its lines, or asks SAM for one more thing. Refusals are 400s with a short reason.
const EDIT_REFUSALS = {
  PRICED_PHOTO_NOT_FOUND: [404, "That isn't here."],
  UNKNOWN_CANDIDATE: [400, "That object isn't on this photo."],
  UNKNOWN_LINE: [400, "That line isn't on this photo."],
  BAD_PHRASE: [400, `Say what to look for in 1 to ${MAX_FIND_PHRASE} characters.`],
  UNREADABLE_PHOTO: [409, "The photo can't be read anymore."],
  PRICED_PHOTO_CHANGED: [409, "The photo changed while this was saved. Open it again."],
  SAM_FAILED: [502, "The photo couldn't be searched just now. Try again."],
} as const;

/** What the editor shows for one of the quote's priced photos. */
export async function pricedPhotoEditor(caller: AppCaller, quoteId: string, pricedId: string): Promise<PricedPhotoEditorState> {
  await assertVisible(caller, quoteId);
  const photo = await pricedPhotoOnQuote(caller.orgId, quoteId, pricedId);
  if (!photo) throw notFound();
  return editorState(caller, photo, photo.editedByName);
}

/** Puts the photo's objects on the lines the member assigned them to, and draws it again without SAM. */
export async function assignPricedPhotoFromApp(caller: AppCaller, quoteId: string, pricedId: string, assignments: Assignment[]): Promise<PricedPhotoEditorState> {
  const actor = memberCaller(caller);
  await assertVisible(caller, quoteId);
  try {
    return await editorState(caller, await assignPricedPhoto(actor, quoteId, pricedId, assignments), actor.name);
  } catch (error) {
    refuse(error, EDIT_REFUSALS);
  }
}

/** Asks SAM for one more phrase on the photo, optionally inside a box and onto a line, and draws it again. */
export async function findInPricedPhotoFromApp(
  caller: AppCaller,
  quoteId: string,
  pricedId: string,
  ask: { phrase: string; box?: PricedBox; lineIndex?: number },
): Promise<PricedPhotoEditorState & { found: number }> {
  const actor = memberCaller(caller);
  await assertVisible(caller, quoteId);
  try {
    const { photo, found } = await findInPricedPhoto(actor, quoteId, pricedId, ask);
    const editedBy = photo.editedBy === actor.memberId ? actor.name : ((await pricedPhotoOnQuote(caller.orgId, quoteId, pricedId))?.editedByName ?? null);
    return { ...(await editorState(caller, photo, editedBy)), found };
  } catch (error) {
    refuse(error, EDIT_REFUSALS);
  }
}

async function editorState(caller: AppCaller, photo: PricedPhoto, editedBy: string | null): Promise<PricedPhotoEditorState> {
  const size = await pricedPhotoSize(photo);
  if (!size) throw new HttpError(409, "UNREADABLE_PHOTO", EDIT_REFUSALS.UNREADABLE_PHOTO[1]);
  return {
    pricedPhotoId: photo.id,
    width: size.width,
    height: size.height,
    photoUrl: await sourcePhotoHref(caller, photo),
    renderedUrl: pricedPhotoHref(photo),
    candidates: photo.candidates,
    // Objects on a photo made before candidates were kept have no candidateId at all.
    regions: photo.regions.map((region) => ({ ...region, objects: region.objects.map((o) => ({ ...o, candidateId: o.candidateId ?? null })) })),
    lines: photo.regions.map(({ lineIndex, name, quantity, unitLabel, totalCents, phrase }) => ({ lineIndex, name, quantity, unitLabel, totalCents, phrase })),
    editedAt: photo.editedAt?.toISOString() ?? null,
    editedBy: photo.editedAt ? editedBy : null,
  };
}

/** Where the app serves the photo a priced photo was drawn on: the quote's photo route, or its work's. */
async function sourcePhotoHref(caller: AppCaller, photo: PricedPhoto): Promise<string> {
  if (photo.sourceKind === "quote_attachment") return `/api/quotes/${encodeURIComponent(photo.quoteId)}/photos/${encodeURIComponent(photo.sourceId)}`;
  const [work] = await db()
    .select({ jobId: workPhotos.jobId })
    .from(workPhotos)
    .where(and(eq(workPhotos.orgId, caller.orgId), eq(workPhotos.id, photo.sourceId)));
  if (!work) throw notFound();
  return `/api/work/${encodeURIComponent(work.jobId)}/photos/${encodeURIComponent(photo.sourceId)}`;
}

/** A stored file as a response: images and PDFs open in the browser, anything else downloads. */
export function fileResponse(file: StoredFile, cacheControl = "private, max-age=300"): Response {
  const inline = file.contentType === "application/pdf" || file.contentType.startsWith("image/");
  return new Response(Buffer.from(file.bytes), {
    headers: {
      "content-type": file.contentType,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${file.filename.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "cache-control": cacheControl,
    },
  });
}
