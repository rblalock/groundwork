import type { Caller } from "./members";
import type { Language } from "./language";

/** Why a forwarded email gets no turn (core/email-intake.ts). Recorded as an event; nobody is answered. */
export type EmailDropReason = "not_received" | "spam" | "automatic" | "own_inbox" | "unknown_sender" | "no_thread" | "too_large" | "unauthenticated" | "unconfirmed";

export type PhoneRow = { id: string; memberId: string; status: "pending" | "verified" | "stopped" };
export type InboundDecision =
  | {
      kind: "ignore";
      reason: "bot" | "unknown_phone" | "duplicate" | "stopped" | "empty" | "dropped_reaction" | "suspended" | EmailDropReason;
    }
  | { kind: "stop" }
  | { kind: "start" }
  | { kind: "help" }
  | { kind: "dispatch"; welcome: boolean }
  /** Over the business's usage limits: the text waits in the queue until `retryAt`. */
  | { kind: "held"; retryAt: Date };

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "unstop"]);
const HELP_WORDS = new Set(["help", "info"]);

/** laugh and exclamation tapbacks are logged and dropped; the rest reach the agent as turns. */
export const FORWARDED_REACTIONS = ["thumbs_up", "heart", "thumbs_down", "question"] as const;

/**
 * What to do with one inbound text. Order: bot, unknown phone, duplicate, STOP keywords (even
 * when stopped), START (so a stopped phone can restart), HELP (carriers expect it answered even when
 * stopped), stopped, empty, dispatch. Keywords match the whole trimmed message.
 */
