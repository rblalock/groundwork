// A feasibility probe of SAM 3.1 segmentation on a yard photo. Sends the image once per noun-phrase
// prompt and prints, per prompt: the call's latency, the objects found, each object's box in source
// pixels, its mask area and edge length in pixels, and its confidence. Writes an overlay of boxes and
// masks on the photo to /tmp/sam-probe/<prompt>.png. Never prints the key.
//   npm run sam:probe
//   npm run sam:probe -- path/or/https-url.jpg "lawn" "mulch bed"
import { mkdirSync, readFileSync } from "node:fs";
import {
  decodeMaskToRaster,
  decodeMaskToSVGPath,
  parseImageStream,
  recordsOfKind,
  type ImageSegmentationResult,
} from "@meta-sam/parser";
import sharp from "sharp";

const OUT_DIR = "/tmp/sam-probe";
const DEFAULT_IMAGE = "agents/assistant/evals/fixtures/yard-front.jpg";
const DEFAULT_PROMPTS = ["lawn", "mulch bed", "hedge", "shrub", "palm tree", "driveway"];
const COLORS = ["#ff3b30", "#0a84ff", "#ffd60a", "#bf5af2", "#30d158", "#ff9f0a", "#64d2ff", "#ff375f"];

type Usage = Record<string, unknown> | undefined;

type ObjectResult = {
  id: string;
  box: { left: number; top: number; right: number; bottom: number };
  area: number;
  perimeter: number;
  confidence?: number;
  // The mask raster is H×W and sits at `origin` inside the frame; `path` is in raster coordinates.
  origin: { x: number; y: number };
  path: string;
};

async function loadImage(source: string): Promise<{ bytes: Buffer; mime: string }> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
    return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") ?? "image/jpeg" };
  }
  const mime = source.endsWith(".png") ? "image/png" : "image/jpeg";
  return { bytes: readFileSync(source), mime };
}

// Reads a server-sent event body into the JSON events the parser consumes. Captures usage from
// response.completed on the way through.
async function* sseEvents(body: ReadableStream<Uint8Array>, onUsage: (usage: Usage) => void): AsyncGenerator<{ type: string }> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as { type: string; response?: { usage?: Usage } };
      if (event.type === "response.completed") onUsage(event.response?.usage);
      yield event;
    }
  }
}

