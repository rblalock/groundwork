import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { del, put } from "@vercel/blob";

const isFake = (): boolean => process.env.BLOB_FAKE === "1";
/** Local dev only: quote PDFs and inbound photos are written under this folder, so their file:// links open. */
const localDir = (): string | undefined => process.env.BLOB_LOCAL_DIR || undefined;

/** Store a rendered quote PDF and return its public, unguessable URL (random suffix). */
export async function storeQuotePdf(quoteId: string, revisionNumber: number, bytes: Uint8Array): Promise<string> {
  const path = `quotes/${quoteId}/r${revisionNumber}.pdf`;
  const dir = localDir();
  if (dir) {
    const file = resolve(dir, path);
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(file, bytes);
    return pathToFileURL(file).href;
  }
  if (isFake()) return `fake://${path}`;
  const blob = await put(path, Buffer.from(bytes), {
    access: "public",
    addRandomSuffix: true,
    contentType: "application/pdf",
  });
  return blob.url;
}

/**
 * Store a rendered invoice PDF and return its public, unguessable URL. `stamp` tells renders apart: an
 * invoice is rendered again when a payment changes its balance.
 */
export async function storeInvoicePdf(invoiceId: string, stamp: string, bytes: Uint8Array): Promise<string> {
  const path = `invoices/${invoiceId}/${stamp}.pdf`;
  const dir = localDir();
  if (dir) {
    const file = resolve(dir, path);
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(file, bytes);
    return pathToFileURL(file).href;
  }
  if (isFake()) return `fake://${path}`;
  const blob = await put(path, Buffer.from(bytes), {
    access: "public",
    addRandomSuffix: true,
    contentType: "application/pdf",
  });
  return blob.url;
}

/** Store an inbound photo or file a member texted us and return its public, unguessable URL (random suffix). */
export async function storeInboundAttachment(name: string, mimeType: string, bytes: Uint8Array): Promise<string> {
  const safe = name.replace(/[^\w.-]+/g, "_").slice(0, 100) || "attachment";
  const dir = localDir();
  if (dir) {
    const file = resolve(dir, "inbound", `${crypto.randomUUID().slice(0, 8)}-${safe}`);
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(file, bytes);
    return pathToFileURL(file).href;
  }
  if (isFake()) return `fake://inbound/${crypto.randomUUID().slice(0, 8)}-${safe}`;
  const blob = await put(`inbound/${safe}`, Buffer.from(bytes), {
    access: "public",
    addRandomSuffix: true,
    contentType: mimeType,
  });
  return blob.url;
}

/**
 * Store a business's normalized logo and return its public, unguessable URL. Each upload gets a new
 * URL, so a page that shows it can tell a replaced logo from the one before.
 */
export async function storeLogo(orgId: string, mimeType: "image/png" | "image/jpeg", bytes: Uint8Array): Promise<string> {
  const name = `${crypto.randomUUID().slice(0, 8)}.${mimeType === "image/png" ? "png" : "jpg"}`;
  const dir = localDir();
  if (dir) {
    const file = resolve(dir, "logos", orgId, name);
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(file, bytes);
    return pathToFileURL(file).href;
  }
  if (isFake()) return `fake://logos/${orgId}/${name}`;
  const blob = await put(`logos/${orgId}/logo.${mimeType === "image/png" ? "png" : "jpg"}`, Buffer.from(bytes), {
    access: "public",
    addRandomSuffix: true,
    contentType: mimeType,
  });
  return blob.url;
}

/** Types an email attachment keeps when stored: raster images and PDFs, which open as what they are. */
const SAFE_EMAIL_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"]);

/**
 * Stores an attachment that came in a forwarded email. Anything that isn't a raster image or a PDF (HTML,
 * SVG, a script, an unknown file) is stored as `application/octet-stream`, so a browser opening its public
 * URL downloads it instead of rendering it. Blob's `put` takes no Content-Disposition, so the type is the
 * guard.
 */
export function storeEmailAttachment(name: string, mimeType: string, bytes: Uint8Array): Promise<string> {
  return storeInboundAttachment(name, emailAttachmentType(mimeType), bytes);
}

/** The type an email attachment is stored with (`storeEmailAttachment`). */
export function emailAttachmentType(mimeType: string): string {
  const type = mimeType.toLowerCase().split(";")[0].trim();
  return SAFE_EMAIL_TYPES.has(type) ? type : "application/octet-stream";
}

export async function deleteBlob(url: string): Promise<void> {
  if (isFake() || url.startsWith("fake://") || url.startsWith("file://")) return;
  await del(url);
}

const READ_LIMIT_BYTES = 25 * 1024 * 1024;

/** Reads back a file stored here: https from Blob, file:// from the local dev folder. A fake:// URL has no bytes. */
export async function readStoredFile(url: string): Promise<Uint8Array | null> {
  if (url.startsWith("file://")) return new Uint8Array(await readFile(fileURLToPath(url)));
  if (!/^https:\/\//i.test(url)) return null;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`stored file fetch failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > READ_LIMIT_BYTES) throw new Error("stored file is over the 25 MB limit");
  return bytes;
}
