import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ImageSegmentationResult } from "@meta-sam/parser";
import { objectPrompt, parseSamStream, readSamStream, samObjects, segment, segmentObjects } from "./sam";

// Recorded with `npm run sam:probe -- --dump test-fixtures/sam/lawn.stream.txt <yard-front.jpg> lawn`.
const LAWN = readFileSync(new URL("../test-fixtures/sam/lawn.stream.txt", import.meta.url), "utf8");
const YARD = new URL("../agents/assistant/evals/fixtures/yard-front.jpg", import.meta.url);
const SIZE = { width: 1024, height: 1024 };

test("parses a recorded lawn stream into its three objects", () => {
  const objects = parseSamStream(LAWN, SIZE);
  assert.equal(objects.length, 3);
  const largest = objects.reduce((a, b) => (b.areaPx > a.areaPx ? b : a));
  assert.ok(largest.areaPx > 400_000);
  assert.ok(Math.abs((largest.confidence ?? 0) - 0.94) <= 0.01);
  assert.deepEqual(largest.box, { left: 0, top: 588, right: 1024, bottom: 1024 });
  assert.equal(largest.width, 1024);
  assert.equal(largest.height, 436);
});

test("moves each mask path into image coordinates", () => {
  for (const object of parseSamStream(LAWN, SIZE)) {
    const ys = [...object.svgPath.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2]));
    assert.ok(Math.min(...ys) >= object.box.top - 1);
    assert.ok(Math.max(...ys) <= object.box.bottom);
  }
});

test("drops a mask larger than the photo without decoding it", () => {
  const { result } = readSamStream(LAWN);
  const real = result.records.find((record) => record.kind === "mask")!;
  // A payload that can't decode: reaching the decoder would throw.
  const oversized = { ...real, objectId: "99", mask: { encoding: "lossless", payload: "!", width: 100_000, height: 100_000 } };
  const objects = samObjects({ ...result, records: [...result.records, oversized] } as ImageSegmentationResult, SIZE);
  assert.deepEqual(objects.map((o) => o.id), parseSamStream(LAWN, SIZE).map((o) => o.id));
});

test("a stream that reports a failure throws", () => {
  const failed = `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error: { message: "bad image" } } })}\n\n`;
  assert.throws(() => parseSamStream(failed, SIZE), /SAM_FAILED/);
});

test("an object prompt names one object by a box with inclusive edges, in whole pixels inside the photo", () => {
  assert.equal(objectPrompt({ box: { left: 525, top: 225, right: 760, bottom: 548 } }, SIZE), "<0f>1<|box;x1=525;y1=225;x2=759;y2=547;w=1024;h=1024|>");
  // Widened to whole pixels and kept on the photo.
  assert.equal(objectPrompt({ box: { left: -3.5, top: 10.4, right: 99.2, bottom: 2000 } }, SIZE), "<0f>1<|box;x1=0;y1=10;x2=99;y2=1023;w=1024;h=1024|>");
});

test("an object prompt's points follow its box, a negative one with a leading minus", () => {
  const prompt = objectPrompt(
    {
      box: { left: 10, top: 20, right: 40, bottom: 60 },
      points: [
        { x: 20.7, y: 40.2 },
        { x: 1024, y: 30, negative: true },
      ],
    },
    SIZE,
  );
  assert.equal(prompt, "<0f>1<|box;x1=10;y1=20;x2=39;y2=59;w=1024;h=1024|><|point;x=20;y=40;w=1024;h=1024|>-<|point;x=1023;y=30;w=1024;h=1024|>");
});

test("an object prompt that names nothing is refused before any call", async () => {
  assert.throws(() => objectPrompt({}, SIZE), /BAD_PROMPT/);
  assert.throws(() => objectPrompt({ box: { left: 1100, top: 0, right: 1200, bottom: 50 } }, SIZE), /BAD_PROMPT/);
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("no call"))) as typeof fetch;
  try {
    await assert.rejects(segmentObjects({ url: "https://example.com/yard.jpg" }, { points: [] }, { size: SIZE }), /BAD_PROMPT/);
  } finally {
    globalThis.fetch = real;
  }
});

test("segmentObjects sends the object prompt in place of a phrase", async () => {
  const real = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const content = JSON.parse(String(init?.body)).input[0].content;
    sent.push(...content.filter((part: { type: string }) => part.type === "input_text").map((part: { text: string }) => part.text));
    return new Response(LAWN, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const { objects, images } = await segmentObjects({ url: "https://example.com/yard.jpg" }, { box: { left: 0, top: 588, right: 1024, bottom: 1024 } }, { size: SIZE });
    assert.deepEqual(sent, ["<0f>1<|box;x1=0;y1=588;x2=1023;y2=1023;w=1024;h=1024|>"]);
    assert.equal(objects.length, 3);
    assert.equal(images, 1);
  } finally {
    globalThis.fetch = real;
  }
});

test("finds the palm tree in the yard photo (live)", { skip: !process.env.META_MODEL_API_KEY }, async () => {
  const { objects } = await segment({ bytes: new Uint8Array(readFileSync(YARD)), mimeType: "image/jpeg" }, "palm tree", { size: SIZE });
  assert.ok(objects.length >= 1);
});

test("finds the one object a box names in the yard photo (live)", { skip: !process.env.META_MODEL_API_KEY }, async () => {
  const box = { left: 525, top: 225, right: 760, bottom: 548 };
  const { objects, images } = await segmentObjects({ bytes: new Uint8Array(readFileSync(YARD)), mimeType: "image/jpeg" }, { box }, { size: SIZE });
  assert.deepEqual([objects.length, objects[0]?.id, images], [1, 1, 1]);
});
