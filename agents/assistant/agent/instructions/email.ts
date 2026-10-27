import { defineDynamic, defineInstructions } from "eve/instructions";
import { emailConfigured } from "../../../../core/email";

// Emailing a quote is offered only once email is set up (Resend's key and sending address, or
// EMAIL_FAKE locally). Resolved every turn, since a member's thread is one session that outlives a
// change of settings.
export default defineDynamic({
  events: {
    "turn.started": () =>
      emailConfigured()
        ? defineInstructions({
            content:
              "Email is set up. When asked what you can do, also list emailing a quote to the customer.",
          })
        : null,
  },
});
