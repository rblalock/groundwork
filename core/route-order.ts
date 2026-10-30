// The order a crew's stops could be driven in, from the yard and back: nearest-neighbor, then a two-opt pass
// that uncrosses the route while it gets shorter. Pure: places in, an order out, minutes from `driveMinutes`.
// Enough at a crew's size (a handful of stops a day). It only suggests; booked visits keep their times.
import { DEFAULT_DRIVE, driveMinutes, type DriveSettings, type Point } from "./places";

/** Minutes to drive from the yard through `places` in order and back to the yard. */
export function routeDriveMinutes(yard: Point, places: Point[], settings: DriveSettings = DEFAULT_DRIVE): number {
  let total = 0;
  let from = yard;
  for (const place of places) {
    total += driveMinutes(from, place, settings);
    from = place;
  }
  return total + (places.length > 0 ? driveMinutes(from, yard, settings) : 0);
}

/**
 * The stops in the order that drives least, as far as nearest-neighbor from the yard and a two-opt pass find:
 * the nearest stop next each time (the earlier one on a tie), then any stretch reversed while that makes the
 * whole loop shorter. Returns the stops themselves, reordered; the same order when nothing is shorter.
 */
export function suggestOrder<T extends { place: Point }>(yard: Point, stops: T[], settings: DriveSettings = DEFAULT_DRIVE): T[] {
  if (stops.length < 3) return [...stops];
  // Index 0 is the yard; stop i is index i + 1.
  const points = [yard, ...stops.map((s) => s.place)];
  const minutes = points.map((a) => points.map((b) => driveMinutes(a, b, settings)));

  const tour = [0];
  const left = new Set(stops.map((_, i) => i + 1));
  while (left.size > 0) {
    const from = tour[tour.length - 1];
    let next = -1;
    for (const i of left) if (next === -1 || minutes[from][i] < minutes[from][next]) next = i;
    tour.push(next);
    left.delete(next);
  }
  tour.push(0);

  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < tour.length - 2; i++) {
      for (let k = i + 1; k < tour.length - 1; k++) {
        const before = minutes[tour[i - 1]][tour[i]] + minutes[tour[k]][tour[k + 1]];
        const after = minutes[tour[i - 1]][tour[k]] + minutes[tour[i]][tour[k + 1]];
        if (after < before) {
          tour.splice(i, k - i + 1, ...tour.slice(i, k + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return tour.slice(1, -1).map((i) => stops[i - 1]);
}
