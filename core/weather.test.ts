import assert from "node:assert/strict";
import { test } from "node:test";
import {
  atRiskWindow,
  dayWeather,
  fakeForecast,
  forecastFor,
  forecastHours,
  setForecasterForTests,
  weatherFake,
  weatherLine,
  weatherLines,
  withinForecast,
  type Forecast,
} from "./weather";

const TZ = "America/New_York";
const DATE = "2026-11-06"; // a Friday; New York is UTC-5
const local = (clock: string, date = DATE) => new Date(`${date}T${clock}:00-05:00`);
const thresholds = { rainPct: 60, heatF: 95 };

/** Friday from 6 AM, hour by hour: the chances of rain and temperatures given, in order. */
function friday(rain: number[], temp: number[] = rain.map(() => 75)): Forecast {
  return rain.map((rainPct, i) => ({ at: new Date(local("06:00").getTime() + i * 3_600_000), rainPct, tempF: temp[i] }));
}

test("weather: a window is at risk by the most rain over it, then by its hottest hour; beyond the forecast is dry", () => {
  //                  6   7   8   9  10  11  12  13  14  15
  const forecast = friday([10, 10, 20, 40, 70, 80, 60, 30, 10, 10], [70, 72, 75, 80, 84, 86, 96, 97, 90, 85]);
  assert.deepEqual(atRiskWindow(forecast, local("08:00"), local("10:00"), thresholds), null, "40% at most, 80°F");
  assert.deepEqual(atRiskWindow(forecast, local("09:30"), local("10:30"), thresholds), { rainPct: 70, tempF: 84, reason: "rain" }, "any hour it overlaps counts");
  assert.deepEqual(atRiskWindow(forecast, local("10:00"), local("13:00"), thresholds), { rainPct: 80, tempF: 96, reason: "rain" }, "rain first");
  assert.deepEqual(atRiskWindow(forecast, local("13:00"), local("14:00"), thresholds), { rainPct: 30, tempF: 97, reason: "heat" });
  assert.deepEqual(atRiskWindow(forecast, local("13:00"), local("14:00"), { rainPct: 60, heatF: 98 }), null, "under a higher heat limit");
  assert.deepEqual(atRiskWindow(forecast, local("08:00"), local("10:00"), { rainPct: 40, heatF: 95 }), { rainPct: 40, tempF: 80, reason: "rain" }, "at the limit counts");
  assert.equal(atRiskWindow(forecast, local("09:00", "2026-11-09"), local("10:00", "2026-11-09"), thresholds), null, "a day it doesn't reach");
  assert.equal(atRiskWindow(forecast, local("10:00"), local("10:00"), thresholds), null, "an empty window");
});

test("weather: a day's line says when rain is likely and the high, in English and Spanish", () => {
  const forecast = friday([10, 10, 20, 40, 70, 80, 60, 30, 10, 10], [70, 72, 75, 80, 84, 86, 84, 83, 80, 78]);
  const day = dayWeather(forecast, DATE, TZ, thresholds);
  assert.ok(day);
  assert.deepEqual([day.rainPct, day.rain?.pct, day.rain?.from.toISOString(), day.rain?.to.toISOString(), day.highF, day.heat], [80, 80, local("10:00").toISOString(), local("13:00").toISOString(), 86, null]);
  assert.equal(weatherLine(day, "2026-11-05", TZ, thresholds, "en"), "Tomorrow: rain 80% 10 AM–1 PM, high 86°F");
  assert.equal(weatherLine(day, DATE, TZ, thresholds, "en"), "Today: rain 80% 10 AM–1 PM, high 86°F");
  assert.equal(weatherLine(day, "2026-11-01", TZ, thresholds, "en"), "Fri, Nov 6: rain 80% 10 AM–1 PM, high 86°F");
  assert.match(weatherLine(day, "2026-11-05", TZ, thresholds, "es"), /^Mañana: lluvia 80% de 10 a\.\s?m\. a 1 p\.\s?m\., máxima 86°F$/);

  const dry = dayWeather(friday([10, 20, 30], [90, 95, 96]), DATE, TZ, thresholds)!;
  assert.equal(weatherLine(dry, DATE, TZ, thresholds, "en"), "Today: rain 30% at most, high 96°F, over the 95°F heat limit");
  assert.equal(dayWeather(forecast, "2026-11-07", TZ, thresholds), null, "a day the forecast doesn't reach");
  assert.deepEqual(
    weatherLines(forecast, { from: "2026-11-05", to: "2026-11-08", today: "2026-11-05", timeZone: TZ, thresholds, language: "en" }).map((l) => l.date),
    [DATE],
    "only the days it reaches",
  );
  assert.equal(withinForecast("2026-11-06", "2026-11-07", "2026-11-05"), true);
  assert.equal(withinForecast("2026-11-09", "2026-11-10", "2026-11-05"), false);
  assert.equal(withinForecast("2026-11-01", "2026-11-05", "2026-11-05"), false, "a range that ended yesterday");
});

