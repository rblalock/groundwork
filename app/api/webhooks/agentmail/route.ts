import { after } from "next/server";
import { requestDrain } from "@/core/drain";
import { intakeAgentMailWebhook } from "@/core/email-intake";

export const runtime = "nodejs";

/**
 * AgentMail's webhook: an email a member forwarded to their business's inbox. The signature is checked
 * against the raw body before anything is read, and the email is stored in the inbound queue before
 * AgentMail gets its answer; a failure inside is a 500, so AgentMail delivers the event again. Right
 * after answering, the queue runs (the every-minute backstop also would).
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const { response, queued } = await intakeAgentMailWebhook(request);
    if (queued) after(() => requestDrain("email webhook"));
    return response;
  } catch (error) {
    console.error("agentmail webhook failed", error);
    return Response.json({ error: "Not handled. Try again." }, { status: 500 });
  }
}
