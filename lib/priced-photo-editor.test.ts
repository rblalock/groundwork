import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAssignment, assignmentsOf, closesAt, sketchPath, type PricedCandidate, type PricedRegion } from "./priced-photo-editor";

const candidate = (id: string, overrides: Partial<PricedCandidate> = {}): PricedCandidate => ({
  id,
  phrase: "shrub",
  box: { left: 10, top: 20, right: 110, bottom: 220 },
  areaPx: 12_000,
  confidence: 0.8,
  svgPath: "M10 20 L110 20 L110 220 Z",
  ...overrides,
});

const region = (lineIndex: number, candidateIds: Array<string | null> = []): PricedRegion => ({
  lineIndex,
  itemId: null,
  name: `Line ${lineIndex}`,
  quantity: 1,
  unitLabel: "each",
  totalCents: 5000,
  phrase: "shrub",
  objects: candidateIds.map((candidateId) => ({ candidateId, box: { left: 0, top: 0, right: 1, bottom: 1 }, areaPx: 1, confidence: null })),
  located: candidateIds.length > 0,
});

test("assignmentsOf lists each candidate once with every line it is on", () => {
  const regions = [region(0, ["a", "b"]), region(1, []), region(2, ["b", "c"])];
  assert.deepEqual(assignmentsOf(regions), [
    { candidateId: "a", lineIndexes: [0] },
    { candidateId: "b", lineIndexes: [0, 2] },
    { candidateId: "c", lineIndexes: [2] },
  ]);
});

test("assignmentsOf leaves out objects with no candidate and counts a repeat once", () => {
  assert.deepEqual(assignmentsOf([region(0, [null, "a", "a"])]), [{ candidateId: "a", lineIndexes: [0] }]);
  assert.deepEqual(assignmentsOf([]), []);
});

test("applyAssignment puts a candidate on a line with its box, area, and confidence", () => {
  const regions = [region(0), region(1, ["a"])];
  const next = applyAssignment(regions, [candidate("a"), candidate("b", { confidence: null })], "b", 0, true);
  assert.equal(next[0].located, true);
  assert.deepEqual(next[0].objects, [{ candidateId: "b", box: { left: 10, top: 20, right: 110, bottom: 220 }, areaPx: 12_000, confidence: null }]);
  assert.equal(next[1], regions[1], "other lines are untouched");
  assert.equal(regions[0].objects.length, 0, "the old regions are not changed");
});

test("applyAssignment does not add a candidate to a line twice", () => {
  const next = applyAssignment([region(0, ["a"])], [candidate("a")], "a", 0, true);
  assert.equal(next[0].objects.length, 1);
  assert.equal(next[0].objects[0].areaPx, 12_000);
});

test("applyAssignment takes a candidate off a line, and the line is not located once it is empty", () => {
  const regions = [region(0, ["a", "b"]), region(1, ["a"])];
  const once = applyAssignment(regions, [candidate("a"), candidate("b")], "a", 0, false);
  assert.deepEqual(
    once[0].objects.map((o) => o.candidateId),
    ["b"],
  );
  assert.equal(once[0].located, true);
  assert.deepEqual(assignmentsOf(once), [
    { candidateId: "b", lineIndexes: [0] },
    { candidateId: "a", lineIndexes: [1] },
  ]);
  const empty = applyAssignment(once, [candidate("a"), candidate("b")], "a", 1, false);
  assert.equal(empty[1].located, false);
  assert.deepEqual(empty[1].objects, []);
});

test("applyAssignment ignores a candidate it doesn't know", () => {
  const regions = [region(0)];
  assert.equal(applyAssignment(regions, [], "missing", 0, true), regions);
});

test("the outline being drawn follows the pointer, and closes on its first point", () => {
  const points = [
    { x: 10, y: 10 },
    { x: 100.04, y: 10 },
    { x: 100, y: 80 },
  ];
  assert.equal(sketchPath([], null, false), "");
  assert.equal(sketchPath(points.slice(0, 1), { x: 50, y: 50 }, false), "M10 10L50 50");
  assert.equal(sketchPath(points, { x: 12, y: 75.25 }, false), "M10 10L100 10L100 80L12 75.3");
  assert.equal(sketchPath(points, { x: 12, y: 75 }, true), "M10 10L100 10L100 80Z");
  assert.equal(closesAt(points, { x: 14, y: 13 }, 5), true);
  assert.equal(closesAt(points, { x: 20, y: 10 }, 5), false);
  assert.equal(closesAt(points.slice(0, 2), { x: 10, y: 10 }, 5), false, "two points don't close");
});
