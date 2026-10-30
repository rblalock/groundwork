// The forecast, by hour, for the yard's grid point: the chance of rain and the temperature, from api.weather.gov
// (the US National Weather Service; no key, a User-Agent with a contact). A point's grid is asked once per process;
// its hourly forecast is kept for half an hour. Fetching is fail-soft: a failure is logged and there's no forecast,
// so nothing is said about the weather and nothing is proposed. The code reads the forecast against the business's
// thresholds (`atRiskWindow`, `dayWeather`); the assistant only relays the lines it writes.
//
// `WEATHER_FAKE=1` answers with a fixed forecast and never touches the network: dry, except rain at 70% from 10 AM to
// 2 PM local on the day after `now`, so a demo shows a proposal the evening before.
import { businessProfile } from "../schema/schema";
import type { Language } from "./language";
import { yardOf, type Point } from "./places";
import { dayText, timeText, wallClock } from "./scheduling-time";
import { addDays, localParts } from "./time";

/** One hour of the forecast, from `at`: the chance of rain in percent, and the temperature in °F. */
export type ForecastHour = { at: Date; rainPct: number; tempF: number };
export type Forecast = ForecastHour[];

/** When a stop is at risk: the chance of rain at or over `rainPct`, or the temperature at or over `heatF`. */
export type WeatherThresholds = { rainPct: number; heatF: number };
export const DEFAULT_THRESHOLDS: WeatherThresholds = { rainPct: 60, heatF: 95 };

/** How far ahead the forecast reaches. */
export const FORECAST_HOURS = 48;

const HOUR = 3_600_000;
const TIMEOUT_MS = 5000;
const POINTS_URL = "https://api.weather.gov/points";
/** How long an hourly forecast is used before it's asked for again. */
const FORECAST_TTL_MS = 30 * 60_000;

/** The business's thresholds. */
export function thresholdsOf(profile: Pick<typeof businessProfile.$inferSelect, "rainThresholdPct" | "heatThresholdF">): WeatherThresholds {
  return { rainPct: profile.rainThresholdPct, heatF: profile.heatThresholdF };
}

// ---------------------------------------------------------------------------------------------
// Reading a forecast

const hourEnd = (hour: ForecastHour) => hour.at.getTime() + HOUR;

/** The forecast's hours that overlap `[startAt, endAt)`. */
function hoursOver(forecast: Forecast, startAt: Date, endAt: Date): ForecastHour[] {
  return forecast.filter((hour) => hour.at.getTime() < endAt.getTime() && hourEnd(hour) > startAt.getTime());
}

/**
 * Whether a visit from `startAt` to `endAt` is at risk: the most rain and the hottest hour over its window, and why
 * (rain first). Pure. Null when it's under both thresholds, or the forecast doesn't reach it: beyond it counts as dry.
 */
export function atRiskWindow(
  forecast: Forecast,
  startAt: Date,
  endAt: Date,
  thresholds: WeatherThresholds,
): { rainPct: number; tempF: number; reason: "rain" | "heat" } | null {
  const hours = hoursOver(forecast, startAt, endAt);
  if (hours.length === 0) return null;
  const rainPct = Math.max(...hours.map((h) => h.rainPct));
  const tempF = Math.max(...hours.map((h) => h.tempF));
  if (rainPct >= thresholds.rainPct) return { rainPct, tempF, reason: "rain" };
  if (tempF >= thresholds.heatF) return { rainPct, tempF, reason: "heat" };
  return null;
}

/** A local day's weather: the most rain and when it's at or over the threshold, and the high. */
export type DayWeather = {
  date: string;
  /** The most rain in any hour of the day the forecast covers. */
  rainPct: number;
  /** From the first hour at or over the rain threshold to the end of the last; null when none is. */
  rain: { from: Date; to: Date; pct: number } | null;
  highF: number;
  /** The first hour at or over the heat threshold to the end of the last; null when none is. */
  heat: { from: Date; to: Date; highF: number } | null;
};

/** One local day of the forecast, read against the thresholds. Pure. Null when the forecast doesn't reach the day. */
export function dayWeather(forecast: Forecast, date: string, timeZone: string, thresholds: WeatherThresholds): DayWeather | null {
  const hours = forecast.filter((hour) => wallClock(hour.at, timeZone).date === date);
  if (hours.length === 0) return null;
  const span = (over: ForecastHour[]) => (over.length ? { from: over[0].at, to: new Date(hourEnd(over[over.length - 1])) } : null);
  const wet = hours.filter((h) => h.rainPct >= thresholds.rainPct);
  const hot = hours.filter((h) => h.tempF >= thresholds.heatF);
  const rain = span(wet);
  const heat = span(hot);
  const highF = Math.max(...hours.map((h) => h.tempF));
  return {
    date,
    rainPct: Math.max(...hours.map((h) => h.rainPct)),
    rain: rain && { ...rain, pct: Math.max(...wet.map((h) => h.rainPct)) },
    highF,
    heat: heat && { ...heat, highF },
  };
}

