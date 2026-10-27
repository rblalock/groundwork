import { cn } from "@/ui/lib/utils";

export type Stage = {
  label: string;
  /** done, the one it's at now, still ahead, or where it stopped (a lost quote, a void invoice). */
  state: "done" | "current" | "todo" | "ended";
};

/**
 * Where a record stands, as a line of stages: a quote from drafted to paid, a piece of work from booked
 * to paid, an invoice from draft to paid. On a narrow page, just where it is and what's next.
 */
export function ProgressLine({ stages, nextLabel }: { stages: Stage[]; nextLabel: (stage: string) => string }) {
  // Where it is: the last stage reached (or where it ended), and the one it's waiting on.
  const ended = stages.find((s) => s.state === "ended");
  const reached = ended ?? stages.filter((s) => s.state === "done").at(-1);
  const next = ended ? undefined : stages.find((s) => s.state === "current");
  return (
    <div>
      <p className="flex items-center gap-2 text-[13px] @xl:hidden">
        <Dot state={reached?.state ?? "done"} />
        <span className="font-medium text-ink">{reached?.label}</span>
        {next ? <span className="text-ink-3">· {nextLabel(next.label)}</span> : null}
      </p>
      <ol className="hidden @xl:flex">
        {stages.map((stage, index) => (
          <li
            className={cn(
              "relative flex flex-1 flex-col items-center gap-1.5 text-center text-[11.5px]",
              stage.state === "done" ? "text-ink-2" : stage.state === "todo" ? "text-ink-3" : "font-medium text-ink",
            )}
            key={stage.label}
          >
            {index < stages.length - 1 ? (
              <span
                aria-hidden="true"
                className={cn("absolute top-[5px] right-[calc(-50%+8px)] left-[calc(50%+8px)] h-px", stage.state === "done" ? "bg-green" : "bg-line-strong")}
              />
            ) : null}
            <Dot state={stage.state} />
            <span className="px-1 text-balance">{stage.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Dot({ state }: { state: Stage["state"] }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative z-[1] size-[11px] shrink-0 rounded-full border-2",
        state === "done" && "border-green bg-green",
        state === "current" && "border-accent bg-page",
        state === "ended" && "border-ink-3 bg-ink-3",
        state === "todo" && "border-line-strong bg-line-strong",
      )}
    />
  );
}
