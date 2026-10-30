import { test } from "node:test";
import assert from "node:assert/strict";
import type { PricedCandidate } from "../schema/types";
import {
  addToLine,
  applyAssignments,
  boxIou,
  candidatesFrom,
  centeredIn,
  compactPath,
  distinctCandidates,
  drawnCandidate,
  MAX_DRAWN_POINTS,
  polygonArea,
  SAME_OBJECT_IOU,
  selectRegions,
  withKept,
  type PhotoLine,
} from "./priced-photo-select";
import type { SamObject } from "./sam";

// What the probe found on the yard fixture (1024×1024): box, mask area, confidence.
const IMAGE = { width: 1024, height: 1024 };
const obj = (id: number, [left, top, right, bottom]: number[], areaPx: number, confidence: number | null): PricedCandidate => ({
  id: `cand_${id}`,
  phrase: "",
  box: { left, top, right, bottom },
  areaPx,
  confidence,
  svgPath: "",
});
const PROBE = new Map<string, PricedCandidate[]>([
  [
    "lawn",
    [obj(0, [708, 505, 1024, 551], 6857, 0.852), obj(1, [0, 588, 1024, 1024], 407680, 0.942), obj(2, [842, 491, 978, 508], 1372, 0.625)],
  ],
  [
    "hedge",
    [
      obj(0, [856, 481, 890, 500], 543, 0.777),
      obj(1, [0, 494, 444, 645], 43304, 0.91),
      obj(2, [524, 487, 711, 551], 7721, 0.84),
      obj(3, [790, 489, 826, 508], 603, 0.766),
      obj(4, [837, 482, 859, 500], 327, 0.61),
    ],
  ],
  ["palm tree", [obj(0, [820, 382, 882, 466], 3153, 0.879), obj(1, [529, 224, 756, 544], 38656, 0.949)]],
  ["mulch bed", [obj(0, [0, 564, 494, 696], 17054, 0.918), obj(1, [497, 539, 737, 563], 3384, 0.848)]],
  ["sprinkler head", []],
]);

const line = (index: number, name: string, unitKind: PhotoLine["unitKind"], quantity: number, phrase: string | null): PhotoLine => ({
  index,
  itemId: `pbi_${index}`,
  name,
  quantity,
  unitKind,
  unitLabel: "unit",
  totalCents: 1000,
  phrase,
});

test("lawn keeps the front lawn and drops the strip by the mailbox and the one next door", () => {
  const [lawn] = selectRegions([line(0, "Lawn mowing", "visit", 1, "lawn")], PROBE, IMAGE);
  assert.equal(lawn.objects.length, 1);
  assert.deepEqual(lawn.objects[0].box, { left: 0, top: 588, right: 1024, bottom: 1024 });
  assert.equal(lawn.located, true);
});

test("hedge keeps the two largest of five", () => {
  const [hedge] = selectRegions([line(0, "Hedge trimming", "hour", 1, "hedge")], PROBE, IMAGE);
  assert.deepEqual(hedge.objects.map((o) => o.areaPx), [43304, 7721]);
});

test("an each line keeps up to its quantity; the neighbor's small palm stays out", () => {
  const [palms] = selectRegions([line(0, "Palm trimming", "each", 2, "palm tree")], PROBE, IMAGE);
  assert.deepEqual(palms.objects.map((o) => o.areaPx), [38656]);
  const two = new Map([["palm tree", [obj(0, [0, 0, 200, 300], 30000, 0.9), obj(1, [400, 0, 600, 300], 32000, 0.9), obj(2, [700, 0, 900, 300], 31000, 0.9)]]]);
  assert.deepEqual(selectRegions([line(0, "Palm trimming", "each", 2, "palm tree")], two, IMAGE)[0].objects.map((o) => o.areaPx), [32000, 31000]);
});

