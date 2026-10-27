"use client";

import type { ConversationState } from "eve/client";
import { useState } from "react";
import type { ToolLabel } from "@/core/tool-labels";
import { LoadingState, Spinner } from "@/components/spinner";

/** eve's task controls; the tasks they wait on or stop show on their own. */
const TASK_CONTROLS = new Set(["eve__task_wait", "eve__task_cancel", "task_wait", "task_cancel"]);

export type ProgressCopy = { thinking: string; reconnecting: string; failed: string; declined: string; done: string };

export function humanizeToolName(name: string) {
  const words = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the active turn is doing, step by step, until its reply lands. */
export function AgentProgress({
  conversation,
  toolLabels,
  resuming,
  copy,
}: {
  conversation: ConversationState;
  toolLabels: Record<string, ToolLabel>;
  resuming: boolean;
  copy: ProgressCopy;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  // A new submission must not resurrect the previous turn's completed steps.
  const steps = conversation.activeTurnId
    ? conversation.messages
        .filter((message) => message.role === "assistant" && message.metadata?.turnId === conversation.activeTurnId)
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "dynamic-tool")
        .filter((part) => !TASK_CONTROLS.has(part.toolName))
    : [];

  return (
    <div aria-label={copy.thinking} aria-live="polite" className="grid gap-1.5" role="status">
      {steps.map((step) => {
        const labels = toolLabels[step.toolName];
        const name = humanizeToolName(step.toolName);
        const done =
          step.state === "output-error" ||
          step.state === "output-denied" ||
          (step.state === "output-available" && !step.partial);
        const label =
          step.state === "output-error"
            ? `${labels?.active ?? name} · ${copy.failed}`
            : step.state === "output-denied"
              ? `${labels?.active ?? name} · ${copy.declined}`
              : labels
                ? done
                  ? labels.done
                  : labels.active
                : `${name}${done ? ` · ${copy.done}` : ""}`;
        const detail = labels?.detail;
        const open = openId === step.toolCallId;
        // A step under way spins; a finished one settles to a dot.
        const dot = done ? (
          <span aria-hidden="true" className="mx-[3px] size-1.5 shrink-0 rounded-full bg-ink-3" />
        ) : (
          <Spinner size={12} />
        );
        // Only steps with a `detail` expand.
        return (
          <div key={step.toolCallId}>
            {detail ? (
              <button
                aria-expanded={open}
                className="flex w-full items-center gap-2 rounded-[8px] px-1 py-1 text-left text-sm text-ink-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                onClick={() => setOpenId(open ? null : step.toolCallId)}
                type="button"
              >
                {dot}
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </button>
            ) : (
              <div className="flex items-center gap-2 px-1 py-1 text-sm text-ink-2">
                {dot}
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </div>
            )}
            {open && detail ? <p className="ml-4 pb-1 text-xs leading-relaxed text-ink-3">{detail}</p> : null}
          </div>
        );
      })}
      {steps.length === 0 ? (
        <LoadingState announce={false} className="px-1 text-ink-3" label={resuming ? copy.reconnecting : copy.thinking} variant={resuming ? "loading" : "thinking"} />
      ) : null}
    </div>
  );
}
