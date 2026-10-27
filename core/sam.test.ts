import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSamStream, segment } from "./sam";

// Recorded with `npm run sam:probe -- --dump test-fixtures/sam/lawn.stream.txt <yard-front.jpg> lawn`.
const LAWN = readFileSync(new URL("../test-fixtures/sam/lawn.stream.txt", import.meta.url), "utf8");
const YARD = new URL("../agents/assistant/evals/fixtures/yard-front.jpg", import.meta.url);

test("parses a recorded lawn stream into its three objects", () => {
  const objects = parseSamStream(LAWN);
  assert.equal(objects.length, 3);
  const largest = objects.reduce((a, b) => (b.areaPx > a.areaPx ? b : a));
  assert.ok(largest.areaPx > 400_000);
  assert.ok(Math.abs((largest.confidence ?? 0) - 0.94) <= 0.01);
  assert.deepEqual(largest.box, { left: 0, top: 588, right: 1024, bottom: 1024 });
  assert.equal(largest.width, 1024);
  assert.equal(largest.height, 436);
});

test("moves each mask path into image coordinates", () => {
  for (const object of parseSamStream(LAWN)) {
    const ys = [...object.svgPath.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2]));
    assert.ok(Math.min(...ys) >= object.box.top - 1);
    assert.ok(Math.max(...ys) <= object.box.bottom);
  }
});

test("a stream that reports a failure throws", () => {
  const failed = `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error: { message: "bad image" } } })}\n\n`;
  assert.throws(() => parseSamStream(failed), /SAM_FAILED/);
});

test("finds the palm tree in the yard photo (live)", { skip: !process.env.META_MODEL_API_KEY }, async () => {
  const { objects } = await segment({ bytes: new Uint8Array(readFileSync(YARD)), mimeType: "image/jpeg" }, "palm tree");
  assert.ok(objects.length >= 1);
});