test("two lines with one phrase share its objects", () => {
  const [mulch, edging] = selectRegions(
    [line(0, "Mulch installed", "each", 3, "mulch bed"), line(1, "Bed edging", "linear_ft", 40, "mulch bed")],
    PROBE,
    IMAGE,
  );
  assert.deepEqual(mulch.objects, edging.objects);
  assert.equal(mulch.objects.length, 2);
});

test("a phrase with no objects, or a line with no phrase, is not located", () => {
  const regions = selectRegions(
    [line(0, "Sprinkler head replacement", "each", 2, "sprinkler head"), line(1, "Haul-away", "flat", 1, null), line(2, "Shrub planting", "each", 1, "shrub")],
    PROBE,
    IMAGE,
  );
  assert.deepEqual(
    regions.map((r) => [r.lineIndex, r.located, r.objects.length]),
    [
      [0, false, 0],
      [1, false, 0],
      [2, false, 0],
    ],
  );
});

test("an unsure object is dropped; one with no confidence is kept", () => {
  const found = new Map([["shrub", [obj(0, [0, 0, 300, 300], 50000, 0.55), obj(1, [400, 0, 700, 300], 40000, null)]]]);
  const [shrub] = selectRegions([line(0, "Shrub planting", "each", 2, "shrub")], found, IMAGE);
  assert.deepEqual(shrub.objects.map((o) => o.confidence), [null]);
});

test("a kept object names the candidate it came from", () => {
  const [lawn] = selectRegions([line(0, "Lawn mowing", "visit", 1, "lawn")], PROBE, IMAGE);
  assert.deepEqual(lawn.objects.map((o) => o.candidateId), ["cand_1"]);
});

test("an outline is rounded to whole pixels and its straight runs and repeats dropped", () => {
  assert.equal(compactPath("M0.5 0L1 0L2 0L3 0.5L3 1L3 2L2.5 3L1 3L0 3Z"), "M1 0L2 0L3 1L3 3L0 3Z");
  assert.equal(compactPath("M0 0L1 0Z"), "", "a sliver with no area is dropped");
});

