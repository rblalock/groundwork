// Tests and evals must never reach Photon, Resend, Stripe, AgentMail, or the geocoder, whatever `.env.local` holds: a sign-in
// code or a quote texted from a test would go to a real phone, a checkout would hit a real Stripe account, and an
// inbox would be made on a real AgentMail account. `forceOffline()` switches every outside service the
// app texts or emails through to its fake, and blanks the real credentials so nothing can fall back to
// them. Blank, not deleted: env-file loaders (Node's `--env-file`, `eve dev`) never overwrite a variable
// that is already set, so an empty one stays empty.

/** The variables `forceOffline` sets, and their values. */
export const OFFLINE_ENV = {
  IMESSAGE_FAKE: "1",
  PHOTON_ADMIN_FAKE: "1",
  IMESSAGE_PROJECT_ID: "",
  IMESSAGE_PROJECT_SECRET: "",
  RESEND_API_KEY: "",
  EMAIL_FROM: "",
  STRIPE_FAKE: "1",
  STRIPE_SECRET_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
  AGENTMAIL_FAKE: "1",
  AGENTMAIL_API_KEY: "",
  AGENTMAIL_WEBHOOK_SECRET: "",
  PLACES_FAKE: "1",
} as const;

export function forceOffline(): void {
  Object.assign(process.env, OFFLINE_ENV);
}