/** "today", "tomorrow", else the date ("Sat, Nov 7"), from `today`. */
export function weatherDayWord(date: string, today: string, language: Language): string {
  if (date === today) return language === "es" ? "hoy" : "today";
  if (date === addDays(today, 1)) return language === "es" ? "mañana" : "tomorrow";
  return dayText(date, language);
}

/** "10 AM–2 PM". */
export const spanText = (span: { from: Date; to: Date }, timeZone: string, language: Language) =>
  `${timeText(span.from, timeZone, language)}–${timeText(span.to, timeZone, language)}`;

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A day's weather in one line, ready to send: "Tomorrow: rain 70% 10 AM–2 PM, high 84°F", or "Today: rain 10% at
 * most, high 84°F"; a high at or over the heat threshold says so.
 */
export function weatherLine(day: DayWeather, today: string, timeZone: string, thresholds: WeatherThresholds, language: Language): string {
  const word = capitalized(weatherDayWord(day.date, today, language));
  if (language === "es") {
    const rain = day.rain ? `lluvia ${day.rain.pct}% de ${timeText(day.rain.from, timeZone, language)} a ${timeText(day.rain.to, timeZone, language)}` : `lluvia ${day.rainPct}% como mucho`;
    return `${word}: ${rain}, máxima ${day.highF}°F${day.heat ? `, sobre el límite de calor de ${thresholds.heatF}°F` : ""}`;
  }
  const rain = day.rain ? `rain ${day.rain.pct}% ${spanText(day.rain, timeZone, language)}` : `rain ${day.rainPct}% at most`;
  return `${word}: ${rain}, high ${day.highF}°F${day.heat ? `, over the ${thresholds.heatF}°F heat limit` : ""}`;
}

/** The lines for the days from `from` to `to` (exclusive) the forecast reaches, in order. */
export function weatherLines(
  forecast: Forecast,
  input: { from: string; to: string; today: string; timeZone: string; thresholds: WeatherThresholds; language: Language },
): Array<{ date: string; line: string }> {
  const lines: Array<{ date: string; line: string }> = [];
  for (let date = input.from; date < input.to; date = addDays(date, 1)) {
    const day = dayWeather(forecast, date, input.timeZone, input.thresholds);
    if (day) lines.push({ date, line: weatherLine(day, input.today, input.timeZone, input.thresholds, input.language) });
  }
  return lines;
}

/**
 * The schedule's weather lines for the days from `from` to `to` (exclusive) the forecast reaches, at the yard. None
 * when no day is within its reach, the yard isn't placed, or there's no forecast.
 */
export async function scheduleWeather(
  profile: Pick<typeof businessProfile.$inferSelect, "timeZone" | "address" | "yardLat" | "yardLng" | "rainThresholdPct" | "heatThresholdF">,
  input: { from: string; to: string; today: string; language: Language; now?: Date },
): Promise<Array<{ date: string; line: string }>> {
  const yard = yardOf(profile);
  if (!yard || !withinForecast(input.from, input.to, input.today)) return [];
  const forecast = await forecastFor(yard, { now: input.now, timeZone: profile.timeZone });
  if (!forecast) return [];
  return weatherLines(forecast, { ...input, timeZone: profile.timeZone, thresholds: thresholdsOf(profile) });
}

/** Whether any of the days from `from` to `to` (exclusive) is within the forecast's reach of `today`. */
export function withinForecast(from: string, to: string, today: string): boolean {
  return from <= addDays(today, Math.ceil(FORECAST_HOURS / 24)) && to > today;
}

// ---------------------------------------------------------------------------------------------
// Getting one

/** The fake forecast with `WEATHER_FAKE=1`, and locally when it's unset; never in production. `WEATHER_FAKE=0` asks the real one. */
export function weatherFake(): boolean {
  if (process.env.VERCEL_ENV === "production") return false;
  const flag = process.env.WEATHER_FAKE;
  if (flag === "1") return true;
  if (flag === "0") return false;
  return !process.env.VERCEL_ENV;
}

/**
 * The fake's forecast from the hour `now` is in: rain at 10% and 60°F to 85°F through the day (coolest at 5 AM,
 * warmest at 3 PM), except rain at 70% from 10 AM to 2 PM local on the day after `now`.
 */
