// Places and drive times. An address is placed once, when it's saved: a property's, and the yard's (the
// business profile's address). v1 asks the US Census geocoder, which needs no key; a paid one can replace
// it behind `geocode`. Placing never guesses: no match (or more than one far apart) is `not_found`, an
// error is `failed`, and either leaves the place out of drive math. Placing is fail-soft: it never throws
// to the save that asked for it.
//
// A drive is the straight-line distance times a road factor at a town speed, rounded up to 5 minutes.
// No road graph: a crew's day is one county, and the number only has to be honest to the quarter hour.
// `PLACES_FAKE=1` answers from a small table of made-up points and never touches the network.
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { businessProfile, properties } from "../schema/schema";
import { db, type Db, type Tx } from "./db";

export type Point = { lat: number; lng: number };
/** A placed address: where it is, and the address it matched. */
export type Place = Point & { label: string };
export type GeocodeStatus = (typeof properties.$inferSelect)["geocodeStatus"];

/** How drives are estimated: `roadFactorBp` 13000 is 1.3 times the straight line, at `townMph`, never under `minDriveMinutes`. */
export type DriveSettings = { roadFactorBp: number; townMph: number; minDriveMinutes: number };
export const DEFAULT_DRIVE: DriveSettings = { roadFactorBp: 13_000, townMph: 28, minDriveMinutes: 5 };
/** The longest a visit's buffer may be (`visits_buffers`). */
export const MAX_DRIVE_MINUTES = 480;

const EARTH_METERS = 6_371_000;
const METERS_PER_MILE = 1609.344;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** The great-circle distance between two points, in meters. */
export function haversineMeters(a: Point, b: Point): number {
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Whole minutes to drive from `a` to `b`: the straight line times the road factor at the town speed, rounded
 * up to 5, never under the minimum nor over `MAX_DRIVE_MINUTES`. The same point is no drive.
 */
export function driveMinutes(a: Point, b: Point, settings: DriveSettings = DEFAULT_DRIVE): number {
  const meters = haversineMeters(a, b);
  if (meters < 1) return 0;
  const roadMeters = (meters * settings.roadFactorBp) / 10_000;
  const metersPerMinute = (settings.townMph * METERS_PER_MILE) / 60;
  const minutes = Math.ceil(roadMeters / metersPerMinute / 5) * 5;
  return Math.min(Math.max(minutes, settings.minDriveMinutes), MAX_DRIVE_MINUTES);
}

/** A stop on a crew member's day: when it starts, and its place (null when it couldn't be placed). */
export type Stop = { startAt: Date; place: Place | null };
/** One drive: its minutes, and the other end's address (`yard` when it's the yard). */
export type Leg = { minutes: number; label: string; yard: boolean };

/**
 * The drives around a visit at `at` on one crew member's day: from the stop before it (the latest one
 * starting earlier, else the yard) and to the stop after it (the first one starting later, else back to the
 * yard). A side is null when either end is unplaced: it's left out, never guessed.
 */
export function legsAround(
  at: Stop,
  stops: Stop[],
  yard: Place | null,
  settings: DriveSettings = DEFAULT_DRIVE,
): { before: Leg | null; after: Leg | null } {
  let previous: Stop | null = null;
  let next: Stop | null = null;
  for (const stop of stops) {
    const t = stop.startAt.getTime();
    if (t < at.startAt.getTime() && (!previous || t > previous.startAt.getTime())) previous = stop;
    if (t > at.startAt.getTime() && (!next || t < next.startAt.getTime())) next = stop;
  }
  const leg = (other: Place | null, isYard: boolean): Leg | null =>
    at.place && other ? { minutes: driveMinutes(other, at.place, settings), label: other.label, yard: isYard } : null;
  return {
    before: previous ? leg(previous.place, false) : leg(yard, true),
    after: next ? leg(next.place, false) : leg(yard, true),
  };
}

/**
 * The drives to hold around a visit at `at` for its whole crew, `crewStops` being each one's other stops that
 * day: the longest drive in and the longest drive out, since the visit starts when the last of them arrives.
 * A side is null when it can't be estimated for someone (an unplaced end), or there's no crew.
 */
export function crewDrives(
  at: Stop,
  crewStops: Stop[][],
  yard: Place | null,
  settings: DriveSettings = DEFAULT_DRIVE,
): { before: number | null; after: number | null } {
  if (crewStops.length === 0) return { before: null, after: null };
  const legs = crewStops.map((stops) => legsAround(at, stops, yard, settings));
  const longest = (side: "before" | "after") =>
    legs.every((l) => l[side]) ? Math.max(...legs.map((l) => (l[side] as Leg).minutes)) : null;
  return { before: longest("before"), after: longest("after") };
}

/** The business profile's drive settings. */
export function driveSettingsOf(profile: Pick<typeof businessProfile.$inferSelect, "roadFactorBp" | "townMph" | "minDriveMinutes">): DriveSettings {
  return { roadFactorBp: profile.roadFactorBp, townMph: profile.townMph, minDriveMinutes: profile.minDriveMinutes };
}

/** The yard, when the profile's address is placed. */
export function yardOf(profile: Pick<typeof businessProfile.$inferSelect, "address" | "yardLat" | "yardLng">): Place | null {
  return profile.address && profile.yardLat !== null && profile.yardLng !== null
    ? { lat: profile.yardLat, lng: profile.yardLng, label: profile.address }
    : null;
}

/** A row's place, when it has one. */
export function placeOf(row: { lat: number | null; lng: number | null }, label: string): Place | null {
  return row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng, label } : null;
}