async function segment(imageUrl: string, prompt: string): Promise<{ result: ImageSegmentationResult; ms: number; usage: Usage }> {
  const base = process.env.MODEL_BASE_URL?.trim() || "https://api.meta.ai/v1";
  const started = Date.now();
  const res = await fetch(`${base}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.META_MODEL_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "sam-3.1",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_image", image_url: imageUrl }] }],
      metadata: { mask_encoding: "lossless", include_confidence: "true" },
    }),
  });
  if (!res.ok || !res.body) throw new Error(`SAM request failed: ${res.status} ${await res.text()}`);
  let usage: Usage;
  const result = await parseImageStream(sseEvents(res.body, (u) => (usage = u))).finalResult;
  return { result, ms: Date.now() - started, usage };
}

// Counts the unit pixel edges between mask and not-mask. A staircase length: it overstates a diagonal
// edge by up to √2.
function edgeLength(raster: Uint8Array, width: number, height: number): number {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : raster[y * width + x]);
  let edges = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!at(x, y)) continue;
      edges += (at(x - 1, y) ? 0 : 1) + (at(x + 1, y) ? 0 : 1) + (at(x, y - 1) ? 0 : 1) + (at(x, y + 1) ? 0 : 1);
    }
  }
  return edges;
}

function objectsOf(result: ImageSegmentationResult): ObjectResult[] {
  const boxes = new Map(recordsOfKind(result.records, "box").map((box) => [box.objectId, box]));
  return recordsOfKind(result.records, "mask").map((record) => {
    const { mask, bounds } = record;
    const raster = decodeMaskToRaster(mask);
    const box = boxes.get(record.objectId) ?? bounds;
    return {
      id: record.objectId,
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      area: raster.reduce((sum, bit) => sum + bit, 0),
      perimeter: edgeLength(raster, mask.width, mask.height),
      confidence: record.confidence ?? boxes.get(record.objectId)?.confidence,
      origin: { x: bounds.left, y: bounds.top },
      path: decodeMaskToSVGPath(mask),
    };
  });
}

const slug = (text: string) => text.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

async function writeOverlay(image: Buffer, width: number, height: number, name: string, prompt: string, objects: ObjectResult[]) {
  const shapes = objects.map((object, index) => {
    const color = COLORS[index % COLORS.length];
    const { left, top, right, bottom } = object.box;
    const label = `${object.id}${object.confidence === undefined ? "" : ` ${object.confidence.toFixed(2)}`}`;
    return [
      `<path d="${object.path}" transform="translate(${object.origin.x} ${object.origin.y})" fill="${color}" fill-opacity="0.45" fill-rule="evenodd"/>`,
      `<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" fill="none" stroke="${color}" stroke-width="3"/>`,
      `<text x="${left + 4}" y="${top + 20}" font-family="sans-serif" font-size="18" font-weight="bold" fill="#fff" stroke="#000" stroke-width="0.8">${label}</text>`,
    ].join("");
  });
  const title = `<text x="10" y="${height - 12}" font-family="sans-serif" font-size="24" font-weight="bold" fill="#fff" stroke="#000" stroke-width="1">"${prompt}": ${objects.length}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes.join("")}${title}</svg>`;
  const file = `${OUT_DIR}/${name}.png`;
  await sharp(image).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(file);
  return file;
}

async function main() {
  if (!process.env.META_MODEL_API_KEY) {
    console.log("FAIL  META_MODEL_API_KEY is not set");
    process.exit(1);
  }
  const [source = DEFAULT_IMAGE, ...rest] = process.argv.slice(2);
  const prompts = rest.length > 0 ? rest : DEFAULT_PROMPTS;
  mkdirSync(OUT_DIR, { recursive: true });
  // Overlays for the fixture are named by prompt alone; any other image's carry its file name first.
  const prefix = source === DEFAULT_IMAGE ? "" : `${slug(source.split("/").pop()!.replace(/\.[^.]+$/, ""))}-`;

  const { bytes, mime } = await loadImage(source);
  const image = sharp(bytes).rotate();
  const { width = 0, height = 0 } = await image.metadata();
  const upright = await image.toBuffer();
  const imageUrl = `data:${mime};base64,${upright.toString("base64")}`;
  console.log(`SAM 3.1 on ${source} (${width}×${height}, ${Math.round(upright.length / 1024)} KB)\n`);

  for (const prompt of prompts) {
    try {
      const { result, ms, usage } = await segment(imageUrl, prompt);
      const objects = objectsOf(result);
      const file = await writeOverlay(upright, width, height, `${prefix}${slug(prompt)}`, prompt, objects);
      console.log(`"${prompt}"  objects=${objects.length}  ${ms}ms  outcome=${result.outcome.status}  usage=${JSON.stringify(usage ?? null)}`);
      for (const text of recordsOfKind(result.records, "text")) console.log(`  text: ${text.text}`);
      for (const diagnostic of result.diagnostics) console.log(`  ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
      for (const object of objects) {
        const { left, top, right, bottom } = object.box;
        const share = ((object.area / (width * height)) * 100).toFixed(1);
        const confidence = object.confidence === undefined ? "n/a" : object.confidence.toFixed(3);
        console.log(
          `  #${object.id}  box=[${left},${top} → ${right},${bottom}] ${right - left}×${bottom - top}  area=${object.area}px (${share}%)  edge=${object.perimeter}px  c=${confidence}`,
        );
      }
      console.log(`  overlay ${file}\n`);
    } catch (error) {
      console.log(`FAIL  "${prompt}"  ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

await main();
