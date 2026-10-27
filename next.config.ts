import type { NextConfig } from "next";
import { withEve } from "eve/next";
import { CUSTOMER_PAGE_CSP } from "./core/customer-page-csp";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  devIndicators: false,
  // Next would otherwise write its own section into AGENTS.md on every `next dev`.
  agentRules: false,
  // The web app posts sign-in codes through the Photon adapter itself (the agent runs as its own
  // service), so its gRPC client loads from node_modules instead of being bundled.
  serverExternalPackages: ["@photon-ai/chat-adapter-imessage", "@spectrum-ts/imessage", "@spectrum-ts/core"],
  async headers() {
    // A business's own customer pages carry their stricter policy: of two rules setting one header, the later wins.
    const customerPage = [{ key: "Content-Security-Policy", value: CUSTOMER_PAGE_CSP }];
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/q/:token/view", headers: customerPage },
      { source: "/pay/:token/view", headers: customerPage },
    ];
  },
  // Jobs (the assistant's side conversations) are called threads now.
  async redirects() {
    return [
      { source: "/jobs", destination: "/threads", permanent: true },
      { source: "/jobs/:id", destination: "/threads/:id", permanent: true },
    ];
  },
};

// Each agent in agents/<name>/ mounts at /eve/<name>/v1/* on this origin: `next dev` starts an `eve dev`
// for each beside it, and on Vercel withEve adds each agent as a service, with its schedules as crons.
const configure = withEve(nextConfig);

export default async function config(phase: string, context: { defaultConfig: NextConfig }) {
  const configured = await configure(phase, context);
  // Next 16 reads prebuilt rewrites at start; resolving them once starts eve's server for a local
  // `next start`, as development already does.
  if (phase === "phase-production-server" && !process.env.VERCEL) await configured.rewrites?.();
  return configured;
}
