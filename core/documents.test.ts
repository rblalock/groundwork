import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  PDF_BYTE_LIMIT,
  PDF_PAGE_LIMIT,
  TEXT_CHAR_LIMIT,
  checkPdf,
  documentKind,
  pdfNote,
  readTextDocument,
  textDocumentPart,
  unreadNote,
} from "./documents";

/** A text PDF with `pages` pages of obviously fake prices. */
async function fakePdf(pages = 1, options: { encrypted?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    doc.addPage().drawText(`Widget service $12 each (page ${i + 1})`, { x: 50, y: 700, size: 14, font });
  }
  if (options.encrypted) doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: "Standard", V: 1, R: 2 });
  return doc.save();
}

test("documentKind reads the type, then the name, then the first bytes", () => {
  assert.equal(documentKind("application/pdf", "attachment"), "pdf");
  assert.equal(documentKind("application/octet-stream", "Prices.PDF"), "pdf");
  assert.equal(documentKind("application/octet-stream", "attachment", new TextEncoder().encode("%PDF-1.7\n")), "pdf");
  assert.equal(documentKind("text/csv", "prices"), "text");
  assert.equal(documentKind("text/comma-separated-values; charset=utf-8", "x"), "text");
  assert.equal(documentKind("application/octet-stream", "prices.csv"), "text");
  assert.equal(documentKind("text/plain", "notes"), "text");
  assert.equal(
    documentKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "prices.xlsx"),
    "unsupported",
  );
  assert.equal(documentKind("application/octet-stream", "attachment", new Uint8Array([1, 2, 3])), "unsupported");
});

test("checkPdf counts the pages of a PDF it can open", async () => {
  assert.deepEqual(await checkPdf(await fakePdf(3)), { ok: true, pages: 3 });
  assert.deepEqual(await checkPdf(await fakePdf(PDF_PAGE_LIMIT)), { ok: true, pages: PDF_PAGE_LIMIT });
});

test("checkPdf refuses a PDF that is too long, too big, locked, or not a PDF", async () => {
  assert.deepEqual(await checkPdf(await fakePdf(PDF_PAGE_LIMIT + 1)), {
    ok: false,
    reason: "too_many_pages",
    pages: PDF_PAGE_LIMIT + 1,
  });
  assert.deepEqual(await checkPdf(new Uint8Array(PDF_BYTE_LIMIT + 1)), { ok: false, reason: "too_large" });
  assert.deepEqual(await checkPdf(await fakePdf(1, { encrypted: true })), { ok: false, reason: "locked" });
  assert.deepEqual(await checkPdf(new TextEncoder().encode("not a pdf at all")), { ok: false, reason: "unreadable" });
});

test("readTextDocument decodes UTF-8, drops a BOM, and normalizes line ends", () => {
  const bytes = new TextEncoder().encode("﻿Item,Price\r\nWidget service,$12\r\nGadget fitting,$2\r\n");
  assert.deepEqual(readTextDocument(bytes), {
    ok: true,
    text: "Item,Price\nWidget service,$12\nGadget fitting,$2",
    truncated: false,
  });
});

test("readTextDocument refuses binary and empty files", () => {
  assert.deepEqual(readTextDocument(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), { ok: false });
  assert.deepEqual(readTextDocument(new TextEncoder().encode("  \n ")), { ok: false });
});

test("readTextDocument cuts a long file at the last whole line under the limit", () => {
  const line = "Widget service,$12\n";
  const rows = Math.ceil(TEXT_CHAR_LIMIT / line.length) + 10;
  const read = readTextDocument(new TextEncoder().encode(line.repeat(rows)));
  assert.ok(read.ok);
  assert.equal(read.truncated, true);
  assert.ok(read.text.length <= TEXT_CHAR_LIMIT);
  assert.ok(read.text.endsWith("Widget service,$12"), "ends on a whole row");
  assert.match(textDocumentPart("prices.csv", read), /^\(file prices\.csv, its text follows\. It was cut off after 60,000 characters; say so\.\)\n/);
});

test("the notes tell the model what it read, or why it couldn't", () => {
  assert.equal(pdfNote("prices.pdf", 1), "(PDF: prices.pdf, 1 page)");
  assert.equal(pdfNote("prices.pdf", 3), "(PDF: prices.pdf, 3 pages)");
  assert.match(unreadNote("big.pdf", "too_many_pages", 45), /big\.pdf was not read: it has 45 pages and up to 20 can be read/);
  assert.match(unreadNote("locked.pdf", "locked"), /password-protected/);
  assert.match(unreadNote("prices.xlsx", "unsupported"), /can't be opened here\. A screenshot, a PDF of up to 20 pages, or a CSV works\.\)$/);
  assert.equal(textDocumentPart("a.csv", { ok: true, text: "x,1", truncated: false }), "(file a.csv, its text follows.)\nx,1");
});
