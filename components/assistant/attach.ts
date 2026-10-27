// Files a member attaches in the web chat: photos and PDFs, sent to the assistant with their message
// as eve file parts (it sees them as it does a texted photo). A big photo is shrunk here first, so a
// message stays well under what one request can carry.

export type Attached = { name: string; mediaType: string; data: string };

export const ATTACH_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,application/pdf";
export const MAX_ATTACHED = 4;
/** What one message's files may add up to, encoded: one request to the agent carries a few MB at most. */
export const MAX_ATTACHED_CHARS = 3_500_000;
const MAX_PDF_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 2000;

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/** A photo at most `MAX_IMAGE_SIDE` on a side, as a JPEG, when it's bigger than it needs to be. */
async function shrink(file: File): Promise<Attached> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_IMAGE_BYTES) {
    bitmap.close();
    return { name: file.name, mediaType: file.type, data: await readAsDataUrl(file) };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const data = canvas.toDataURL("image/jpeg", 0.85);
  return { name: file.name.replace(/\.[^.]+$/, "") + ".jpg", mediaType: "image/jpeg", data };
}

/** Ready to send, or why not: `TOO_BIG` (a PDF over 3 MB) or `UNSUPPORTED` (not a photo or PDF). */
export async function prepareAttachment(file: File): Promise<Attached | "TOO_BIG" | "UNSUPPORTED"> {
  if (file.type === "application/pdf") {
    if (file.size > MAX_PDF_BYTES) return "TOO_BIG";
    return { name: file.name, mediaType: file.type, data: await readAsDataUrl(file) };
  }
  if (!ATTACH_ACCEPT.split(",").includes(file.type)) return "UNSUPPORTED";
  try {
    return await shrink(file);
  } catch {
    return "UNSUPPORTED";
  }
}
