import { heicToJpeg } from "../../core/images";
import { declaredSizeProblem, sniffImage } from "../../core/logo";
import { HttpError } from "../guards";
import type { pageCopyFor } from "../page-copy";

/** A photo uploaded from a page: one per request, up to 4 MB (Vercel's request limit). */
export const PHOTO_MAX_BYTES = 4 * 1024 * 1024;

type PhotoErrors = Pick<ReturnType<typeof pageCopyFor>["quotes"]["errors"], "photoSize" | "photoType" | "photoDimensions">;

/**
 * A photo uploaded on a quote's or work's page, made ready to store: JPEG or PNG as sent, HEIC (iPhone)
 * turned into JPEG, anything else refused. Its header's declared size is checked before it's stored or
 * decoded, so a small file can't claim a huge canvas.
 */
export async function preparePhoto(file: { name: string; bytes: Uint8Array }, e: PhotoErrors): Promise<{ bytes: Uint8Array; mimeType: string; name: string }> {
  if (file.bytes.byteLength === 0 || file.bytes.byteLength > PHOTO_MAX_BYTES) throw new HttpError(413, "PHOTO_TOO_LARGE", e.photoSize);
  const format = sniffImage(file.bytes);
  if (format !== "jpeg" && format !== "png" && format !== "heic") throw new HttpError(415, "PHOTO_UNSUPPORTED", e.photoType);
  const problem = declaredSizeProblem(file.bytes, format);
  if (problem === "too_large") throw new HttpError(400, "PHOTO_DIMENSIONS", e.photoDimensions);
  if (problem === "unreadable" || problem === "animated") throw new HttpError(400, "PHOTO_UNREADABLE", e.photoType);
  let bytes = file.bytes;
  let mimeType = format === "png" ? "image/png" : "image/jpeg";
  const base = (file.name.replace(/\.[^.]*$/, "").replace(/[^\w .-]+/g, "_").trim() || "photo").slice(0, 80);
  if (format === "heic") {
    try {
      bytes = await heicToJpeg(bytes);
      mimeType = "image/jpeg";
    } catch (error) {
      if (error instanceof Error && error.message === "IMAGE_TOO_LARGE") throw new HttpError(400, "PHOTO_DIMENSIONS", e.photoDimensions);
      throw new HttpError(415, "PHOTO_UNREADABLE", e.photoType);
    }
  }
  return { bytes, mimeType, name: `${base}.${mimeType === "image/png" ? "png" : "jpg"}` };
}
