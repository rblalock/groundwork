import { createHmac, timingSafeEqual } from "node:crypto";

// The every-minute backstop (agents/assistant/agent/schedules/texts.ts) asks the Photon channel's drain route to work
// through the inbound queue: it's a channel route because only a channel route can hand a turn to a
// member's eve session. The schedule signs a one-minute bearer token with BETTER_AUTH_SECRET, domain-
// separated from the job and sign-in tokens, so nothing else can make the route run.

export const DRAIN_TOKEN_PREFIX = "gwdrain.";
const TTL_MS = 60_000;

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (value) return value;
  if (process.env.VERCEL_ENV === "production") throw new Error("BETTER_AUTH_SECRET must be set.");
  return "local-dev-drain-key";
}

const sign = (exp: string) => createHmac("sha256", secret()).update(`gw-texts-drain:${exp}`).digest("base64url");

export function drainToken(now: number = Date.now()): string {
  const exp = String(now + TTL_MS);
  return `${DRAIN_TOKEN_PREFIX}${exp}.${sign(exp)}`;
}

export function verifyDrainToken(header: string | null, now: number = Date.now()): boolean {
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token?.startsWith(DRAIN_TOKEN_PREFIX)) return false;
  const [exp, signature, extra] = token.slice(DRAIN_TOKEN_PREFIX.length).split(".");
  if (!exp || !signature || extra !== undefined || !/^\d+$/.test(exp) || Number(exp) <= now) return false;
  const expected = Buffer.from(sign(exp));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
