import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import * as upngModule from "@pdf-lib/upng";
import { PDFArray, PDFDocument, type PDFRawStream } from "pdf-lib";
import { pdfCopy } from "./pdf-copy";
import { pdfFileName, receiptPdfFileName, renderInvoicePdf, renderQuotePdf, renderReceiptPdf, type QuotePdfDocument, type ReceiptPdfDocument } from "./pdf";
import { deleteBlob, readStoredFile, storeInboundAttachment, storeQuotePdf } from "./blob";
import type { Profile } from "./profile";
import type { LineResult } from "./calculator";
import jpeg from "jpeg-js";

const UPNG = ((upngModule as unknown as { default?: { default?: typeof upngModule } }).default?.default ??
  (upngModule as unknown as { default?: typeof upngModule }).default ??
  upngModule) as typeof upngModule;

const profile = {
  orgId: "org_test",
  name: "Test Co",
  phone: "555-0100",
  email: "hello@example.test",
  address: "1 Example Way, Springfield",
  licenseNumber: "LIC-0000",
  timeZone: "America/New_York",
  quietStartHour: 20,
  quietEndHour: 7,
  quoteValidityDays: 30,
  followUpDays: 3,
  minimumChargeCents: null,
  taxRateBp: null,
  customerLinePrices: true,
  language: "en",
  version: 1,
  pricebookVersion: 0,
  rulesVersion: 0,
  updatedAt: new Date("2026-10-16T00:00:00Z"),
} as Profile;

function line(n: number): LineResult {
  return { itemId: `item_${n}`, name: `Widget service ${n}`, unitLabel: "each", quantity: 2, unitCents: 12_500, taxable: true, source: "pricebook", totalCents: 25_000 };
}

function doc(overrides: Partial<QuotePdfDocument> & { lineCount?: number } = {}): QuotePdfDocument {
  const { lineCount = 2, ...rest } = overrides;
  const lines = Array.from({ length: lineCount }, (_, i) => line(i + 1));
  const subtotal = lines.length * 25_000;
  return {
    profile,
    quoteId: "quote_test",
    title: "4512 Palm Ave",
    status: "sent",
    revision: {
      number: 1,
      lines,
      ruleLines: [],
      adjustments: [],
      subtotalCents: subtotal,
      minimumAppliedCents: 0,
      adjustmentCents: 0,
      taxRateBp: null,
      taxCents: 0,
      totalCents: subtotal,
      validUntil: "2026-11-15",
      customerNotes: null,
    },
    customer: { name: "Pat Example", phones: ["555-0199"], emails: ["pat@example.test"] },
    property: { address: "4512 Palm Ave" },
    language: "en",
    ...rest,
  };
}

async function render(d: QuotePdfDocument) {
  return PDFDocument.load(await renderQuotePdf(d));
}

test("renders a one-page English quote with totals", async () => {
  const bytes = await renderQuotePdf(doc({ language: "en" }));
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1);
  const page = pdf.getPage(0);
  assert.equal(page.getWidth(), 612);
  assert.equal(page.getHeight(), 792);
});

test("renders a Spanish quote with every optional section", async () => {
  const d = doc({ language: "es", status: "draft" });
  d.revision = {
    ...d.revision,
    number: 3,
    ruleLines: [{ ruleId: "rule_1", label: "Cargo por distancia", cents: 4_000 }],
    adjustments: [{ kind: "discount", amountCents: 5_000, reason: "loyal", memberId: "m1" }],
    minimumAppliedCents: 1_000,
    adjustmentCents: -5_000,
    taxRateBp: 825,
    taxCents: 3_000,
    totalCents: 53_000,
    customerNotes: "Gracias por la visita.\nIncluye mano de obra: ¿Preguntas? ¡Llámenos!",
  };
  const pdf = await render(d);
  assert.equal(pdf.getPageCount(), 1);
});

test("a draft or needs-owner PDF is marked a draft; an approved one is not", async () => {
  assert.equal((await render(doc({ status: "draft" }))).getKeywords(), "draft");
  assert.equal((await render(doc({ status: "needs_owner" }))).getKeywords(), "draft");
  assert.equal((await render(doc({ status: "approved" }))).getKeywords(), undefined);
});

