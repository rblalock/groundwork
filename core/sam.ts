// SAM 3.1 segmentation: one noun phrase and one image per call, streamed back as server-sent events
// and decoded with @meta-sam/parser. Several phrases in one call do not work, so `segmentMany` runs
// one call per phrase in parallel. Instead of a phrase, a call can name one object by a box and points
// (`segmentObjects`). scripts/sam-probe.ts prints what a call returns.
import {
  buildObjectPrompt,
  decodeMaskToRaster,
  decodeMaskToSVGPath,
  formats,
  ObjectPromptError,
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

/**
 * Sends one image with one noun phrase or one object prompt (`objectPrompt`), and returns the raw event
 * stream as text. Throws `SAM_FAILED` on an HTTP error.
 */
export async function requestSam(image: SamImage, text: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
  const base = process.env.MODEL_BASE_URL?.trim() || "https://api.meta.ai/v1";
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(`${base}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.META_MODEL_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: SAM_MODEL,
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text }, { type: "input_image", image_url: imageUrl(image) }] }],
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

/** The id an object prompt names its one object by, which the objects found come back under. */
export const PROMPTED_OBJECT = 1;

/** What names one object instead of a phrase: a box around it, and points on it (or, `negative`, off it). Image pixels, `right` and `bottom` exclusive. */
export type SamPrompt = { box?: SamObject["box"]; points?: Array<{ x: number; y: number; negative?: boolean }> };

/**
 * The `input_text` that names one object on a photo of `size`: the box widened to whole pixels, each
 * point rounded down to the pixel it's in, and both kept inside the photo. Throws `BAD_PROMPT` for a
 * prompt with no box and no points, or a box with nothing of the photo inside it.
 */
export function objectPrompt(prompt: SamPrompt, size: SamSize): string {
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  const box = prompt.box && {
    left: clamp(Math.floor(prompt.box.left), size.width),
    top: clamp(Math.floor(prompt.box.top), size.height),
    right: clamp(Math.ceil(prompt.box.right), size.width),
    bottom: clamp(Math.ceil(prompt.box.bottom), size.height),
  };
  const points = (prompt.points ?? []).map(({ x, y, negative }) => ({
    x: clamp(Math.floor(x), size.width - 1),
    y: clamp(Math.floor(y), size.height - 1),
    label: negative ? ("negative" as const) : ("positive" as const),
  }));
  try {
    return buildObjectPrompt({ size, objects: [{ id: PROMPTED_OBJECT, prompts: [{ box, points }] }] });
  } catch (error) {
    if (error instanceof ObjectPromptError) throw new Error(`BAD_PROMPT: ${error.code}`);
    throw error;
  }
}

/**
 * Finds the objects one noun phrase (or one object prompt) names in the image, which is `size` pixels.
 * `images` is what the call was billed for: its `images_processed`, or 1 when the stream left it out.
 */
export async function segment(image: SamImage, phrase: string, opts: SegmentOptions): Promise<{ objects: SamObject[]; images: number; ms: number }> {
  const started = Date.now();
  const { result, usage } = readSamStream(await requestSam(image, phrase, opts));
  const processed = usage?.images_processed;
  const images = typeof processed === "number" && Number.isInteger(processed) && processed >= 0 ? processed : 1;
  return { objects: samObjects(result, opts.size), images, ms: Date.now() - started };
}

/**
 * Finds the one object a box and points name in the image (`objectPrompt`), in one call billed like
 * `segment`'s. Throws `BAD_PROMPT` before any call for a prompt that names nothing.
 */
export async function segmentObjects(image: SamImage, prompt: SamPrompt, opts: SegmentOptions): Promise<{ objects: SamObject[]; images: number; ms: number }> {
  return segment(image, objectPrompt(prompt, opts.size), opts);
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