// ---------------------------------------------------------------------------------------------
// Geocoding

/** The fake geocoder with `PLACES_FAKE=1`, and locally when it's unset; never in production. `PLACES_FAKE=0` asks the real one. */
export function placesFake(): boolean {
  if (process.env.VERCEL_ENV === "production") return false;
  const flag = process.env.PLACES_FAKE;
  if (flag === "1") return true;
  if (flag === "0") return false;
  return !process.env.VERCEL_ENV;
}

/** Made-up points around Tequesta, Florida, for the seeded addresses; keyed by the address's first words. */
const FAKE_PLACES: Array<{ key: string; lat: number; lng: number; label: string }> = [
  { key: "100 bridge rd", lat: 26.934, lng: -80.129, label: "100 Bridge Rd, Tequesta, FL 33469" },
  { key: "412 oak st", lat: 26.9617, lng: -80.0942, label: "412 Oak St, Tequesta, FL 33469" },
  { key: "12 oak st", lat: 26.9655, lng: -80.089, label: "12 Oak St, Tequesta, FL 33469" },
  { key: "7 pine ave", lat: 26.9452, lng: -80.0815, label: "7 Pine Ave, Tequesta, FL 33469" },
  { key: "40 pine ave", lat: 26.9441, lng: -80.083, label: "40 Pine Ave, Tequesta, FL 33469" },
  { key: "4 elm rd", lat: 26.976, lng: -80.1105, label: "4 Elm Rd, Tequesta, FL 33469" },
];

const foldAddress = (address: string) =>
  address
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function fakeGeocode(address: string): Place | null {
  const folded = foldAddress(address);
  const found = FAKE_PLACES.find((p) => folded === p.key || folded.startsWith(`${p.key} `));
  return found ? { lat: found.lat, lng: found.lng, label: found.label } : null;
}

const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const TIMEOUT_MS = 5000;
/** Matches farther apart than this are different places: the address is ambiguous, and isn't placed. */
const SAME_PLACE_METERS = 200;

type CensusMatch = { matchedAddress?: string; coordinates?: { x?: number; y?: number } };

async function censusGeocode(address: string): Promise<Place | null> {
  const url = `${CENSUS_URL}?${new URLSearchParams({ address, benchmark: "Public_AR_Current", format: "json" })}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Groundwork (field-service scheduling)", Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GEOCODER_HTTP: ${response.status}`);
  const body = (await response.json()) as { result?: { addressMatches?: CensusMatch[] } };
  const matches = body.result?.addressMatches;
  if (!Array.isArray(matches)) throw new Error("GEOCODER_RESPONSE");
  const places = matches.flatMap((m) =>
    typeof m.coordinates?.x === "number" && typeof m.coordinates?.y === "number"
      ? [{ lat: m.coordinates.y, lng: m.coordinates.x, label: m.matchedAddress ?? address }]
      : [],
  );
  const [first] = places;
  if (!first || places.some((p) => haversineMeters(first, p) > SAME_PLACE_METERS)) return null;
  return first;
}

let geocoderForTests: ((address: string) => Promise<Place | null>) | null = null;

/** Tests only: answer `geocode` with this instead (null puts the fake or the real one back). */
export function setGeocoderForTests(fn: ((address: string) => Promise<Place | null>) | null): void {
  geocoderForTests = fn;
}

