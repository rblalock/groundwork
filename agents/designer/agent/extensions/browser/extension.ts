import browser from "@agent-browser/eve";

// A real browser in the designer's sandbox (agents/designer/agent/sandbox/sandbox.ts), for looking at
// the websites members name: their tools are `browser__*`. Page output is fenced, so the model can tell
// a site's words from the member's. The overrides beside this file keep it to looking: no forms,
// uploads, tabs, or network inspection.
export default browser({
  contentBoundaries: true,
  maxOutputChars: 30_000,
  inlineScreenshots: true,
});
