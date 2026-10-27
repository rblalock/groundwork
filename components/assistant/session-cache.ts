"use client";

import { Client, type MessageStreamEvent } from "eve/client";
import type { AgentName } from "@/core/agent-name";

// A conversation's eve events, kept in the tab: opening a thread again (or switching back to its tab in
// the panel) shows it at once, then follows only what's newer. The first open reads the whole history
// in one request (`snapshot`) and hands it to the chat in one pass, instead of replaying it event by
// event. Kept in memory and in sessionStorage (this tab only, gone when it closes), and cleared on
// sign-out (`forgetSessions`).

const PREFIX = "gw:session:";
/** Past this, a history stays in memory only: sessionStorage holds about 5 MB for the whole site. */
const MAX_STORED_CHARS = 1_500_000;

const memory = new Map<string, readonly MessageStreamEvent[]>();

function stored(sessionId: string): readonly MessageStreamEvent[] | null {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + sessionId);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as MessageStreamEvent[]) : null;
  } catch {
    return null;
  }
}

/** What this page has kept of the session since it loaded, without reading storage. */
export function sessionInMemory(sessionId: string): readonly MessageStreamEvent[] | null {
  return memory.get(sessionId) ?? null;
}

/** The events last seen for this session in this tab, or null. */
export function cachedSession(sessionId: string): readonly MessageStreamEvent[] | null {
  const kept = memory.get(sessionId) ?? stored(sessionId);
  if (kept) memory.set(sessionId, kept);
  return kept;
}

/** Keeps the session's events (the whole stream from its start, as eve gave them). */
export function rememberSession(sessionId: string, events: readonly MessageStreamEvent[]): void {
  if (events.length === 0 || memory.get(sessionId)?.length === events.length) return;
  memory.set(sessionId, events);
  try {
    const raw = JSON.stringify(events);
    if (raw.length <= MAX_STORED_CHARS) window.sessionStorage.setItem(PREFIX + sessionId, raw);
    else window.sessionStorage.removeItem(PREFIX + sessionId);
  } catch {
    // Storage full or unavailable: memory still has it.
  }
}

/** The session's whole history so far, in one request. */
export async function loadSession(agent: AgentName, sessionId: string, signal: AbortSignal): Promise<readonly MessageStreamEvent[]> {
  const client = new Client({ host: `${window.location.origin}/eve/${agent}` });
  const { events } = await client.sessions.attach(sessionId).snapshot({ signal });
  rememberSession(sessionId, events);
  return events;
}

/** Drops every kept conversation: on sign-out, so the next person on this tab sees none of them. */
export function forgetSessions(): void {
  memory.clear();
  try {
    for (const key of Object.keys(window.sessionStorage)) if (key.startsWith(PREFIX)) window.sessionStorage.removeItem(key);
  } catch {
    // Nothing kept.
  }
}