/** Where an address is: its point and matched address, null when there's no single match. Throws when the geocoder fails. */
export async function geocode(address: string): Promise<Place | null> {
  const text = address.trim();
  if (!text) return null;
  if (geocoderForTests) return geocoderForTests(text);
  if (placesFake()) return fakeGeocode(text);
  return censusGeocode(text);
}

/** `geocode`, never throwing: the place and how it went. */
async function tryGeocode(address: string): Promise<{ status: GeocodeStatus; place: Place | null }> {
  try {
    const place = await geocode(address);
    return { status: place ? "ok" : "not_found", place };
  } catch (error) {
    console.error("places: geocoding failed", error instanceof Error ? error.message : error);
    return { status: "failed", place: null };
  }
}

/**
 * Places one property of the business and saves how it went. Fail-soft: returns the status, never throws.
 * The address is matched again on save, so a place found for an address since changed is dropped.
 */
export async function placeProperty(orgId: string, propertyId: string, executor: Db | Tx = db()): Promise<GeocodeStatus | null> {
  try {
    const [row] = await executor
      .select({ address: properties.address })
      .from(properties)
      .where(and(eq(properties.orgId, orgId), eq(properties.id, propertyId)));
    if (!row) return null;
    const { status, place } = await tryGeocode(row.address);
    await executor
      .update(properties)
      .set({ lat: place?.lat ?? null, lng: place?.lng ?? null, placeLabel: place?.label ?? null, geocodeStatus: status, geocodedAt: new Date() })
      .where(and(eq(properties.orgId, orgId), eq(properties.id, propertyId), eq(properties.address, row.address)));
    return status;
  } catch (error) {
    console.error("places: the property wasn't placed", error);
    return null;
  }
}

/**
 * Places the business's yard (its profile address) and saves how it went; with no address it's cleared back to
 * `pending`. Fail-soft, like `placeProperty`. Doesn't touch the profile's version: quotes don't depend on it.
 */
export async function placeYard(orgId: string, executor: Db | Tx = db()): Promise<GeocodeStatus | null> {
  try {
    const [row] = await executor.select({ address: businessProfile.address }).from(businessProfile).where(eq(businessProfile.orgId, orgId));
    if (!row) return null;
    const cleared = { yardLat: null, yardLng: null, yardPlaceLabel: null };
    if (!row.address) {
      await executor
        .update(businessProfile)
        .set({ ...cleared, yardGeocodeStatus: "pending", yardGeocodedAt: null })
        .where(and(eq(businessProfile.orgId, orgId), sql`${businessProfile.address} is null`));
      return "pending";
    }
    const { status, place } = await tryGeocode(row.address);
    await executor
      .update(businessProfile)
      .set(
        place
          ? { yardLat: place.lat, yardLng: place.lng, yardPlaceLabel: place.label, yardGeocodeStatus: status, yardGeocodedAt: new Date() }
          : { ...cleared, yardGeocodeStatus: status, yardGeocodedAt: new Date() },
      )
      .where(and(eq(businessProfile.orgId, orgId), eq(businessProfile.address, row.address)));
    return status;
  } catch (error) {
    console.error("places: the yard wasn't placed", error);
    return null;
  }
}

/**
 * Places every property and yard not placed yet (`pending`, and `failed` to try again; `not_found` only with
 * `retryNotFound`), one business or all. For `npm run places:backfill`. Returns the counts by status.
 */
export async function placeUnplaced(
  options: { orgId?: string; retryNotFound?: boolean } = {},
): Promise<Record<GeocodeStatus | "skipped", number>> {
  const statuses: GeocodeStatus[] = options.retryNotFound ? ["pending", "failed", "not_found"] : ["pending", "failed"];
  const counts: Record<GeocodeStatus | "skipped", number> = { pending: 0, ok: 0, not_found: 0, failed: 0, skipped: 0 };
  const tally = (status: GeocodeStatus | null) => (counts[status ?? "skipped"] += 1);
  const yards = await db()
    .select({ orgId: businessProfile.orgId })
    .from(businessProfile)
    .where(
      and(
        isNotNull(businessProfile.address),
        inArray(businessProfile.yardGeocodeStatus, statuses),
        ...(options.orgId ? [eq(businessProfile.orgId, options.orgId)] : []),
      ),
    );
  for (const { orgId } of yards) tally(await placeYard(orgId));
  const rows = await db()
    .select({ id: properties.id, orgId: properties.orgId })
    .from(properties)
    .where(and(inArray(properties.geocodeStatus, statuses), ...(options.orgId ? [eq(properties.orgId, options.orgId)] : [])));
  for (const row of rows) tally(await placeProperty(row.orgId, row.id));
  return counts;
}
