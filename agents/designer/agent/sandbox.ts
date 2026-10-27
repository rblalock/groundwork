import { installAgentBrowser } from "@agent-browser/eve/sandbox";
import { DefaultSandbox, defineSandbox } from "eve/sandbox";

// The designer's own sandbox (Vercel Sandbox on Vercel, Docker locally), with agent-browser and Chromium
// installed when the environment is prepared, so a session's first look at a website doesn't wait on an
// install. The browser extension (extensions/browser), read_brand, and look_at_page drive it. The version
// is written here, matching @agent-browser/eve in package.json, because changing this code is what makes
// eve prepare the environment again.
export const environment = DefaultSandbox.environment({
  prepare: async (sandbox) => {
    await installAgentBrowser(sandbox, { installSpec: "agent-browser@0.39.2" });
  },
  vercel: { resources: { vcpus: 2 } },
});

export default defineSandbox(() => environment.open());
