/**
 * The web app's public origin, for links that leave the app (an invoice's pay link on its PDF). The same
 * order Better Auth uses: `BETTER_AUTH_URL`, then Vercel's production or deployment URL, then local dev.
 */
export function appOrigin(): string {
  const set = process.env.BETTER_AUTH_URL?.trim();
  if (set) return new URL(set).origin;
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}