export function fakeForecast(now: Date, timeZone: string): Forecast {
  const start = Math.floor(now.getTime() / HOUR) * HOUR;
  const tomorrow = addDays(localParts(now, timeZone).ymd, 1);
  return Array.from({ length: FORECAST_HOURS }, (_, i) => {
    const at = new Date(start + i * HOUR);
    const { ymd, hour } = localParts(at, timeZone);
    // Warming from 5 AM to 3 PM, cooling for the 14 hours after.
    const warmth = hour >= 5 && hour <= 15 ? (hour - 5) / 10 : 1 - ((hour - 15 + 24) % 24) / 14;
    const rainPct = ymd === tomorrow && hour >= 10 && hour < 14 ? 70 : 10;
    return { at, rainPct, tempF: Math.round(60 + 25 * warmth) };
  });
}

const contact = () => process.env.WEATHER_CONTACT?.trim() || "ops@example.com";

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "User-Agent": `Groundwork (${contact()})`, Accept: "application/geo+json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`WEATHER_HTTP: ${response.status}`);
  return response.json();
}

/** Each point's hourly forecast URL, by the point rounded to three places (about 100 m; a grid cell is 2.5 km). */
const grids = new Map<string, string>();
/** Each hourly forecast URL's last answer, and when it was asked. */
const forecasts = new Map<string, { askedAt: number; hours: Forecast }>();

type Period = { startTime?: string; temperature?: number; temperatureUnit?: string; probabilityOfPrecipitation?: { value?: number | null } };

/** The periods of an hourly forecast, as hours: Celsius turned to °F, a missing chance of rain as 0. */
export function forecastHours(body: unknown): Forecast {
  const periods = (body as { properties?: { periods?: Period[] } })?.properties?.periods;
  if (!Array.isArray(periods)) throw new Error("WEATHER_RESPONSE");
  return periods.flatMap((p) => {
    const at = p.startTime ? new Date(p.startTime) : null;
    if (!at || Number.isNaN(at.getTime()) || typeof p.temperature !== "number") return [];
    const tempF = p.temperatureUnit === "C" ? Math.round((p.temperature * 9) / 5 + 32) : Math.round(p.temperature);
    const rain = p.probabilityOfPrecipitation?.value;
    return [{ at, tempF, rainPct: typeof rain === "number" ? Math.round(rain) : 0 }];
  });
}

async function nwsForecast(point: Point, now: Date): Promise<Forecast> {
  const key = `${point.lat.toFixed(3)},${point.lng.toFixed(3)}`;
  let url = grids.get(key);
  if (!url) {
    const body = (await getJson(`${POINTS_URL}/${key}`)) as { properties?: { forecastHourly?: string } };
    url = body?.properties?.forecastHourly;
    if (typeof url !== "string" || !url.startsWith("https://api.weather.gov/")) throw new Error("WEATHER_RESPONSE");
    grids.set(key, url);
  }
  const cached = forecasts.get(url);
  if (cached && Date.now() - cached.askedAt < FORECAST_TTL_MS) return cached.hours;
  const hours = forecastHours(await getJson(url));
  forecasts.set(url, { askedAt: Date.now(), hours });
  return hours;
}

let forecasterForTests: ((point: Point, now: Date) => Promise<Forecast | null>) | null = null;

/** Tests only: answer `forecastFor` with this instead (null puts the fake or the real one back). */
export function setForecasterForTests(fn: ((point: Point, now: Date) => Promise<Forecast | null>) | null): void {
  forecasterForTests = fn;
}

/**
 * The next 48 hours' forecast at a point, from the hour `now` is in. Fail-soft: null when it can't be had (the
 * failure is logged). `timeZone` places the fake's rainy morning; the real forecast doesn't need it.
 */
export async function forecastFor(point: Point, deps: { now?: Date; timeZone?: string } = {}): Promise<Forecast | null> {
  const now = deps.now ?? new Date();
  try {
    const hours = forecasterForTests
      ? await forecasterForTests(point, now)
      : weatherFake()
        ? fakeForecast(now, deps.timeZone ?? "America/New_York")
        : await nwsForecast(point, now);
    if (!hours) return null;
    const from = Math.floor(now.getTime() / HOUR) * HOUR;
    return hours.filter((h) => h.at.getTime() >= from && h.at.getTime() < from + FORECAST_HOURS * HOUR);
  } catch (error) {
    console.error("weather: no forecast", error instanceof Error ? error.message : error);
    return null;
  }
}
