import assert from "node:assert/strict";
import { test } from "node:test";
import { lastAttachedImage } from "./attached-image";

const png = Buffer.from("89504e470d0a1a0a", "hex");
const other = Buffer.from("ffd8ffe0", "hex");

test("the logo is the image the member attached most recently, in any inline form", () => {
  const user = (content: unknown) => ({ role: "user", content }) as never;
  assert.equal(lastAttachedImage([]), null);
  assert.equal(lastAttachedImage([user("use my logo")]), null);
  assert.deepEqual(Buffer.from(lastAttachedImage([user([{ type: "file", mediaType: "image/png", data: png.toString("base64") }])])!), png);
  assert.deepEqual(Buffer.from(lastAttachedImage([user([{ type: "file", mediaType: "image/png", data: `data:image/png;base64,${png.toString("base64")}` }])])!), png);
  assert.deepEqual(Buffer.from(lastAttachedImage([user([{ type: "image", image: new Uint8Array(png) }])])!), png);
  assert.deepEqual(Buffer.from(lastAttachedImage([user([{ type: "file", mediaType: "image", data: { type: "data", data: png } }])])!), png);
  // The newest wins, a later message's over an earlier one's.
  assert.deepEqual(Buffer.from(lastAttachedImage([user([{ type: "image", image: png }]), user([{ type: "text", text: "no, this one" }, { type: "image", image: other }])])!), other);
});

test("never a tool's image, a PDF, or a remote URL", () => {
  const messages = [
    { role: "user", content: [{ type: "file", mediaType: "application/pdf", data: png }] },
    { role: "user", content: [{ type: "image", image: new URL("https://example.com/logo.png") }] },
    { role: "user", content: [{ type: "file", mediaType: "image/png", data: "https://example.com/logo.png" }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "read_brand", output: { type: "content", value: [{ type: "media", data: png.toString("base64"), mediaType: "image/png" }] } }] },
    { role: "assistant", content: [{ type: "file", mediaType: "image/png", data: png }] },
  ] as never;
  assert.equal(lastAttachedImage(messages), null);
});
