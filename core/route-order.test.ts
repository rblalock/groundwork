import assert from "node:assert/strict";
import { test } from "node:test";
import { driveMinutes, type Place } from "./places";
import { routeDriveMinutes, suggestOrder } from "./route-order";

const at = (lat: number, lng: number, label: string): Place => ({ lat, lng, label });

// Stops a twentieth of a degree apart going north from the yard: 10 minutes between neighbors.
const yard = at(26.9, -80.1, "yard");
const a = at(26.95, -80.1, "A");
const b = at(27.0, -80.1, "B");
const c = at(27.05, -80.1, "C");
const d = at(27.1, -80.1, "D");

test("route minutes: from the yard through each stop in order and back", () => {
  assert.equal(driveMinutes(yard, a), 10);
  assert.equal(driveMinutes(a, c), 20);
  assert.equal(routeDriveMinutes(yard, [a, b, c, d]), 10 + 10 + 10 + 10 + 40);
  assert.equal(routeDriveMinutes(yard, [a, c, b, d]), 10 + 20 + 10 + 20 + 40);
  assert.equal(routeDriveMinutes(yard, []), 0);
});

test("suggested order: nearest first from the yard, uncrossed, and the same stops back", () => {
  const stops = [c, a, d, b].map((place) => ({ place, id: place.label }));
  const order = suggestOrder(yard, stops);
  assert.deepEqual(order.map((s) => s.id), ["A", "B", "C", "D"]);
  assert.equal(routeDriveMinutes(yard, order.map((s) => s.place)), 80);
  assert.deepEqual(stops.map((s) => s.id), ["C", "A", "D", "B"], "the stops given aren't reordered in place");
});

test("suggested order: two-opt fixes what nearest-neighbor gets wrong", () => {
  // Nearest-neighbor takes the two close stops north, then crosses south and back up to the far one.
  const near1 = at(26.95, -80.13, "N1");
  const near2 = at(26.95, -80.12, "N2");
  const south = at(26.84, -80.14, "S");
  const far = at(27.0, -80.0, "F");
  const stops = [near1, near2, south, far].map((place) => ({ place, id: place.label }));
  assert.equal(routeDriveMinutes(yard, [near1, near2, south, far]), 115, "the greedy order");
  const order = suggestOrder(yard, stops);
  assert.equal(routeDriveMinutes(yard, order.map((s) => s.place)), 100);
  assert.deepEqual(order.map((s) => s.id), ["S", "N2", "N1", "F"]);
});

test("suggested order: two stops or fewer stay as they are", () => {
  const stops = [b, a].map((place) => ({ place }));
  assert.deepEqual(suggestOrder(yard, stops), stops);
  assert.deepEqual(suggestOrder(yard, []), []);
});