test("weather: the fake is dry but for rain at 70% from 10 AM to 2 PM the day after now, 60°F to 85°F", () => {
  const now = local("17:20", "2026-11-05");
  const forecast = fakeForecast(now, TZ);
  assert.equal(forecast.length, 48);
  assert.equal(forecast[0].at.toISOString(), local("17:00", "2026-11-05").toISOString(), "from the hour now is in");
  const wet = forecast.filter((h) => h.rainPct === 70).map((h) => h.at.toISOString());
  assert.deepEqual(wet, ["10:00", "11:00", "12:00", "13:00"].map((c) => local(c).toISOString()));
  assert.ok(forecast.every((h) => h.rainPct === 70 || h.rainPct === 10));
  assert.deepEqual([Math.min(...forecast.map((h) => h.tempF)), Math.max(...forecast.map((h) => h.tempF))], [60, 85]);
  assert.equal(forecast.find((h) => h.at.getTime() === local("15:00").getTime())?.tempF, 85, "warmest at 3 PM");
  assert.equal(weatherLine(dayWeather(forecast, DATE, TZ, thresholds)!, "2026-11-05", TZ, thresholds, "en"), "Tomorrow: rain 70% 10 AM–2 PM, high 85°F");
  assert.deepEqual(fakeForecast(now, TZ), forecast, "the same every time");
});

test("weather: tests get the fake; it's the default locally, never in production, and WEATHER_FAKE=0 asks the real one", async () => {
  assert.equal(process.env.WEATHER_FAKE, "1");
  const now = local("17:00", "2026-11-05");
  const forecast = await forecastFor({ lat: 26.934, lng: -80.129 }, { now, timeZone: TZ });
  assert.deepEqual(forecast, fakeForecast(now, TZ));

  const saved = { fake: process.env.WEATHER_FAKE, vercel: process.env.VERCEL_ENV };
  const set = (fake: string | undefined, vercel: string | undefined) => {
    if (fake === undefined) delete process.env.WEATHER_FAKE;
    else process.env.WEATHER_FAKE = fake;
    if (vercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = vercel;
  };
  try {
    set(undefined, undefined);
    assert.equal(weatherFake(), true);
    set("0", undefined);
    assert.equal(weatherFake(), false);
    set(undefined, "preview");
    assert.equal(weatherFake(), false);
    set("1", "production");
    assert.equal(weatherFake(), false);
  } finally {
    set(saved.fake, saved.vercel);
  }
});

test("weather: a forecast that fails is none, and only the next 48 hours are kept", async () => {
  const now = local("17:30", "2026-11-05");
  const errors: unknown[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    setForecasterForTests(async () => {
      throw new Error("WEATHER_HTTP: 503");
    });
    assert.equal(await forecastFor({ lat: 26.9, lng: -80.1 }, { now }), null);
    assert.equal(errors.length, 1, "logged");
    setForecasterForTests(async () => [-2, -1, 0, 1, 47, 48].map((h) => ({ at: new Date(local("17:00", "2026-11-05").getTime() + h * 3_600_000), rainPct: 0, tempF: 70 })));
    const kept = await forecastFor({ lat: 26.9, lng: -80.1 }, { now });
    assert.equal(kept?.length, 3, "the hour now is in, the next, and the 48th");
  } finally {
    setForecasterForTests(null);
    console.error = log;
  }
});

test("weather: the service's hourly periods become hours, in °F, a missing chance of rain as none", () => {
  const body = {
    properties: {
      periods: [
        { startTime: "2026-11-06T10:00:00-05:00", temperature: 84, temperatureUnit: "F", probabilityOfPrecipitation: { unitCode: "wmoUnit:percent", value: 70 } },
        { startTime: "2026-11-06T11:00:00-05:00", temperature: 30, temperatureUnit: "C", probabilityOfPrecipitation: { value: null } },
        { startTime: "nonsense", temperature: 80 },
      ],
    },
  };
  assert.deepEqual(forecastHours(body), [
    { at: local("10:00"), tempF: 84, rainPct: 70 },
    { at: local("11:00"), tempF: 86, rainPct: 0 },
  ]);
  assert.throws(() => forecastHours({ properties: {} }), /WEATHER_RESPONSE/);
});
