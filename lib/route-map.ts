// What the Route view's map draws, from the day's plans as the server worked them out (`core/day-plan.ts`):
// the yard, each placed stop numbered in its crew member's booked order, a straight line per crew member from
// the yard through their stops and back, and the shorter order dashed when there is one. A stop whose address
// isn't placed is left off (the list says so). It only draws; nothing here changes a visit.
import type { Place } from "../core/places";
import type { DayPlanJson } from "./pages/schedule";

/** A color per crew member, by their place in the crew list, so a person keeps theirs from day to day. */
export const CREW_COLORS = ["#2563eb", "#9333ea", "#db2777", "#0d9488", "#4f46e5", "#0891b2", "#78716c", "#334155"] as const;

export function crewColor(memberId: string, crew: string[]): string {
  const index = crew.indexOf(memberId);
  return CREW_COLORS[(index < 0 ? crew.length : index) % CREW_COLORS.length];
}

export type LatLng = [lat: number, lng: number];

export type MapMarker = {
  visitId: string;
  memberId: string;
  /** Its place in the crew member's day, counting unplaced stops, so it matches the list. */
  number: number;
  title: string;
  at: LatLng;
  color: string;
  done: boolean;
  /** They'd get there late, or it's the last stop of a day at risk. */
  warn: boolean;
};

export type MapLine = { memberId: string; color: string; points: LatLng[]; /** The shorter order, beside the booked one. */ dashed: boolean };

export type MapPoints = {
  yard: { at: LatLng; label: string } | null;
  markers: MapMarker[];
  lines: MapLine[];
  /** South-west and north-east corners around the yard and every marker; null with nothing placed. */
  bounds: [LatLng, LatLng] | null;
};

const latLng = (place: { lat: number; lng: number }): LatLng => [place.lat, place.lng];

export function mapPoints(plans: DayPlanJson[], yard: Place | null, crew: string[] = plans.map((p) => p.memberId)): MapPoints {
  const markers: MapMarker[] = [];
  const lines: MapLine[] = [];
  const ends = yard ? [latLng(yard)] : [];
  for (const plan of plans) {
    const color = crewColor(plan.memberId, crew);
    const last = plan.stops.length - 1;
    plan.stops.forEach((stop, i) => {
      if (!stop.place) return;
      const done = stop.status === "completed";
      markers.push({
        visitId: stop.visitId,
        memberId: plan.memberId,
        number: i + 1,
        title: stop.title,
        at: latLng(stop.place),
        color,
        done,
        warn: !done && (stop.lateMinutes > 0 || (plan.atRisk && i === last)),
      });
    });
    const route = (stops: Array<{ place: Place | null } | undefined>, dashed: boolean) => {
      const placed = stops.flatMap((s) => (s?.place ? [latLng(s.place)] : []));
      const points = [...ends, ...placed, ...ends];
      if (placed.length > 0 && points.length >= 2) lines.push({ memberId: plan.memberId, color, points, dashed });
    };
    route(plan.stops, false);
    if (plan.suggestedOrder) route(plan.suggestedOrder.map((o) => plan.stops.find((s) => s.visitId === o.visitId)), true);
  }
  const all = [...ends, ...markers.map((m) => m.at)];
  const bounds: [LatLng, LatLng] | null =
    all.length === 0
      ? null
      : [
          [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))],
          [Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))],
        ];
  return { yard: yard ? { at: latLng(yard), label: yard.label } : null, markers, lines, bounds };
}
