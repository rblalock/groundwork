import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";
import { designerTurnContext } from "../../../../core/designer";
import { designerWebAuth, withUsageAdmission } from "../../../../lib/eve-auth";

// The page designer's only channel: its conversation in the web app's designer
// (app/(app)/customer-pages/[page]), signed in with Better Auth as an owner or admin
// (lib/eve-auth.ts, `designerWebAuth`). They may attach a logo, a screenshot, or a brand sheet.
// localDev() stays last for `eve dev`; it resolves to nobody in production. Each turn is admitted under
// its business's usage limits, as the assistant's are.
export default withUsageAdmission(eveChannel({
  auth: [designerWebAuth(), localDev()],
  turnPolicy: "queue",
  uploadPolicy: { allowedMediaTypes: ["image/png", "image/jpeg", "image/webp", "application/pdf"] },
  async onMessage({ eve }) {
    const auth = eve.caller;
    return { auth, context: await designerTurnContext(auth) };
  },
}));
