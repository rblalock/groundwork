// One-off: generates the yard photo the landscaping photo evals send, with Meta's image model, and saves
// it as a JPEG under 500 KB next to this file. The model returns 1600 px whatever size is asked, so the
// photo is scaled down with sharp (installed with Next). Never prints the key.
//   node --env-file=.env.local node_modules/.bin/tsx agents/assistant/evals/fixtures/generate-yard-photo.ts
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

const OUT = resolve(import.meta.dirname, "yard-front.jpg");
const PROMPT =
  "Photo of a suburban Florida front yard: St. Augustine lawn, two mulched beds along the house with hedges, " +
  "a sabal palm, concrete driveway, midday sun, realistic.";

const key = process.env.META_MODEL_API_KEY?.trim();
if (!key) throw new Error("META_MODEL_API_KEY is not set.");
const base = process.env.MODEL_BASE_URL?.trim() || "https://api.meta.ai/v1";

const response = await fetch(`${base}/images/generations`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "muse-image-1.0", prompt: PROMPT, n: 1, size: "1024x1024", output_format: "jpeg" }),
});
if (!response.ok) throw new Error(`Image generation failed: ${response.status} ${await response.text()}`);
const body = (await response.json()) as { data?: Array<{ b64_json?: string }> };
const encoded = body.data?.[0]?.b64_json;
if (!encoded) throw new Error("Image generation returned no image.");

const jpeg = await sharp(Buffer.from(encoded, "base64")).resize(1024, 1024, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
if (jpeg.length > 500_000) throw new Error(`The photo is ${jpeg.length} bytes, over 500 KB.`);
await writeFile(OUT, jpeg);
console.log(`Saved ${OUT} (${Math.round(jpeg.length / 1024)} KB).`);
