import type { Chat } from "chat";
import { createiMessageAdapter, type iMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { imessage } from "@spectrum-ts/imessage";

export type Bot = Chat<{ imessage: iMessageAdapter }>;
export type Tapback = "thumbs_up" | "heart" | "thumbs_down" | "laugh" | "exclamation" | "question";
export type OutboundFile = { filename: string; mimeType: string; data: Buffer };
export type Transport = {
  postText: typeof postText;
  postFile: typeof postFile;
  addReaction: typeof addReaction;
  openThread?: typeof openThread;
};

const MISSING_CREDENTIALS = "IMESSAGE_PROJECT_ID and IMESSAGE_PROJECT_SECRET must be set to talk to Photon.";

/**
 * The Photon iMessage adapter. Credentials resolve lazily on first use; webhook verification needs the secret.
 * Throws when the project credentials are unset, unless `onMissing: "warn"`: then it logs a warning and returns
 * an adapter whose credentials fail on first use, so the channel module still loads for `eve build` and local dev.
 */
export function createAdapter(options: { onMissing?: "throw" | "warn" } = {}): iMessageAdapter {
  const projectId = process.env.IMESSAGE_PROJECT_ID;
  const projectSecret = process.env.IMESSAGE_PROJECT_SECRET;
  if (fakeTransport() && (!projectId || !projectSecret)) {
    // Local only: a self-host client that points nowhere, so the channel starts and a simulated
    // (locally signed) webhook runs a turn without Photon. Posts print instead (`fakeTransport`).
    return createiMessageAdapter({
      clients: { address: "127.0.0.1:9", phone: "shared", token: "fake" },
      webhookSecret: process.env.IMESSAGE_WEBHOOK_SECRET,
    });
  }
  if (!projectId || !projectSecret) {
    if (options.onMissing !== "warn") throw new Error(MISSING_CREDENTIALS);
    console.warn(`imessage: ${MISSING_CREDENTIALS} The Photon channel will fail on first use.`);
  }
  return createiMessageAdapter({
    credentials: async () => {
      const id = process.env.IMESSAGE_PROJECT_ID ?? projectId;
      const secret = process.env.IMESSAGE_PROJECT_SECRET ?? projectSecret;
      if (!id || !secret) throw new Error(MISSING_CREDENTIALS);
      return { projectId: id, projectSecret: secret };
    },
    webhookSecret: process.env.IMESSAGE_WEBHOOK_SECRET,
  });
}

let bot: Bot | null = null;
let testTransport: Transport | null = null;

/** The channel module registers its Chat instance on load so outbound code can reach the adapter. */
export function registerBot(instance: Bot): void {
  bot = instance;
}

export function getBot(): Bot {
  if (!bot) throw new Error("iMessage bot is not registered");
  return bot;
}

/** Tests replace the transport so nothing needs a registered bot. Pass null to restore the real one. */
export function setTransportForTests(transport: Transport | null): void {
  testTransport = transport;
}

/**
 * Splits on paragraph breaks, then sentence ends, then whitespace, then a hard cut, packing
 * pieces up to `max` characters. Never returns an empty chunk; blank text yields no chunks.
 */
export function chunkText(text: string, max = 1500): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };
  const add = (piece: string, joiner: string) => {
    if (current && current.length + joiner.length + piece.length <= max) current += joiner + piece;
    else {
      flush();
      current = piece;
    }
  };
  for (const paragraph of text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    if (paragraph.length <= max) {
      add(paragraph, "\n\n");
      continue;
    }
    flush();
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/).filter(Boolean)) {
      if (sentence.length <= max) {
        add(sentence, " ");
        continue;
      }
      flush();
      for (const piece of hardSplit(sentence, max)) add(piece, " ");
      flush();
    }
    flush();
  }
  flush();
  return chunks;
}

function hardSplit(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const space = rest.lastIndexOf(" ", max);
    const cut = space > max / 2 ? space : max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(Boolean);
}

let standalone: iMessageAdapter | null = null;

