import { localeFor, type Language } from "./language";

// Digits with optional thousands commas, optional one or two decimals, optional leading "$".
const MONEY = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/** Parse "12", "$12", "12.5", "1,250", "$1,234.56" into integer cents. Anything else is null. */
export function parseMoneyToCents(text: string): number | null {
  const match = MONEY.exec(text.trim());
  if (!match) return null;
  const dollars = Number(match[1].replaceAll(",", ""));
  const cents = match[2] ? Number(match[2].padEnd(2, "0")) : 0;
  const total = dollars * 100 + cents;
  return Number.isSafeInteger(total) ? total : null;
}

export function formatCents(cents: number, language: Language, options: { concise?: boolean } = {}): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat(localeFor(language), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: options.concise && whole ? 0 : 2,
    maximumFractionDigits: options.concise && whole ? 0 : 2,
  }).format(cents / 100);
}

/** `bp` is basis points (700 = 7%). Rounds half up. */
export function percentOf(cents: number, bp: number): number {
  return Math.round((cents * bp) / 10_000);
}
