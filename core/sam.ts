// SAM 3.1 segmentation: one noun phrase and one image per call, streamed back as server-sent events
// and decoded with @meta-sam/parser. Several phrases in one call do not work, so `segmentMany` runs
// one call per phrase in parallel. scripts/sam-probe.ts prints what a call returns.
import {
  decodeMaskToRaster,
  decodeMaskToSVGPath,
  formats,
  recordsOfKind,
  type ImageSegmentationResult,
  type ResponseStreamOutcome,
} from "@meta-sam/parser";

/** One object SAM found. Boxes are source pixels with `right` and `bottom` exclusive; `svgPath` is in image coordinates. */
export type SamObject = {
  id: number;
  box: { left: number; top: number; right: number; bottom: number };
  /** Pixels inside the mask. */
  areaPx: number;
  /** 0 to 1, or null when the call left it out. */
  confidence: number | null;
  svgPath: string;
  width: number;
  height: number;
};

export type SamImage = { bytes: Uint8Array; mimeType: string } | { url: string };

/** The SAM deployment: `SAM_MODEL_ID`, or `sam-3.1`. */
export const SAM_MODEL = process.env.SAM_MODEL_ID?.trim() || "sam-3.1";
const TIMEOUT_MS = 30_000;

const imageUrl = (image: SamImage): string =>
  "url" in image ? image.url : `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;

/** Sends one phrase and one image, and returns the raw event stream as text. Throws `SAM_FAILED` on an HTTP error. */
export async function requestSam(image: SamImage, phrase: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
  const base = process.env.MODEL_BASE_URL?.trim() || "https://api.meta.ai/v1";
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(`${base}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.META_MODEL_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: SAM_MODEL,
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: phrase }, { type: "input_image", image_url: imageUrl(image) }] }],
      metadata: { mask_encoding: "lossless", include_confidence: "true" },
    }),
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
  if (!res.ok) throw new Error(`SAM_FAILED: ${res.status}`);
  return res.text();
}

type SseEvent = { type: string; delta?: string; message?: string; response?: { usage?: Record<string, unknown>; error?: { message?: string } | null } };

/**
 * Decodes a recorded event stream into the parser's result, plus the usage from `response.completed`.
 * Throws `SAM_FAILED` when the stream reports an error.
 */
export function readSamStream(sseText: string): { result: ImageSegmentationResult; usage: Record<string, unknown> | undefined } {
  const parser = formats.segmentation.image().createParser();
  let outcome: ResponseStreamOutcome = { status: "incomplete", reason: "eof" };
  let usage: Record<string, unknown> | undefined;
  for (const block of sseText.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    const event = JSON.parse(data) as SseEvent;
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") parser.push(event.delta);
    else if (event.type === "response.failed") throw new Error(`SAM_FAILED: ${event.response?.error?.message ?? "failed"}`);
    else if (event.type === "error") throw new Error(`SAM_FAILED: ${event.message ?? "error"}`);
    else if (event.type === "response.incomplete") outcome = { status: "incomplete", reason: "response" };
    else if (event.type === "response.completed") {
      outcome = { status: "completed" };
      usage = event.response?.usage;
    }
  }
  return { result: parser.finish(outcome).result, usage };
}

/** Moves an absolute M/L path from mask raster coordinates to image coordinates. */
function translatePath(path: string, dx: number, dy: number): string {
  return path.replace(/([ML])(-?[\d.]+) (-?[\d.]+)/g, (_, op: string, x: string, y: string) => `${op}${Number(x) + dx} ${Number(y) + dy}`);
}

/** The photo SAM saw, in pixels. */
export type SamSize = { width: number; height: number };

/**
 * The objects in a decoded result: one per mask, with the box record's box and confidence when there is
 * one. A mask larger than the photo is dropped before it's decoded.
 */
export function samObjects(result: ImageSegmentationResult, size: SamSize): SamObject[] {
  const boxes = new Map(recordsOfKind(result.records, "box").map((box) => [box.objectId, box]));
  return recordsOfKind(result.records, "mask")
    .filter((record) => record.mask.width * record.mask.height <= size.width * size.height)
    .map((record) => {
      const { mask, bounds } = record;
      const box = boxes.get(record.objectId) ?? bounds;
      return {
        id: Number(record.objectId),
        box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
        areaPx: decodeMaskToRaster(mask).reduce((sum, bit) => sum + bit, 0),
        confidence: record.confidence ?? boxes.get(record.objectId)?.confidence ?? null,
        svgPath: translatePath(decodeMaskToSVGPath(mask), bounds.left, bounds.top),
        width: box.right - box.left,
        height: box.bottom - box.top,
      };
    });
}

/** The objects in a recorded event stream, from a photo of `size`. Pure. */
export function parseSamStream(sseText: string, size: SamSize): SamObject[] {
  return samObjects(readSamStream(sseText).result, size);
}

type SegmentOptions = { signal?: AbortSignal; size: SamSize };

/**
 * Finds the objects one noun phrase names in the image, which is `size` pixels. `images` is what the
 * call was billed for: its `images_processed`, or 1 when the stream left it out.
 */
export async function segment(image: SamImage, phrase: string, opts: SegmentOptions): Promise<{ objects: SamObject[]; images: number; ms: number }> {
  const started = Date.now();
  const { result, usage } = readSamStream(await requestSam(image, phrase, opts));
  const processed = usage?.images_processed;
  const images = typeof processed === "number" && Number.isInteger(processed) && processed >= 0 ? processed : 1;
  return { objects: samObjects(result, opts.size), images, ms: Date.now() - started };
}

/**
 * `segment` for each distinct phrase, in parallel, telling `onCall` the images each answered call was
 * billed for. A phrase whose call fails maps to no objects; when every call fails, the first failure is
 * thrown.
 */
export async function segmentMany(
  image: SamImage,
  phrases: string[],
  opts: SegmentOptions & { onCall?: (call: { phrase: string; images: number }) => void },
): Promise<Map<string, SamObject[]>> {
  const distinct = [...new Set(phrases)];
  const settled = await Promise.allSettled(
    distinct.map(async (phrase) => {
      const call = await segment(image, phrase, opts);
      opts.onCall?.({ phrase, images: call.images });
      return call;
    }),
  );
  const failed = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
  if (distinct.length > 0 && failed.length === distinct.length) throw failed[0].reason;
  return new Map(
    distinct.map((phrase, i) => {
      const call = settled[i];
      return [phrase, call.status === "fulfilled" ? call.value.objects : []];
    }),
  );
}
