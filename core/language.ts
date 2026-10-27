export type Language = "en" | "es";

export const LANGUAGES: readonly Language[] = ["en", "es"];

export function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "es";
}

export function localeFor(language: Language): "en-US" | "es-US" {
  return language === "es" ? "es-US" : "en-US";
}

/** Format a `YYYY-MM-DD` calendar date. Uses UTC so the day never shifts with the host time zone. */
export function formatDateOnly(ymd: string, language: Language): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat(localeFor(language), {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}