/**
 * The web app runs apart from the agent's runtime, so no channel registers a bot there. It posts
 * through an adapter of its own, which builds its Photon client on first send.
 */
function standaloneAdapter(): iMessageAdapter {
  standalone ??= createAdapter();
  return standalone;
}

let fakeCount = 0;

/**
 * `IMESSAGE_FAKE=1` (local dev only) prints posts, files, and tapbacks to the console instead of
 * sending them, so the web app's sign-in codes and simulated texts can be tried without Photon. Never
 * in production.
 */
function fakeTransport(): boolean {
  return process.env.IMESSAGE_FAKE === "1" && process.env.VERCEL_ENV !== "production";
}

/** Posts plain text, one message per chunk. Returns the SentMessage ids. */
export async function postText(threadId: string, text: string): Promise<string[]> {
  if (testTransport) return testTransport.postText(threadId, text);
  const ids: string[] = [];
  if (fakeTransport()) {
    for (const chunk of chunkText(text)) {
      console.log(`imessage (fake) to ${threadId}: ${chunk}`);
      ids.push(`fake_${Date.now()}_${++fakeCount}`);
    }
    return ids;
  }
  if (!bot) {
    const adapter = standaloneAdapter();
    for (const chunk of chunkText(text)) ids.push((await adapter.postMessage(threadId, chunk)).id);
    return ids;
  }
  const thread = getBot().thread(threadId);
  for (const chunk of chunkText(text)) {
    const sent = await thread.post(chunk);
    ids.push(sent.id);
  }
  return ids;
}

/**
 * Posts a file on its own. Returns the file bubble's id, or null when the adapter gave none. No caption:
 * the Photon adapter sends a caption as its own bubble first and returns only that bubble's id.
 */
export async function postFile(threadId: string, file: OutboundFile): Promise<string | null> {
  if (testTransport) return testTransport.postFile(threadId, file);
  if (fakeTransport()) {
    console.log(`imessage (fake) file to ${threadId}: ${file.filename} (${file.data.length} bytes)`);
    return `fake_${Date.now()}_${++fakeCount}`;
  }
  // The web app has no Chat instance (only the agent's channel registers one), so it posts through the
  // adapter directly, as postText does.
  if (!bot) return (await standaloneAdapter().postMessage(threadId, { markdown: "", files: [file] })).id || null;
  const sent = await getBot().thread(threadId).post({ markdown: "", files: [file] });
  return sent.id || null;
}

/**
 * The thread id for a 1:1 chat with a phone that has never texted us, opened through Photon, so a
 * provisioned member can get a sign-in code before their first text.
 */
export async function openThread(e164: string): Promise<string> {
  if (testTransport?.openThread) return testTransport.openThread(e164);
  if (fakeTransport()) return `fake-dm:${e164}`;
  return (bot ? getBot().getAdapter("imessage") : standaloneAdapter()).openDM(e164);
}

/** Sends a tapback on a message. iMessage only; the adapter takes the tapback names directly. */
export async function addReaction(threadId: string, messageId: string, emoji: Tapback): Promise<void> {
  if (testTransport) return testTransport.addReaction(threadId, messageId, emoji);
  if (fakeTransport()) {
    console.log(`imessage (fake) ${emoji} tapback on ${messageId} in ${threadId}`);
    return;
  }
  await (bot ? getBot().getAdapter("imessage") : standaloneAdapter()).addReaction(threadId, messageId, emoji);
}

// `imessage(app)` types as `never` over the adapter's default provider tuple, so name the one action we use.
type AttachmentLookup = { getAttachment(guid: string): Promise<{ read(): Promise<Buffer> } | undefined> };

/** Fetches an inbound attachment's bytes by its Photon id. Webhook deliveries carry the id, not the file. */
export async function downloadAttachment(id: string): Promise<Buffer> {
  const app = getBot().getAdapter("imessage").app;
  if (!app) throw new Error("iMessage adapter is not initialized");
  const found = await (imessage(app) as unknown as AttachmentLookup).getAttachment(id);
  if (!found) throw new Error("Photon returned no attachment for that id");
  return found.read();
}
