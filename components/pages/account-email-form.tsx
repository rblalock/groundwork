"use client";

import { Mail } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import type { ForwardingJson } from "@/lib/pages/team";
import { Card } from "./kit";
import { ErrorLine, Field, useMutation } from "./client-kit";

/**
 * A member's own forwarding address: the one that's on, the one waiting on its code, and where to
 * forward. A new address shows its code here once, right after it's asked for (it's also texted); after
 * that, only by text.
 */
export function AccountEmailForm({
  email,
  pending,
  inboxAddress,
  language,
}: {
  email: string | null;
  pending: { address: string; expiresAt: string } | null;
  inboxAddress: string | null;
  language: Language;
}) {
  const copy = pageCopyFor(language);
  const t = copy.account;
  const { send, busy, error } = useMutation(copy.common.failed);
  const [result, setResult] = useState<ForwardingJson | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResult(null);
    const value = String(new FormData(event.currentTarget).get("email") ?? "");
    const saved = await send<{ member: ForwardingJson }>("save", "/api/account/email", { method: "PUT", body: { email: value } });
    if (saved) setResult(saved.member);
  }

  const justAsked = result?.pending?.code ? result.pending : null;
  const waiting = justAsked ? null : (result ? result.pending : pending);

  return (
    <Card
      description={t.emailHelp}
      title={
        <span className="flex items-center gap-1.5">
          <Mail aria-hidden="true" className="size-3.5 text-ink-3" />
          {t.emailTitle}
        </span>
      }
    >
      <form className="grid gap-4" onSubmit={submit}>
        {email ? (
          <p className="flex items-center gap-2 text-[13px] text-ink">
            <span className="font-mono">{email}</span>
            <StatusPill className="h-5 px-2 text-[12px]" tone="green">
              {t.active}
            </StatusPill>
          </p>
        ) : null}
        <Field
          autoComplete="email"
          className="max-w-sm"
          defaultValue={pending?.address ?? email ?? ""}
          id="email"
          inputMode="email"
          key={email ?? ""}
          label={t.email}
          placeholder="name@example.com"
          type="email"
        />
        {justAsked ? (
          <p className="rounded-[8px] bg-accent-tint px-3 py-2 text-[13px] text-accent-ink text-pretty" role="status">
            {t.codeNow(justAsked.address, justAsked.inbox, justAsked.code!)}
          </p>
        ) : waiting && inboxAddress ? (
          <div className="space-y-1 rounded-[8px] bg-inset px-3 py-2 text-[13px] text-ink-2 shadow-hairline">
            <p className="font-medium text-ink">{t.pending(waiting.address)}</p>
            <p className="text-pretty">{t.pendingHow(waiting.address, inboxAddress)}</p>
          </div>
        ) : (
          <p className="text-[13px] text-ink-2 text-pretty">{inboxAddress ? t.forwardTo(inboxAddress) : t.noInbox}</p>
        )}
        <ErrorLine>{error}</ErrorLine>
        <div className="flex items-center gap-3">
          <Button disabled={busy !== null || !inboxAddress} size="sm" type="submit" variant="primary">
            {busy ? t.saving : t.save}
          </Button>
          {result && !result.pending && !error ? (
            <p className="text-[13px] text-ink-2" role="status">
              {t.saved}
            </p>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
