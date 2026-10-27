import type { EveMessage } from "eve/client";
import type { TextedJson } from "./pages/assistant";

// The Assistant page's thread: the member's eve session, with what the assistant texted them on its own
// (logged in `messages`, not part of the session) placed between its messages by time.

type EventShape = { type: string; meta?: { at?: string; id?: string }; data?: { turnId?: unknown; sequence?: unknown } };

/**
 * When each session message happened, from the stream's event times, so the assistant's own texts can
 * go between them. A member's message is when it was received; a reply is when its turn last moved, so
 * a PDF the turn texted lands before the reply that follows it, as it did in iMessage. A message still
 * on its way sorts last. The result never goes backwards, so the session keeps its own order.
 */
export function messageTimes(messages: readonly EveMessage[], events: readonly unknown[]): number[] {
  const received = new Map<string, number>();
  const turnFirst = new Map<string, number>();
  const turnLast = new Map<string, number>();
  for (const event of events as readonly EventShape[]) {
    const at = Date.parse(event.meta?.at ?? "");
    if (!Number.isFinite(at)) continue;
    const turnId = typeof event.data?.turnId === "string" ? event.data.turnId : null;
    // eve names a received message `${event id}:user` (or `${turn}:${sequence}:user` on older streams).
    if (event.type === "message.received") received.set(`${event.meta?.id ?? `${turnId}:${String(event.data?.sequence)}`}:user`, at);
    if (turnId) {
      if (!turnFirst.has(turnId)) turnFirst.set(turnId, at);
      turnLast.set(turnId, Math.max(turnLast.get(turnId) ?? at, at));
    }
  }
  let floor = Number.NEGATIVE_INFINITY;
  return messages.map((message) => {
    const turnId = message.metadata?.turnId;
    const pending = message.metadata?.optimistic || message.metadata?.status === "streaming" || message.metadata?.status === "submitted";
    const at = pending
      ? Number.POSITIVE_INFINITY
      : message.role === "user"
        ? (received.get(message.id) ?? (turnId ? turnFirst.get(turnId) : undefined))
        : turnId
          ? turnLast.get(turnId)
          : undefined;
    floor = Math.max(floor, at ?? floor);
    return floor;
  });
}

export type ThreadItem = { kind: "message"; message: EveMessage } | { kind: "texted"; texted: TextedJson };

/** The session's messages with the assistant's own texts between them, by time. */
export function interleave(messages: readonly EveMessage[], times: number[], texted: readonly TextedJson[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  let next = 0;
  messages.forEach((message, index) => {
    while (next < texted.length && Date.parse(texted[next].at) < times[index]) items.push({ kind: "texted", texted: texted[next++] });
    items.push({ kind: "message", message });
  });
  while (next < texted.length) items.push({ kind: "texted", texted: texted[next++] });
  return items;
}
