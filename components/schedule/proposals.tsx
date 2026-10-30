"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import type { ProposalJson, ProposalOutcomeJson } from "@/lib/pages/schedule";
import { ErrorLine } from "../pages/client-kit";
import { useScheduleRequest } from "./forms";

/**
 * Open proposals to move stops off a day running long, above the schedule: each stop with a box to keep it, and
 * Apply or Drop. Applying re-checks every stop on the server; what moved, what didn't, and the customer drafts to
 * forward show here until dismissed. Owners and admins only; a look-only view sees them without the buttons.
 */
export function ProposalsCard({ proposals, language, canManage }: { proposals: ProposalJson[]; language: Language; canManage: boolean }) {
  const s = pageCopyFor(language).schedule.proposals;
  return (
    <section className="overflow-hidden rounded-card bg-surface shadow-card">
      <header className="flex items-baseline gap-2 border-b border-line px-4 py-2.5">
        <h3 className="text-[13px] font-medium text-ink">{s.title}</h3>
        <span className="text-[12px] text-ink-3 tabular-nums">{proposals.length}</span>
        <p className="ml-auto hidden text-[12px] text-ink-3 sm:block">{s.help}</p>
      </header>
      <ul className="divide-y divide-line">
        {proposals.map((proposal) => (
          <ProposalRow canManage={canManage} key={proposal.proposalId} language={language} proposal={proposal} />
        ))}
      </ul>
    </section>
  );
}

function ProposalRow({ proposal, language, canManage }: { proposal: ProposalJson; language: Language; canManage: boolean }) {
  const copy = pageCopyFor(language);
  const s = copy.schedule.proposals;
  const router = useRouter();
  const { send, busy } = useScheduleRequest(copy.common.failed);
  const [kept, setKept] = useState<string[]>(proposal.items.map((item) => item.id));
  const [pending, setPending] = useState<"apply" | "drop" | null>(null);
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState<ProposalOutcomeJson | null>(null);

  const decide = async (action: "apply" | "drop") => {
    setError(undefined);
    setPending(action);
    const result = await send<ProposalOutcomeJson>(
      `/api/schedule/proposals/${proposal.proposalId}`,
      "POST",
      action === "apply" ? { action, itemIds: kept } : { action },
      false,
    );
    setPending(null);
    if (result.ok) {
      setOutcome(result.data);
      // The grid shows the moved stops at once; the card stays to show what happened.
      router.refresh();
    } else setError(result.error);
  };

  if (outcome) {
    return (
      <li className="space-y-3 px-4 py-3">
        <p className="whitespace-pre-line text-[13px] text-ink">{outcome.summaryText}</p>
        {outcome.customerTexts.length ? (
          <div className="space-y-2">
            <p className="text-[12px] text-ink-3">{s.forward}</p>
            {outcome.customerTexts.map((draft) => (
              <blockquote className="rounded-lg bg-inset px-3 py-2 text-[13px] text-ink" key={draft.itemId}>
                {draft.customerName ? <span className="block text-[12px] font-medium text-ink-2">{draft.customerName}</span> : null}
                <span className="select-all">{draft.text}</span>
              </blockquote>
            ))}
          </div>
        ) : null}
        <Button onClick={() => router.refresh()} size="sm">
          {s.done}
        </Button>
      </li>
    );
  }

  return (
    <li className="space-y-2.5 px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <StatusPill className="shrink-0" dot tone="orange">
          {s.move(proposal.items.length, proposal.memberName.split(/\s+/)[0])}
        </StatusPill>
        <p className="min-w-0 text-[13px] text-ink-2">{proposal.reason}.</p>
      </div>
      <fieldset className="space-y-1.5" disabled={!canManage || busy}>
        <legend className="sr-only">{s.move(proposal.items.length, proposal.memberName)}</legend>
        {proposal.items.map((item) => (
          <label className="flex items-start gap-2.5" key={item.id}>
            <input
              checked={kept.includes(item.id)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--color-ink)]"
              onChange={(event) => setKept(event.target.checked ? [...kept, item.id].sort() : kept.filter((id) => id !== item.id))}
              type="checkbox"
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-ink">
                {item.id}. {item.line}
              </span>
              <span className="block text-[12px] text-ink-3">
                {s.crew}: {item.crewText}
              </span>
              <span className="block text-[12px] text-ink-3">
                {s.customer}
                {item.customerName ? ` (${item.customerName})` : ""}: {item.customerText}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {canManage ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button disabled={busy || kept.length === 0} onClick={() => decide("apply")} size="sm" variant="primary">
            {pending === "apply" ? s.applying : s.apply}
          </Button>
          <Button disabled={busy} onClick={() => decide("drop")} size="sm" variant="quiet">
            {pending === "drop" ? s.dropping : s.drop}
          </Button>
          {kept.length === 0 ? <p className="text-[12px] text-ink-3">{s.noneKept}</p> : null}
        </div>
      ) : null}
      <ErrorLine>{error}</ErrorLine>
    </li>
  );
}
