// A feasibility probe of SAM 3.1 segmentation on a yard photo. Sends the image once per noun-phrase
// prompt and prints, per prompt: the call's latency, the objects found, each object's box in source
// pixels, its mask area and edge length in pixels, and its confidence. Writes an overlay of boxes and
// masks on the photo to /tmp/sam-probe/<prompt>.png. `--dump <file>` also writes the first prompt's raw
// event stream to that file (how test-fixtures/sam/ was recorded). Never prints the key.
//   npm run sam:probe
//   npm run sam:probe -- path/or/https-url.jpg "lawn" "mulch bed"
//   npm run sam:probe -- --dump test-fixtures/sam/lawn.stream.txt agents/assistant/evals/fixtures/yard-front.jpg lawn
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { decodeMaskToRaster, recordsOfKind } from "@meta-sam/parser";
import sharp from "sharp";
import { readSamStream, requestSam, samObjects, type SamObject } from "../core/sam";

const OUT_DIR = "/tmp/sam-probe";
const DEFAULT_IMAGE = "agents/assistant/evals/fixtures/yard-front.jpg";
const DEFAULT_PROMPTS = ["lawn", "mulch bed", "hedge", "shrub", "palm tree", "driveway"];
const COLORS = ["#ff3b30", "#0a84ff", "#ffd60a", "#bf5af2", "#30d158", "#ff9f0a", "#64d2ff", "#ff375f"];

async function loadImage(source: string): Promise<{ bytes: Buffer; mime: string }> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
    return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") ?? "image/jpeg" };
  }
  const mime = source.endsWith(".png") ? "image/png" : "image/jpeg";
  return { bytes: readFileSync(source), mime };
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

const slug = (text: string) => text.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

async function writeOverlay(image: Buffer, width: number, height: number, name: string, prompt: string, objects: SamObject[]) {
  const shapes = objects.map((object, index) => {
    const color = COLORS[index % COLORS.length];
    const { left, top, right, bottom } = object.box;
    const label = `${object.id}${object.confidence === null ? "" : ` ${object.confidence.toFixed(2)}`}`;
    return [
      `<path d="${object.svgPath}" fill="${color}" fill-opacity="0.45" fill-rule="evenodd"/>`,
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
  const args = process.argv.slice(2);
  const dumpAt = args.indexOf("--dump");
  const dump = dumpAt === -1 ? undefined : args.splice(dumpAt, 2)[1];
  const [source = DEFAULT_IMAGE, ...rest] = args;
  const prompts = rest.length > 0 ? rest : DEFAULT_PROMPTS;
  mkdirSync(OUT_DIR, { recursive: true });
  // Overlays for the fixture are named by prompt alone; any other image's carry its file name first.
  const prefix = source === DEFAULT_IMAGE ? "" : `${slug(source.split("/").pop()!.replace(/\.[^.]+$/, ""))}-`;

  const { bytes, mime } = await loadImage(source);
  const image = sharp(bytes).rotate();
  const { width = 0, height = 0 } = await image.metadata();
  const upright = await image.toBuffer();
  console.log(`SAM 3.1 on ${source} (${width}×${height}, ${Math.round(upright.length / 1024)} KB)\n`);

  for (const [index, prompt] of prompts.entries()) {
    try {
      const started = Date.now();
      const stream = await requestSam({ bytes: upright, mimeType: mime }, prompt);
      const ms = Date.now() - started;
      if (dump && index === 0) writeFileSync(dump, stream);
      const { result, usage } = readSamStream(stream);
      const objects = samObjects(result);
      const masks = new Map(recordsOfKind(result.records, "mask").map((record) => [Number(record.objectId), record.mask]));
      const file = await writeOverlay(upright, width, height, `${prefix}${slug(prompt)}`, prompt, objects);
      console.log(`"${prompt}"  objects=${objects.length}  ${ms}ms  outcome=${result.outcome.status}  usage=${JSON.stringify(usage ?? null)}`);
      for (const text of recordsOfKind(result.records, "text")) console.log(`  text: ${text.text}`);
      for (const diagnostic of result.diagnostics) console.log(`  ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
      for (const object of objects) {
        const { left, top, right, bottom } = object.box;
        const mask = masks.get(object.id)!;
        const share = ((object.areaPx / (width * height)) * 100).toFixed(1);
        const confidence = object.confidence === null ? "n/a" : object.confidence.toFixed(3);
        console.log(
          `  #${object.id}  box=[${left},${top} → ${right},${bottom}] ${object.width}×${object.height}  area=${object.areaPx}px (${share}%)  edge=${edgeLength(decodeMaskToRaster(mask), mask.width, mask.height)}px  c=${confidence}`,
        );
      }
      console.log(`  overlay ${file}${dump && index === 0 ? `\n  stream ${dump}` : ""}\n`);
    } catch (error) {
      console.log(`FAIL  "${prompt}"  ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

await main();
