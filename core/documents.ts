import { PDFDocument } from "pdf-lib";

// Documents a member texts in: a price list, a rate card, an old invoice, a customer list. The model
// reads PDFs itself (text and scanned pages alike), so a PDF is checked here and passed on as a file;
// a CSV or plain-text file is passed on as text; anything else is named in a note the model explains.

/** A PDF longer than this is not read: every page costs the model tokens on every later turn. */
export const PDF_PAGE_LIMIT = 20;
export const PDF_BYTE_LIMIT = 20 * 1024 * 1024;
/** About 15k tokens: a few hundred spreadsheet rows. Longer text is cut, and the note says so. */
export const TEXT_CHAR_LIMIT = 60_000;

export type DocumentKind = "pdf" | "text" | "unsupported";

const TEXT_TYPES = new Set([
  "text/csv",
  "text/comma-separated-values",
  "text/tab-separated-values",
  "text/plain",
  "application/csv",
]);
const TEXT_EXTENSIONS = /\.(csv|tsv|txt)$/i;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/**
 * How a non-image, non-media file is handled, from its type or, when the type is generic, its name or
 * its first bytes.
 */
export function documentKind(mimeType: string, name: string, bytes?: Uint8Array): DocumentKind {
  const type = mimeType.toLowerCase().split(";")[0].trim();
  if (type === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (bytes && PDF_MAGIC.every((b, i) => bytes[i] === b)) return "pdf";
  if (TEXT_TYPES.has(type) || TEXT_EXTENSIONS.test(name)) return "text";
  return "unsupported";
}

export type PdfCheck =
  | { ok: true; pages: number }
  | { ok: false; reason: "too_large" | "too_many_pages" | "locked" | "unreadable"; pages?: number };

/** Opens a PDF far enough to count its pages; one that can't be opened, is locked, or is too long is refused. */
export async function checkPdf(bytes: Uint8Array): Promise<PdfCheck> {
  if (bytes.byteLength > PDF_BYTE_LIMIT) return { ok: false, reason: "too_large" };
  let encrypted: boolean;
  let pages: number;
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    encrypted = doc.isEncrypted;
    pages = encrypted ? 0 : doc.getPageCount();
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  // A password-protected PDF may need the password to open; the model can't ask for one.
  if (encrypted) return { ok: false, reason: "locked" };
  if (pages === 0) return { ok: false, reason: "unreadable" };
  if (pages > PDF_PAGE_LIMIT) return { ok: false, reason: "too_many_pages", pages };
  return { ok: true, pages };
}

export type TextRead = { ok: true; text: string; truncated: boolean } | { ok: false };

/** Decodes a CSV or text file as UTF-8. A file that looks binary (a renamed spreadsheet) is refused. */
export function readTextDocument(bytes: Uint8Array): TextRead {
  if (bytes.includes(0)) return { ok: false };
  let text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return { ok: false };
  const truncated = text.length > TEXT_CHAR_LIMIT;
  if (truncated) {
    text = text.slice(0, TEXT_CHAR_LIMIT);
    const lastLine = text.lastIndexOf("\n");
    if (lastLine > 0) text = text.slice(0, lastLine);
  }
  return { ok: true, text: text.trimEnd(), truncated };
}

/** What the model is told about a PDF it can read. */
export function pdfNote(name: string, pages: number): string {
  return `(PDF: ${name}, ${pages} ${pages === 1 ? "page" : "pages"})`;
}

export type UnreadReason = (PdfCheck & { ok: false })["reason"] | "unsupported" | "not_text";

/**
 * What the model is told about a file it can't read: the reason and what would work instead, so it can
 * tell the member in one plain line.
 */
export function unreadNote(name: string, reason: UnreadReason, pages?: number): string {
  const why: Record<UnreadReason, string> = {
    unsupported: "that kind of file can't be opened here",
    not_text: "it is empty or isn't plain text",
    too_large: `it is over ${PDF_BYTE_LIMIT / 1024 / 1024} MB`,
    too_many_pages: `it has ${pages ?? "too many"} pages and up to ${PDF_PAGE_LIMIT} can be read at a time`,
    locked: "it is password-protected",
    unreadable: "it could not be opened",
  };
  return `(file ${name} was not read: ${why[reason]}. A screenshot, a PDF of up to ${PDF_PAGE_LIMIT} pages, or a CSV works.)`;
}

/** The text part a CSV or text file becomes. */
export function textDocumentPart(name: string, read: TextRead & { ok: true }): string {
  const cut = read.truncated ? ` It was cut off after ${TEXT_CHAR_LIMIT.toLocaleString("en-US")} characters; say so.` : "";
  return `(file ${name}, its text follows.${cut})\n${read.text}`;
}
