import { storeInboundAttachment } from "../../core/blob";
import { logWebInbound } from "../../core/channel-dispatch";
import { checkPdf } from "../../core/documents";
import { sniffImage } from "../../core/logo";
import { HttpError, memberCaller, type AppCaller } from "../guards";
import { pageCopyFor } from "../page-copy";
import { PHOTO_MAX_BYTES, preparePhoto } from "./photo-upload";

/** A PDF sent from web chat: the chat refuses bigger ones before sending. */
export const CHAT_PDF_MAX_BYTES = 3 * 1024 * 1024;

export type ChatAttachment = { url: string; messageId: string; name: string; mediaType: string; document: boolean };

const isPdf = (bytes: Uint8Array) => [0x25, 0x50, 0x44, 0x46, 0x2d].every((b, i) => bytes[i] === b);

/**
 * Stores a photo or PDF a member attached in web chat and logs it as their inbound message, as a texted
 * one is, so a quote made from the chat carries it. JPEG, PNG, and HEIC are checked and made ready as on
 * a quote's page; WebP and PDF are kept as sent. The kind comes from the bytes, never the browser's say-so.
 */
export async function storeChatAttachment(caller: AppCaller, file: { name: string; bytes: Uint8Array }): Promise<ChatAttachment> {
  const actor = memberCaller(caller);
  const e = pageCopyFor(caller.language).quotes.errors;
  const { bytes } = file;
  let stored: { bytes: Uint8Array; mimeType: string; name: string };
  let document = false;
  if (isPdf(bytes)) {
    if (bytes.byteLength > CHAT_PDF_MAX_BYTES) throw new HttpError(413, "FILE_TOO_LARGE", "That PDF is too big. Send one under 3 MB.");
    if (!(await checkPdf(bytes)).ok) throw new HttpError(400, "PDF_UNREADABLE", "That PDF can't be opened.");
    stored = { bytes, mimeType: "application/pdf", name: /\.pdf$/i.test(file.name) ? file.name : `${file.name || "document"}.pdf` };
    document = true;
  } else if (sniffImage(bytes) === "webp") {
    if (bytes.byteLength > PHOTO_MAX_BYTES) throw new HttpError(413, "PHOTO_TOO_LARGE", e.photoSize);
    stored = { bytes, mimeType: "image/webp", name: `${file.name.replace(/\.[^.]*$/, "") || "photo"}.webp` };
  } else {
    stored = await preparePhoto(file, e);
  }
  const url = await storeInboundAttachment(stored.name, stored.mimeType, stored.bytes);
  const messageId = await logWebInbound({
    caller: actor,
    attachment: { type: document ? "file" : "image", url, name: stored.name, mimeType: stored.mimeType },
  });
  return { url, messageId, name: stored.name, mediaType: stored.mimeType, document };
}
