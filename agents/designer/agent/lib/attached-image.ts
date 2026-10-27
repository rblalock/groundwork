import type { ToolContext } from "eve/tools";

// The image the member attached most recently in this conversation, as bytes: what set_logo means by
// "this logo". Only the member's own messages count, never a tool's output, so a website's picture or
// a screenshot the designer took can't become the logo. Attachments arrive inline (base64, bytes, or a
// data: URL); an image only reachable by a remote URL isn't fetched.

type Part = { type?: unknown; image?: unknown; data?: unknown; mediaType?: unknown };

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof URL) return value.protocol === "data:" ? bytesOf(value.href) : null;
  if (typeof value === "string") {
    const data = value.match(/^data:[^,]*;base64,(.*)$/s);
    if (data) return Buffer.from(data[1], "base64");
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
    return Buffer.from(value, "base64");
  }
  if (value && typeof value === "object") {
    const tagged = value as { type?: unknown; data?: unknown; url?: unknown };
    if (tagged.type === "data") return bytesOf(tagged.data);
    if (tagged.type === "url") return bytesOf(tagged.url);
  }
  return null;
}

function imageOf(part: Part): Uint8Array | null {
  if (part.type === "image") return bytesOf(part.image);
  if (part.type === "file" && typeof part.mediaType === "string" && /^image(\/|$)/i.test(part.mediaType)) return bytesOf(part.data);
  return null;
}

export function lastAttachedImage(messages: ToolContext["messages"]): Uint8Array | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user" || typeof message.content === "string") continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const bytes = imageOf(message.content[j] as Part);
      if (bytes?.length) return bytes;
    }
  }
  return null;
}