test("a phrase keeps its twelve largest objects as candidates, and drops one with an outline too long to store", () => {
  const sam = (area: number, svgPath = "M0 0L10 0L10 10Z"): SamObject => ({ id: area, box: { left: 0, top: 0, right: 10, bottom: 10 }, areaPx: area, confidence: 0.9, svgPath, width: 10, height: 10 });
  let n = 0;
  const kept = candidatesFrom("shrub", Array.from({ length: 14 }, (_, i) => sam(i + 1)), () => `cand_${n++}`);
  assert.deepEqual(kept.map((c) => c.areaPx), [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  assert.ok(kept.every((c) => c.phrase === "shrub"));
  const zigzag = `M0 0${Array.from({ length: 20_000 }, (_, i) => `L${i + 1} ${i % 2}`).join("")}Z`;
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(candidatesFrom("lawn", [sam(5, zigzag)], () => "cand_x"), []);
  } finally {
    console.warn = warn;
  }
});

test("assignments set every line's objects; one not listed is on no line", () => {
  const candidates = PROBE.get("hedge")!;
  const regions = selectRegions([line(0, "Hedge trimming", "hour", 1, "hedge"), line(1, "Shrub trimming", "hour", 1, null)], PROBE, IMAGE);
  assert.deepEqual(regions.map((r) => r.located), [true, false]);
  const moved = applyAssignments(candidates, regions, [
    { candidateId: "cand_3", lineIndexes: [1] },
    { candidateId: "cand_1", lineIndexes: [0, 1] },
  ]);
  assert.deepEqual(
    moved.map((r) => [r.located, r.objects.map((o) => o.candidateId)]),
    [
      [true, ["cand_1"]],
      [true, ["cand_1", "cand_3"]],
    ],
  );
  assert.deepEqual(applyAssignments(candidates, regions, []).map((r) => r.located), [false, false]);
  assert.throws(() => applyAssignments(candidates, regions, [{ candidateId: "cand_99", lineIndexes: [0] }]), /UNKNOWN_CANDIDATE/);
  assert.throws(() => applyAssignments(candidates, regions, [{ candidateId: "cand_1", lineIndexes: [2] }]), /UNKNOWN_LINE/);
  assert.throws(() => addToLine(regions, 5, candidates), /UNKNOWN_LINE/);
});

test("an object is inside a box when its middle is", () => {
  const area = { left: 100, top: 100, right: 300, bottom: 300 };
  assert.equal(centeredIn(area, { left: 0, top: 0, right: 400, bottom: 400 }), true, "larger than the box, but centered in it");
  assert.equal(centeredIn(area, { left: 250, top: 250, right: 500, bottom: 500 }), false);
  assert.equal(centeredIn(area, { left: 200, top: 200, right: 400, bottom: 400 }), false, "right and bottom are exclusive");
});

test("two boxes' overlap is their intersection over their union", () => {
  const a = { left: 0, top: 0, right: 10, bottom: 10 };
  assert.equal(boxIou(a, a), 1);
  assert.equal(boxIou(a, { left: 5, top: 0, right: 15, bottom: 10 }), 50 / 150);
  assert.equal(boxIou(a, { left: 20, top: 20, right: 30, bottom: 30 }), 0);
});

test("one object found by two phrases is kept once: the surer one, or the earlier on a tie", () => {
  const as = (c: PricedCandidate, phrase: string) => ({ ...c, phrase });
  const hedge = as(obj(1, [0, 494, 444, 645], 43304, 0.8), "hedge");
  const shrub = as(obj(2, [2, 495, 444, 646], 43000, 0.9), "shrub");
  const bush = as(obj(3, [0, 494, 444, 645], 43304, 0.9), "bush");
  const palm = as(obj(4, [529, 224, 756, 544], 38656, 0.95), "palm tree");
  const hedgeAgain = as(obj(5, [1, 494, 444, 645], 43100, 0.7), "hedge");

  const { kept, same } = distinctCandidates([hedge, palm, shrub, bush, hedgeAgain]);
  assert.deepEqual(kept.map((c) => c.id), ["cand_2", "cand_4"]);
  // The hedge gave way to the surer shrub, which kept its place on a tie with the bush and over a less sure hedge.
  assert.equal(same.get("cand_1"), shrub);
  assert.equal(same.get("cand_3"), shrub);
  assert.equal(same.get("cand_5"), shrub);
  assert.equal(same.size, 3);
  // The same phrase twice is left to its own cap, not merged.
  assert.equal(distinctCandidates([hedge, hedgeAgain]).kept.length, 2);

  const nullFirst = as(obj(6, [0, 494, 444, 645], 43304, null), "hedge");
  assert.deepEqual(distinctCandidates([nullFirst, shrub]).kept.map((c) => c.id), ["cand_2"]);
  // Boxes that overlap less than SAME_OBJECT_IOU stay two objects.
  const half = as(obj(7, [0, 494, 222, 645], 20000, 0.9), "shrub");
  assert.equal(boxIou(hedge.box, half.box) < SAME_OBJECT_IOU, true);
  assert.equal(distinctCandidates([hedge, half]).kept.length, 2);
});

test("a line's objects follow a dropped candidate to the one kept in its place, once", () => {
  const hedge = { ...obj(1, [0, 494, 444, 645], 43304, 0.8), phrase: "hedge" };
  const shrub = { ...obj(2, [2, 495, 444, 646], 43000, 0.9), phrase: "shrub" };
  const regions = selectRegions([line(0, "Hedge trimming", "visit", 1, "hedge")], new Map([["hedge", [hedge]]]), IMAGE);
  const onShrub = addToLine(regions, 0, [shrub]);
  const [moved] = withKept(onShrub, new Map([["cand_1", shrub]]));
  assert.deepEqual(moved.objects.map((o) => o.candidateId), ["cand_2"]);
  assert.equal(moved.located, true);
  // Adding a candidate already on the line doesn't add it twice.
  assert.equal(addToLine([moved], 0, [shrub])[0].objects.length, 1);
});

test("a hand-drawn polygon is a candidate: a closed path in whole pixels, its bounds, and its area", () => {
  const points = [
    { x: 10.4, y: 20.2 },
    { x: 110, y: 20 },
    { x: 110, y: 20 },
    { x: 110.2, y: 80 },
    { x: 10, y: 80 },
    { x: 10, y: 20 },
  ];
  const drawn = drawnCandidate(points, IMAGE, "cand_d", "drawn");
  assert.deepEqual(drawn, {
    id: "cand_d",
    phrase: "drawn",
    box: { left: 10, top: 20, right: 110, bottom: 80 },
    areaPx: 6000,
    confidence: null,
    svgPath: "M10 20L110 20L110 80L10 80Z",
    source: "hand",
  });
  // Either way round, the same area.
  assert.equal(polygonArea([[0, 0], [0, 10], [10, 10], [10, 0]]), 100);
  assert.equal(polygonArea([[0, 0], [4, 0], [0, 3]]), 6);
});

test("a hand-drawn polygon with too few or too many points, off the photo, or too small is refused", () => {
  const square = (side: number) => [
    { x: 0, y: 0 },
    { x: side, y: 0 },
    { x: side, y: side },
    { x: 0, y: side },
  ];
  assert.throws(() => drawnCandidate(square(20).slice(0, 2), IMAGE, "c", "drawn"), /BAD_OUTLINE/);
  // Three taps, two on the same pixel, are two points.
  assert.throws(() => drawnCandidate([{ x: 0, y: 0 }, { x: 0.2, y: 0.1 }, { x: 50, y: 50 }], IMAGE, "c", "drawn"), /BAD_OUTLINE/);
  const many = Array.from({ length: MAX_DRAWN_POINTS + 1 }, (_, i) => ({ x: 500 + 400 * Math.cos(i / 40), y: 500 + 400 * Math.sin(i / 40) }));
  assert.throws(() => drawnCandidate(many, IMAGE, "c", "drawn"), /too many points/);
  assert.ok(drawnCandidate(many.slice(0, MAX_DRAWN_POINTS), IMAGE, "c", "drawn"));
  assert.throws(() => drawnCandidate([...square(20), { x: 1025, y: 10 }], IMAGE, "c", "drawn"), /off the photo/);
  assert.throws(() => drawnCandidate([{ x: -1, y: 0 }, ...square(20).slice(1)], IMAGE, "c", "drawn"), /off the photo/);
  assert.throws(() => drawnCandidate([...square(20), { x: Number.NaN, y: 0 }], IMAGE, "c", "drawn"), /off the photo/);
  // A line, however long, encloses nothing.
  assert.throws(() => drawnCandidate([{ x: 0, y: 0 }, { x: 500, y: 500 }, { x: 1000, y: 1000 }], IMAGE, "c", "drawn"), /too small/);
  assert.throws(() => drawnCandidate(square(9), IMAGE, "c", "drawn"), /too small/);
  assert.equal(drawnCandidate(square(10), IMAGE, "c", "drawn").areaPx, 100);
  // The photo's own edge is on it.
  assert.deepEqual(drawnCandidate(square(1024), IMAGE, "c", "drawn").box, { left: 0, top: 0, right: 1024, bottom: 1024 });
});

test("a hand-drawn outline over an object SAM found gives way to it", () => {
  const sam = { ...obj(0, [0, 588, 1024, 1024], 407680, 0.942), phrase: "lawn" };
  const drawn = drawnCandidate(
    [
      { x: 0, y: 590 },
      { x: 1024, y: 590 },
      { x: 1024, y: 1024 },
      { x: 0, y: 1024 },
    ],
    IMAGE,
    "cand_d",
    "Lawn mowing",
  );
  const { kept, same } = distinctCandidates([sam, drawn]);
  assert.deepEqual(kept, [sam]);
  assert.equal(same.get("cand_d"), sam);
});