test("Spanish copy table has every key", () => {
  const en = pdfCopy("en"), es = pdfCopy("es");
  assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());
  assert.equal(es.quote, "Presupuesto");
  assert.equal(es.preparedFor, "Preparado para");
  assert.equal(es.validUntil, "Válido hasta");
  assert.equal(es.minimumAdjustment, "Ajuste por visita mínima");
  assert.equal(es.discount, "Descuento");
  assert.equal(es.tax("7"), "Impuesto (7%)");
  assert.equal(en.tax("7"), "Tax (7%)");
  assert.notEqual(es.revision(2), en.revision(2));
});

test("file name is ASCII and carries the revision", () => {
  assert.equal(pdfFileName("4512 Palm Ave — María", 2, "en"), "Quote - 4512 Palm Ave - Maria - r2.pdf");
  assert.equal(pdfFileName("Calle Ñandú 5", 1, "es"), "Presupuesto - Calle Nandu 5 - r1.pdf");
  assert.match(pdfFileName("😀 / ../..\\x \u0000", 1, "en"), /^[\x20-\x7e]+$/);
  assert.ok(!pdfFileName("a/b\\c", 1, "en").match(/[\\/]/));
  assert.equal(pdfFileName("", 4, "en"), "Quote - r4.pdf");
  assert.ok(pdfFileName("x".repeat(500), 1, "en").length < 120);
});

test("a 60-line quote paginates", async () => {
  const pdf = await render(doc({ lineCount: 60 }));
  assert.ok(pdf.getPageCount() >= 2);
});

test("text outside the PDF font never throws", async () => {
  const hostile = "Roof 🏠 repair ✅ 你好 \u0000 ​ ☃ ñ é ¿ ¡ — “quoted” €";
  const d = doc({ status: "needs_owner", language: "es" });
  d.title = hostile;
  d.profile = { ...profile, name: hostile, address: hostile, licenseNumber: hostile, email: hostile, phone: hostile };
  d.customer = { name: hostile, phones: [hostile], emails: [hostile] };
  d.property = { address: hostile };
  d.revision = {
    ...d.revision,
    lines: [{ ...line(1), name: hostile, unitLabel: hostile }],
    ruleLines: [{ ruleId: "r", label: hostile, cents: 100 }],
    customerNotes: `${hostile}\n${hostile}\r\n\ttabbed ${"w".repeat(400)}`,
  };
  const bytes = await renderQuotePdf(d);
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 1);
  assert.ok(pdfFileName(hostile, 1, "es").endsWith("r1.pdf"));
});

test("very long unbroken names and null fields do not break layout", async () => {
  const d = doc();
  d.profile = { ...profile, phone: null, email: null, address: null, licenseNumber: null };
  d.customer = null;
  d.property = null;
  d.revision = { ...d.revision, lines: [{ ...line(1), name: "A".repeat(600), totalCents: null, unitCents: null }] };
  assert.ok((await render(d)).getPageCount() >= 1);
});

test("fake blob storage returns fake URLs without network", async () => {
  const previous = process.env.BLOB_FAKE;
  process.env.BLOB_FAKE = "1";
  try {
    assert.equal(await storeQuotePdf("quote_abc", 2, new Uint8Array([1, 2, 3])), "fake://quotes/quote_abc/r2.pdf");
    await deleteBlob("fake://quotes/quote_abc/r2.pdf");
  } finally {
    if (previous === undefined) delete process.env.BLOB_FAKE;
    else process.env.BLOB_FAKE = previous;
  }
});

