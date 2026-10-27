import type { EveMessage } from "eve/client";
import type { TextedJson } from "./pages/assistant";

// What a conversation's translated view can translate, by id, the same in the browser and on the
// server: each finished text of a session message (`<message id>:<n>`, n counting its non-empty texts),
// and on a member's thread each text the assistant sent them on its own (`texted:<row id>`). The browser
// asks by these ids; the server reads the texts behind them itself (lib/pages/translation.ts).

export type TranslatableItem = { id: string; text: string };

type TextPart = Extract<EveMessage["parts"][number], { type: "text" }>;

/** A message's non-empty texts, in order. */
export const textPartsOf = (message: EveMessage): TextPart[] =>
  message.parts.filter((part): part is TextPart => part.type === "text" && part.text.trim() !== "");

export const messageTextId = (message: EveMessage, n: number) => `${message.id}:${n}`;
export const textedTextId = (texted: Pick<TextedJson, "id">) => `texted:${texted.id}`;

/** The session's finished texts. A text still streaming, or a message not yet sent, waits. */
export function messageItems(messages: readonly EveMessage[]): TranslatableItem[] {
  return messages.flatMap((message) => {
    // An optimistic message is the browser's own copy, not yet in the session.
    if (message.metadata?.optimistic) return [];
    return textPartsOf(message).flatMap((part, n) => (part.state === "streaming" ? [] : [{ id: messageTextId(message, n), text: part.text }]));
  });
}

/** The assistant's own texts on the member's thread. */
export function textedItems(texted: readonly TextedJson[]): TranslatableItem[] {
  return texted.filter((t) => t.text.trim() !== "").map((t) => ({ id: textedTextId(t), text: t.text }));
}
