import { localeFor, type Language } from "../core/language";
import { formatCents } from "../core/money";

// Display formatting for the business pages. Dates show in the business's own time zone, so the
// owner and the crew see the same day whatever their browser says.

export function money(cents: number | null | undefined, language: Language): string {
  return cents === null || cents === undefined ? "—" : formatCents(cents, language);
}

export function formatDate(date: Date | string, language: Language, timeZone: string): string {
  return new Intl.DateTimeFormat(localeFor(language), { timeZone, month: "short", day: "numeric", year: "numeric" }).format(
    new Date(date),
  );
}

export function formatDateTime(date: Date | string, language: Language, timeZone: string): string {
  return new Intl.DateTimeFormat(localeFor(language), {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

/** A US number as (305) 555-0142; anything else as stored. */
export function formatPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return national.length === 10 ? `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}` : e164;
}

/** A quantity without float noise: 2.5, not 2.5000000001. */
export function quantity(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** "8 PM" style labels for quiet-hour selects. */
export function hourLabel(hour: number, language: Language): string {
  return new Intl.DateTimeFormat(localeFor(language), { hour: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, 0, 1, hour)),
  );
}

/** A `YYYY-MM-DD` calendar date as "Oct 18, 2026", the same anywhere. */
export function formatDateOnlyShort(ymd: string, language: Language): string {
  return new Intl.DateTimeFormat(localeFor(language), { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(
    new Date(`${ymd}T12:00:00Z`),
  );
}