test("a local blob folder writes the PDF and returns a file:// link that opens it", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const dir = await mkdtemp(`${tmpdir()}/gw-blob-`);
  const previous = process.env.BLOB_LOCAL_DIR;
  process.env.BLOB_LOCAL_DIR = dir;
  try {
    const url = await storeQuotePdf("quote_abc", 2, new Uint8Array([1, 2, 3]));
    assert.match(url, /^file:\/\/.*\/quotes\/quote_abc\/r2\.pdf$/);
    assert.deepEqual([...(await readFile(fileURLToPath(url)))], [1, 2, 3]);
  } finally {
    if (previous === undefined) delete process.env.BLOB_LOCAL_DIR;
    else process.env.BLOB_LOCAL_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

/** A solid-colour JPEG of the given size. */
function photo(width: number, height: number): Uint8Array {
  const data = Buffer.alloc(width * height * 4, 0x80);
  return new Uint8Array(jpeg.encode({ width, height, data }, 80).data);
}

test("attached photos print two to a page after the totals, and an unreadable one is skipped", async () => {
  const one = await render(doc({ photos: [{ bytes: photo(40, 30), mimeType: "image/jpeg" }] }));
  assert.equal(one.getPageCount(), 2);
  const three = await render(doc({ photos: [1, 2, 3].map(() => ({ bytes: photo(300, 400), mimeType: "image/jpeg" })) }));
  assert.equal(three.getPageCount(), 3);
  const broken = await render(doc({ photos: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" }] }));
  assert.equal(broken.getPageCount(), 1);
  // A photo goes by its bytes: a JPEG stored as a PNG (a priced photo drawn again) still prints.
  const renamed = await render(doc({ photos: [{ bytes: photo(40, 30), mimeType: "image/png" }] }));
  assert.equal(renamed.getPageCount(), 2);
});

test("a local blob folder keeps inbound photos readable; a fake one has no bytes", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(`${tmpdir()}/gw-blob-`);
  const previous = process.env.BLOB_LOCAL_DIR;
  process.env.BLOB_LOCAL_DIR = dir;
  try {
    const url = await storeInboundAttachment("IMG 1.jpg", "image/jpeg", new Uint8Array([4, 5, 6]));
    assert.match(url, /^file:\/\/.*\/inbound\/[0-9a-f]{8}-IMG_1\.jpg$/);
    assert.deepEqual([...((await readStoredFile(url)) ?? [])], [4, 5, 6]);
    assert.equal(await readStoredFile("fake://inbound/x.jpg"), null);
  } finally {
    if (previous === undefined) delete process.env.BLOB_LOCAL_DIR;
    else process.env.BLOB_LOCAL_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Branding

/** Every page's drawing instructions, inflated. Text is drawn as hex glyph codes, so search with `hexOf`. */
function contentOf(pdf: PDFDocument): string {
  return pdf
    .getPages()
    .flatMap((page) => {
      const contents = page.node.Contents();
      const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => pdf.context.lookup(ref)) : [contents];
      return streams.map((stream) => {
        const raw = (stream as PDFRawStream).contents;
        try {
          return inflateSync(raw).toString("latin1");
        } catch {
          return Buffer.from(raw).toString("latin1");
        }
      });
    })
    .join("\n")
    .toUpperCase();
}
const hexOf = (text: string) => `<${Buffer.from(text, "latin1").toString("hex").toUpperCase()}>`;

/** A 300 x 100 PNG logo with a see-through half. */
function pngLogo(): Uint8Array {
  const data = new Uint8Array(300 * 100 * 4);
  for (let i = 0; i < data.length; i += 8) data.set([20, 60, 160, 255], i);
  return new Uint8Array(UPNG.encode([data.buffer], 300, 100, 0));
}

const branded = {
  ...profile,
  pdfAccentColor: "#0b5394",
  quoteFooter: "Sample terms: 50% due at booking.\nThank you!",
  invoiceFooter: "Sample terms: pay within 15 days.",
  pdfHiddenDetails: ["phone", "licenseNumber"],
} as Profile;

test("with no branding saved, a quote PDF is exactly the plain one", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") });
  const plain = await renderQuotePdf(doc());
  const unbranded = { ...profile, pdfAccentColor: null, quoteFooter: null, invoiceFooter: null, pdfHiddenDetails: [] } as Profile;
  const defaults = await renderQuotePdf(doc({ profile: unbranded, logo: null }));
  assert.deepEqual(Buffer.from(defaults), Buffer.from(plain));
  const text = contentOf(await PDFDocument.load(plain));
  assert.ok(text.includes(hexOf(pdfCopy("en").thanks)));
  assert.ok(text.includes(hexOf("555-0100")));
  assert.doesNotMatch(text, /\/IMAGE-\d+ DO/);
});

test("with line prices hidden, a quote PDF prints each line's quantity and only the totals", async () => {
  const d = doc({ profile: { ...profile, customerLinePrices: false } });
  d.revision = { ...d.revision, ruleLines: [{ ruleId: "rule_1", label: "Slope surcharge", cents: 4_000 }], subtotalCents: 54_000, totalCents: 54_000 };
  const text = contentOf(await render(d));
  assert.ok(text.includes(hexOf("Widget service 1")));
  assert.ok(text.includes(hexOf("2 each")), "the quantity");
  assert.ok(text.includes(hexOf("Slope surcharge")));
  assert.ok(text.includes(hexOf("$540.00")), "the total");
  for (const price of ["$125.00", "$250.00", "$40.00"]) assert.ok(!text.includes(hexOf(price)), `no ${price}`);
  for (const column of [pdfCopy("en").unit, pdfCopy("en").amount]) assert.ok(!text.includes(hexOf(column)), `no ${column} column`);
  const shown = contentOf(await render({ ...d, profile }));
  for (const price of ["$125.00", "$250.00", "$40.00"]) assert.ok(shown.includes(hexOf(price)), `${price} with prices shown`);
  assert.ok(shown.includes(hexOf(pdfCopy("en").amount)), "the Amount column with prices shown");
});

test("a quote PDF prints the logo, the accent, the closing note, and only the facts chosen", async () => {
  for (const logo of [{ bytes: pngLogo(), mimeType: "image/png" }, { bytes: photo(240, 120), mimeType: "image/jpeg" }]) {
    const bytes = await renderQuotePdf(doc({ profile: branded, logo }));
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), 1);
    const text = contentOf(pdf);
    assert.match(text, /\/IMAGE-\d+ DO/, "the logo is drawn");
    assert.ok(text.includes(hexOf("Sample terms: 50% due at booking.")));
    assert.ok(text.includes(hexOf("Thank you!")));
    assert.ok(!text.includes(hexOf(pdfCopy("en").thanks)), "the standard line is replaced");
    assert.ok(!text.includes(hexOf("555-0100")), "the phone is left off");
    assert.ok(!text.includes(hexOf("License LIC-0000")), "the license is left off");
    assert.ok(text.includes(hexOf("hello@example.test")), "the email stays");
    // The accent fills the table heading: 0b5394 is about 0.043 0.325 0.58.
    assert.match(text, /0\.0431\d* 0\.3254\d* 0\.5803\d* RG/);
  }
  // A logo that can't be read is left off; the PDF still renders.
  const broken = await render(doc({ profile: branded, logo: { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" } }));
  assert.equal(broken.getPageCount(), 1);
});

test("an invoice PDF prints the logo and its own closing note", async () => {
  const invoice = {
    profile: branded,
    label: "INV-0001",
    title: "4512 Palm Ave",
    status: "sent" as const,
    issueDate: "2026-10-18",
    dueDate: "2026-11-02",
    lines: [line(1)],
    ruleLines: [],
    adjustments: [],
    subtotalCents: 25_000,
    minimumAppliedCents: 0,
    adjustmentCents: 0,
    taxRateBp: null,
    taxCents: 0,
    totalCents: 25_000,
    amountPaidCents: 0,
    notes: null,
    customer: { name: "Pat Example", phones: [], emails: [] },
    property: null,
    payUrl: "https://example.test/pay/sample",
    language: "es" as const,
    logo: { bytes: pngLogo(), mimeType: "image/png" },
  };
  const text = contentOf(await PDFDocument.load(await renderInvoicePdf(invoice)));
  assert.ok(text.includes(hexOf("Sample terms: pay within 15 days.")));
  assert.ok(!text.includes(hexOf(pdfCopy("es").invoiceThanks)));
  assert.ok(text.includes(hexOf("FACTURA")), "labels stay in the PDF's language");
  const plain = contentOf(await PDFDocument.load(await renderInvoicePdf({ ...invoice, profile, logo: null })));
  assert.ok(plain.includes(hexOf(pdfCopy("es").invoiceThanks)));
});

const receiptDoc = (overrides: Partial<ReceiptPdfDocument> = {}): ReceiptPdfDocument => ({
  profile,
  label: "INV-0007",
  title: "12 Sample St",
  customerName: "Jane Sample",
  payments: [
    { receivedDate: "2026-10-01", method: "cash", card: null, amountCents: 4_000 },
    { receivedDate: "2026-10-18", method: "card", card: "Visa •••• 4242", amountCents: 20_000 },
  ],
  totalCents: 24_000,
  amountPaidCents: 24_000,
  language: "en",
  ...overrides,
});

/** Whether the PDF draws `text` somewhere, inside a longer line or on its own. */
const draws = (content: string, text: string) => content.includes(hexOf(text).slice(1, -1));

test("a receipt PDF lists each payment, its card, the total, and paid in full", async () => {
  const pdf = await PDFDocument.load(await renderReceiptPdf(receiptDoc()));
  assert.equal(pdf.getTitle(), "Receipt INV-0007");
  const text = contentOf(pdf);
  for (const expected of ["RECEIPT", "For invoice INV-0007", "RECEIVED FROM", "Jane Sample", "Cash", "Visa", "4242", "Invoice total", "Paid in full", "$240.00"]) {
    assert.ok(draws(text, expected), `prints ${expected}`);
  }
  assert.ok(!draws(text, "Balance due"));
  assert.equal(receiptPdfFileName("INV-0007", "en"), "Receipt INV-0007.pdf");
});

test("a receipt PDF in Spanish, with a balance left and no customer", async () => {
  const pdf = await PDFDocument.load(
    await renderReceiptPdf(
      receiptDoc({ language: "es", customerName: null, payments: [{ receivedDate: "2026-10-01", method: "cash", card: null, amountCents: 4_000 }], amountPaidCents: 4_000 }),
    ),
  );
  assert.equal(pdf.getTitle(), "Recibo INV-0007");
  const text = contentOf(pdf);
  for (const expected of ["RECIBO", "De la factura INV-0007", "Efectivo", "Total de la factura", "Saldo pendiente"]) assert.ok(draws(text, expected), `prints ${expected}`);
  assert.ok(!draws(text, "RECIBIDO DE"), "no customer, no received-from block");
  assert.ok(!draws(text, "Pagada por completo"));
  assert.equal(receiptPdfFileName("INV-0007", "es"), "Recibo INV-0007.pdf");
});

test("a receipt PDF with many payments runs onto a second page", async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ receivedDate: "2026-10-01", method: "check" as const, card: null, amountCents: 100 + i }));
  const pdf = await PDFDocument.load(await renderReceiptPdf(receiptDoc({ payments: many })));
  assert.ok(pdf.getPageCount() >= 2);
});

test("an invoice PDF prints the quote's before-and-after after the invoice, before the work photos", async () => {
  const invoice = {
    profile,
    label: "INV-0002",
    title: "412 Oak St front yard",
    status: "sent" as const,
    issueDate: "2026-10-28",
    dueDate: "2026-11-12",
    lines: [line(1)],
    ruleLines: [],
    adjustments: [],
    subtotalCents: 25_000,
    minimumAppliedCents: 0,
    adjustmentCents: 0,
    taxRateBp: null,
    taxCents: 0,
    totalCents: 25_000,
    amountPaidCents: 0,
    notes: null,
    customer: { name: "Pat Example", phones: [], emails: [] },
    property: null,
    payUrl: null,
    language: "en" as const,
  };
  const heading = hexOf(pdfCopy("en").beforeAfter.toUpperCase());
  const without = await PDFDocument.load(await renderInvoicePdf(invoice));
  assert.ok(!contentOf(without).includes(heading));
  // A wide composite fits under the invoice on its first page; the work photos still start their own.
  const withPair = await PDFDocument.load(await renderInvoicePdf({ ...invoice, beforeAfter: { bytes: photo(808, 340), mimeType: "image/jpeg" } }));
  assert.ok(contentOf(withPair).includes(heading));
  assert.equal(withPair.getPageCount(), 1);
  const both = await PDFDocument.load(
    await renderInvoicePdf({ ...invoice, beforeAfter: { bytes: photo(808, 340), mimeType: "image/jpeg" }, photos: [{ bytes: photo(40, 30), mimeType: "image/jpeg" }] }),
  );
  assert.equal(both.getPageCount(), 2);
  const spanish = await PDFDocument.load(await renderInvoicePdf({ ...invoice, language: "es", beforeAfter: { bytes: photo(808, 340), mimeType: "image/jpeg" } }));
  assert.ok(contentOf(spanish).includes(hexOf("ANTES Y DESPUÉS")));
  // One that won't embed is left off; the invoice still renders.
  const broken = await PDFDocument.load(await renderInvoicePdf({ ...invoice, beforeAfter: { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" } }));
  assert.ok(!contentOf(broken).includes(heading));
});
