import { and, eq, gt, inArray } from "drizzle-orm";
import { conversationEvents, messages } from "../../../schema/schema";
import { signAgentMailWebhook, agentMailWebhookSecret, fakeReceivedEvent, type FakeEmail } from "../../../core/agentmail";
import { db } from "../../../core/db";
import { intakeAgentMailWebhook } from "../../../core/email-intake";
import { drainToken } from "../../../core/worker-token";
import type { EmailBusiness } from "./seed";

// Forwarded emails, end to end against the eval's agent: the signed fake email goes through the webhook's
// own intake (verification, routing, the queue) here, then the agent's Photon drain route hands it to
// the owner's thread, as the webhook route's after() does in the app. The turn's reply is the text the
// fake iMessage transport logs.

export async function forwardEmail(
  target: { url: string },
  business: EmailBusiness,
  email: Pick<FakeEmail, "subject" | "text"> & Partial<FakeEmail>,
): Promise<{ since: Date }> {
  const since = new Date();
  const body = JSON.stringify(await fakeReceivedEvent({ inboxId: business.inbox.inboxId, to: business.inbox.address, from: `Sam Example <${business.ownerEmail}>`, ...email }));
  const intake = await intakeAgentMailWebhook(
    new Request("http://localhost/api/webhooks/agentmail", { method: "POST", body, headers: signAgentMailWebhook(body, agentMailWebhookSecret()!) }),
  );
  if (!intake.queued) throw new Error(`the email was not queued: ${intake.response.status} ${await intake.response.text()}`);
  const drained = await fetch(new URL("/eve/v1/photon/drain", target.url), { method: "POST", headers: { authorization: `Bearer ${drainToken()}` } });
  if (!drained.ok) throw new Error(`the drain route answered ${drained.status}`);
  return { since };
}

/** The owner's turn's end and what it texted them, waiting up to `timeoutMs`. */
export async function emailTurnResult(
  business: EmailBusiness,
  since: Date,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 240_000,
): Promise<{ reply: string; tools: Array<{ name: string; status: string | null }> }> {
  const deadline = Date.now() + timeoutMs;
  const { orgId, memberId } = business.owner;
  while (Date.now() < deadline) {
    const [ended] = await db()
      .select({ id: conversationEvents.id })
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.orgId, orgId),
          eq(conversationEvents.memberId, memberId),
          inArray(conversationEvents.kind, ["turn.completed", "turn.failed", "turn.cancelled"]),
          gt(conversationEvents.createdAt, since),
        ),
      )
      .limit(1);
    if (ended) {
      // The reply is logged just after the turn's end; give it a moment.
      await sleep(2_000);
      const texted = await db()
        .select({ body: messages.body })
        .from(messages)
        .where(and(eq(messages.orgId, orgId), eq(messages.memberId, memberId), eq(messages.direction, "outbound"), gt(messages.createdAt, since)))
        .orderBy(messages.createdAt);
      const tools = await db()
        .select({ name: conversationEvents.toolName, status: conversationEvents.status })
        .from(conversationEvents)
        .where(and(eq(conversationEvents.orgId, orgId), eq(conversationEvents.kind, "tool.completed"), gt(conversationEvents.createdAt, since)));
      return { reply: texted.map((m) => m.body).join("\n"), tools: tools.map((t) => ({ name: t.name ?? "", status: t.status })) };
    }
    await sleep(2_000);
  }
  throw new Error("the forwarded email's turn did not finish in time");
}