export function decideInbound(input: {
  text: string;
  hasAttachments: boolean;
  isBot: boolean;
  phone: PhoneRow | null;
  duplicate: boolean;
}): InboundDecision {
  if (input.isBot) return { kind: "ignore", reason: "bot" };
  if (!input.phone) return { kind: "ignore", reason: "unknown_phone" };
  if (input.duplicate) return { kind: "ignore", reason: "duplicate" };
  const word = input.text.trim().toLowerCase();
  if (STOP_WORDS.has(word)) return { kind: "stop" };
  // START must get through to a stopped phone, so it is checked before the stopped gate.
  if (START_WORDS.has(word)) return { kind: "start" };
  if (HELP_WORDS.has(word)) return { kind: "help" };
  if (input.phone.status === "stopped") return { kind: "ignore", reason: "stopped" };
  if (!word && !input.hasAttachments) return { kind: "ignore", reason: "empty" };
  return { kind: "dispatch", welcome: input.phone.status === "pending" };
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name.trim();

/** US numbers read as (786) 555-0199; anything else is left as given. */
/** A US line as (305) 555-0100; anything else as given. */
export function prettyLine(line: string): string {
  const digits = line.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return national.length === 10
    ? `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`
    : line;
}

/** Posted instantly on a member's first text, before the model runs. At most two lines. */
export function welcomeText(args: {
  businessName: string;
  memberName: string;
  language: Language;
  addedByName?: string;
}): string {
  const name = firstName(args.memberName);
  const { businessName: business, addedByName: adder } = args;
  if (args.language === "es") {
    return adder
      ? `Hola ${name}, soy el asistente de cotizaciones de ${business}. ${adder} te agregó. Soy un asistente automatizado.\n` +
          `Escríbeme los trabajos como se los contarías a un compañero y preparo las cotizaciones; ${adder} aprueba los precios.`
      : `Hola ${name}, soy el asistente de cotizaciones de ${business}. Soy un asistente automatizado.\n` +
          `Escríbeme los trabajos como se los contarías a un compañero y te envío las cotizaciones.`;
  }
  return adder
    ? `Hi ${name}, I'm ${business}'s quoting assistant. ${adder} added you, and I'm automated.\n` +
        `Text me jobs like you'd tell a coworker and I'll draft quotes; ${adder} approves the prices.`
    : `Hi ${name}, I'm ${business}'s quoting assistant. I'm automated.\n` +
        `Text me jobs like you'd tell a coworker and I'll send back quotes.`;
}

/** The forwardable message the owner passes to a new crew member. */
export function inviteText(args: {
  businessName: string;
  memberName: string;
  assignedLine: string;
  language: Language;
}): string {
  const name = firstName(args.memberName);
  const line = prettyLine(args.assignedLine);
  return args.language === "es"
    ? `${name}, soy el asistente de cotizaciones de ${args.businessName}. Escríbeme al ${line} para enviar trabajos.`
    : `${name}, this is ${args.businessName}'s quoting assistant. Text me at ${line} to send in jobs.`;
}

/** The synthetic turn text for a tapback. */
export function reactionTurnText(args: { glyph: string; targetBody: string | null }): string {
  if (args.targetBody === null) return `${args.glyph} (tapback)`;
  const target = args.targetBody.replace(/\s+/g, " ").trim().slice(0, 160);
  return `${args.glyph} (tapback on your message: "${target}")`;
}

export function helpText(businessName: string, language: Language): string {
  return language === "es"
    ? `Soy el asistente de cotizaciones de ${businessName}. Escríbeme un trabajo y te envío la cotización. Responde STOP para dejar de recibir mensajes.`
    : `I'm ${businessName}'s quoting assistant. Text me a job and I'll send back a quote. Reply STOP to stop texts.`;
}

/** The one line a member of a paused business gets, at most once a day, instead of a turn. */
export function pausedText(businessName: string, language: Language): string {
  return language === "es"
    ? `El asistente de ${businessName} está en pausa por ahora, así que no puedo ayudarte con esto. Avísale al dueño.`
    : `${businessName}'s assistant is paused for now, so I can't help with this. Let the owner know.`;
}

/** The one line a member gets when their text waits on the business's hourly usage limit. */
export function usageLimitText(businessName: string, language: Language): string {
  return language === "es"
    ? `${businessName} llegó a su límite de uso del asistente por esta hora. Tu mensaje quedó guardado y te respondo en cuanto se libere.`
    : `${businessName} hit its assistant usage limit for this hour. Your message is saved, and I'll answer it as soon as the limit frees up.`;
}

export function stopText(language: Language): string {
  return language === "es"
    ? "Listo, no recibirás más mensajes. Responde START para volver a empezar."
    : "You're unsubscribed and won't get more texts. Reply START to start again.";
}

export function startText(language: Language): string {
  return language === "es"
    ? "Bienvenido de nuevo. Escríbeme un trabajo cuando quieras."
    : "Welcome back. Text me a job whenever you're ready.";
}

/** Posted when a turn or session fails. Never carries error text. */
export function failureText(language: Language): string {
  return language === "es"
    ? "Algo falló de mi lado. Inténtalo de nuevo en un minuto."
    : "Something went wrong on my end. Try that again in a minute.";
}

function ago(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** Per-turn facts for the model: who is texting, what waits on them, and what we last said unprompted. */
export function contextLines(args: {
  caller: Caller;
  pending: string[];
  lastProactive: { text: string; at: Date } | null;
  now: Date;
  firstContact?: boolean;
  /** `asksApproval`: the tapped message asked them to approve this quote. */
  reactionQuote?: { quoteId: string; title: string; status: string; revisionNumber?: number | null; asksApproval: boolean };
  /** The member's open jobs, most recent first, when this turn is in their thread. */
  openJobs?: Array<{ jobId: string; title: string }>;
}): string[] {
  const { caller } = args;
  const usual = caller.language === "es" ? "Spanish" : "English";
  const lines = [`Member: ${caller.name} (${caller.role}). Reply in the language of their message; when unclear, ${usual}.`];
  if (args.firstContact) {
    lines.push(
      `First text ever from ${caller.name}. The welcome was already sent. If this is only a greeting, invite a job: photos help, you'll ask their prices once and remember them.`,
    );
  }
  if (args.pending.length > 0) lines.push(`Waiting on them: ${args.pending.join("; ")}`);
  if (args.lastProactive) {
    const text = args.lastProactive.text.replace(/\s+/g, " ").trim().slice(0, 160);
    lines.push(`You last texted them ${ago(args.lastProactive.at, args.now)}: '${text}'`);
  }
  if (args.openJobs?.length) {
    const jobs = args.openJobs.map((job) => `"${job.title.replace(/\s+/g, " ").slice(0, 80)}" (${job.jobId})`).join("; ");
    lines.push(`Their open jobs: ${jobs}. When their message is about one of these, continue it with continue_job.`);
  }
  if (args.reactionQuote) {
    const { quoteId, title, status, revisionNumber, asksApproval } = args.reactionQuote;
    lines.push(
      !asksApproval
        ? `The tapback is on a message about quote ${quoteId} "${title}" (status ${status}) that did not ask for approval, so it is not an approval.`
        : revisionNumber == null
        ? `The tapback is on a message about quote ${quoteId} "${title}" (status ${status}).`
        : `The tapback is on a message about quote ${quoteId} "${title}" (status ${status}), revision ${revisionNumber}. ` +
            `If you approve it, pass expectedRevisionNumber ${revisionNumber} to approve_quote.`,
    );
  }
  return lines;
}
