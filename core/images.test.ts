import assert from "node:assert/strict";
import test from "node:test";
import { heicToJpeg, isHeic } from "./images";

test("isHeic matches the iPhone photo types only", () => {
  for (const type of ["image/heic", "image/HEIF", "image/heic-sequence"]) assert.equal(isHeic(type), true);
  for (const type of ["image/jpeg", "image/png", "application/pdf"]) assert.equal(isHeic(type), false);
});

test("heicToJpeg rejects bytes that are not a HEIC photo", async () => {
  await assert.rejects(heicToJpeg(new Uint8Array([1, 2, 3])));
});
