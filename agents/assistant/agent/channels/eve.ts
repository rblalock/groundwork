import type { UserContent } from "ai";
import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";
import { jobTurnContext, webTurnContext } from "../../../../core/channel-dispatch";
import { titleThreadFromMessage } from "../../../../core/jobs";
import { APP_JOB, APP_WEB, resolveCaller } from "../../../../core/members";
import { appWebAuth, jobRuntimeAuth, localDevThread, withUsageAdmission } from "../../../../lib/eve-auth";

// The web app's Assistant page sends into the member's thread here, and its job pages into their
// jobs, signed in with Better Auth (lib/eve-auth.ts). The assistant drives a member's jobs here too,
// with a signed job token (core/jobs.ts). localDevThread() and localDev() stay last for `eve dev`
// and the evals (a member's thread runs as them; anything else as the owner); both resolve to nobody
// in production. A web or job turn gets the same context a text does, server-side.
//
// Each web or job turn is admitted under its business's usage limits in that auth (a 429 when over);
// `withUsageAdmission` gives a reservation back when eve then refuses the request.
//
// A member writing in the web app may attach photos and PDFs (a job photo, a logo, a price sheet), as
// they would text one; the policy below limits the kinds. Turns the assistant drives in a job attach
// nothing, except an email's turn in its thread, which brings the email's attachments. `eve dev` and the evals (local-dev) may attach too, so evals can send a price
// sheet the way a text would reach the model.
const hasFiles = (message: string | UserContent): boolean =>
  typeof message !== "string" && message.some((part) => part.type === "file" || part.type === "image");

const textOf = (message: string | UserContent): string =>
  typeof message === "string" ? message : message.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

export default withUsageAdmission(eveChannel({
  auth: [jobRuntimeAuth(), appWebAuth(), localDevThread(), localDev()],
  turnPolicy: "queue",
  uploadPolicy: { allowedMediaTypes: ["image/png", "image/jpeg", "image/webp", "application/pdf"] },
  async onMessage({ eve }, message) {
    const auth = eve.caller;
    // A member's own web turn, or an email's turn in its thread, may bring files; nothing else on this channel uploads.
    const emailTurn = auth?.authenticator === APP_JOB && auth.attributes.origin === "email";
    const memberTurn = auth?.authenticator === APP_WEB;
    if (hasFiles(message) && auth?.authenticator !== "local-dev" && !emailTurn && !memberTurn) throw new Error("uploads are off on this channel");
    if (auth?.authenticator === APP_JOB) return { auth, context: await jobTurnContext(auth) };
    if (auth?.authenticator !== APP_WEB) return { auth };
    // A thread started on the web as "New thread" is named after the first thing the member writes in it.
    const conversationId = auth.attributes.conversationId;
    if (auth.attributes.conversationKind === "job" && typeof conversationId === "string") {
      const caller = await resolveCaller(auth);
      if (caller) await titleThreadFromMessage(caller, conversationId, textOf(message));
    }
    return { auth, context: await webTurnContext(auth) };
  },
}));
