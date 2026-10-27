"use client";

import type { EveMessagePart } from "eve/client";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { localeFor, type Language } from "@/core/language";
import type { TraceUsage } from "@/schema/types";
import { toolLabelsFor } from "@/core/tool-labels";
import { humanizeToolName } from "@/components/assistant/agent-progress";
import { copyFor } from "@/lib/copy";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/ui/components/ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolPart } from "@/ui/components/ai-elements/tool";
import { cn } from "@/ui/lib/utils";

// Under a settled reply, the whole of what the assistant did, closed until asked: the model and its
// tokens (app/api/traces, read on first open), then each step's reasoning and tool calls with their
// inputs and outputs, from the reply's own message parts. Housekeeping tools the chips leave out show here.

type ToolCall = Extract<EveMessagePart, { type: "dynamic-tool" }>;
type Thought = Extract<EveMessagePart, { type: "reasoning" }>;
type Trace = { modelId: string | null; usage: TraceUsage | null };

const shown = (part: EveMessagePart): part is ToolCall | Thought => part.type === "dynamic-tool" || part.type === "reasoning";

export function UnderTheHood({
  parts,
  turnId,
  sessionId,
  language,
}: {
  parts: ReadonlyArray<EveMessagePart>;
  turnId: string | null;
  sessionId: string;
  language: Language;
}) {
  const [open, setOpen] = useState(false);
  const [trace, setTrace] = useState<Trace | null>(null);
  const steps = parts.filter(shown);

  useEffect(() => {
    if (!open || trace || !turnId) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ sessionId, turnId });
    fetch(`/api/traces?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => (response.ok ? setTrace((await response.json()) as Trace) : undefined))
      // No model line is better than a broken one: the steps below still show.
      .catch(() => undefined);
    return () => controller.abort();
  }, [open, trace, turnId, sessionId]);

  if (steps.length === 0) return null;
  const copy = copyFor(language).assistant;
  const toolLabels = toolLabelsFor(language);
  const number = new Intl.NumberFormat(localeFor(language));
  const tokens = trace?.usage
    ? copy.traceTokenCounts(number.format(trace.usage.inputTokens ?? 0), number.format(trace.usage.outputTokens ?? 0))
    : null;
  let lastStep: number | undefined;

  return (
    <div className="-mt-0.5 text-[12.5px]">
      <button
        aria-expanded={open}
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-[6px] px-1.5 py-0.5 text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink-2"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform duration-150", open && "rotate-90")} strokeWidth={2.2} />
        <span>{copy.underTheHood}</span>
      </button>
      {open ? (
        <div className="mt-1 ml-1 flex flex-col gap-2 border-l border-line pl-3">
          {trace?.modelId ? (
            <p className="text-ink-3">
              {copy.traceModel}: <span className="text-ink-2">{trace.modelId}</span>
              {tokens ? (
                <>
                  {" · "}
                  <span className="sr-only">{copy.traceTokens}: </span>
                  <span className="tabular-nums">{tokens}</span>
                </>
              ) : null}
            </p>
          ) : null}
          {steps.map((part, index) => {
            const heading =
              part.stepIndex !== undefined && part.stepIndex !== lastStep ? (
                <p className="text-[11.5px] text-ink-3 uppercase tracking-wide">
                  {copy.traceStep} {part.stepIndex + 1}
                </p>
              ) : null;
            lastStep = part.stepIndex ?? lastStep;
            if (part.type === "reasoning") {
              return (
                <div className="flex flex-col gap-1" key={part.id ?? `reasoning-${index}`}>
                  {heading}
                  <Reasoning defaultOpen={false}>
                    <ReasoningTrigger getThinkingMessage={() => <span>{copy.traceReasoning}</span>} />
                    <ReasoningContent>{part.text}</ReasoningContent>
                  </Reasoning>
                </div>
              );
            }
            return (
              <div className="flex flex-col gap-1" key={part.toolCallId}>
                {heading}
                <Tool className="mb-0">
                  <ToolHeader
                    state={part.state as ToolPart["state"]}
                    title={toolLabels[part.toolName]?.done ?? humanizeToolName(part.toolName)}
                    toolName={part.toolName}
                    type="dynamic-tool"
                  />
                  <ToolContent>
                    <ToolInput input={part.input} title={copy.traceInput} />
                    <ToolOutput errorText={part.errorText} errorTitle={copy.traceError} output={part.output} title={copy.traceOutput} />
                  </ToolContent>
                </Tool>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
