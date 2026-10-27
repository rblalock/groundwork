"use client";

import { CreditCard } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/ui/components/dialog";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import type { StripeSettings } from "@/lib/stripe";
import { Card, Detail } from "./kit";
import { ErrorLine, useMutation } from "./client-kit";

const TONES = { not_connected: "neutral", onboarding: "orange", restricted: "orange", active: "green", disconnected: "neutral" } as const;

/**
 * Settings' card payments: connect the business's own Stripe account (Stripe's onboarding opens, then
 * comes back here), see where it stands, and disconnect it.
 */
export function StripeCard({
  settings,
  language,
  canEdit,
  ownerOnly = false,
}: {
  settings: StripeSettings;
  language: Language;
  canEdit: boolean;
  /** An admin looking: the card says only the owner can change it. */
  ownerOnly?: boolean;
}) {
  const copy = pageCopyFor(language);
  const t = copy.stripe;
  const { send, busy, error } = useMutation(copy.common.failed);
  const [confirm, setConfirm] = useState(false);
  // On the way to Stripe: the button stays busy until its page opens.
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    // Back from Stripe restores this page as it was left.
    const back = (event: PageTransitionEvent) => event.persisted && setLeaving(false);
    window.addEventListener("pageshow", back);
    return () => window.removeEventListener("pageshow", back);
  }, []);
  const status = settings.status;

  async function connect() {
    const result = await send<{ url: string }>("connect", "/api/stripe/connect", { method: "POST", refresh: false });
    if (!result?.url) return;
    setLeaving(true);
    window.location.assign(result.url);
  }

  const action =
    status === "not_connected" ? t.connect : status === "onboarding" ? t.continue : status === "restricted" ? t.update : status === "disconnected" ? t.reconnect : null;

  return (
    <div id="payments">
      <Card
        actions={settings.available ? <StatusPill tone={TONES[status]}>{t.status[status]}</StatusPill> : null}
        description={t.help}
        title={
          <span className="flex items-center gap-1.5">
            <CreditCard aria-hidden="true" className="size-3.5 text-ink-3" />
            {t.title}
          </span>
        }
      >
        {!settings.available ? (
          <p className="text-[13px] text-ink-2 text-pretty">{t.notConfigured}</p>
        ) : (
          <div className="space-y-3">
            <p className="text-[13px] text-ink-2 text-pretty">{t.detail[status]}</p>
            {settings.accountId && status !== "not_connected" ? (
              <dl>
                <Detail label={t.account}>
                  <span className="font-mono text-[12px]">{settings.accountId}</span>
                </Detail>
              </dl>
            ) : null}
            {settings.fake ? <p className="rounded-[8px] bg-accent-tint px-3 py-2 text-[12px] text-accent-ink">{t.fake}</p> : null}
            {canEdit ? (
              <div className="flex flex-wrap gap-2">
                {action ? (
                  <Button disabled={busy !== null || leaving} onClick={() => void connect()} size="sm" variant="primary">
                    {busy === "connect" || leaving ? t.connecting : action}
                  </Button>
                ) : null}
                {status === "active" || status === "onboarding" || status === "restricted" ? (
                  <Button disabled={busy !== null} onClick={() => setConfirm(true)} size="sm" variant="quiet">
                    {t.disconnect}
                  </Button>
                ) : null}
              </div>
            ) : ownerOnly ? (
              <p className="text-[12px] text-ink-3">{t.ownerOnly}</p>
            ) : null}
            <ErrorLine>{error}</ErrorLine>
          </div>
        )}
      </Card>
      <Dialog onOpenChange={setConfirm} open={confirm}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{t.confirmTitle}</DialogTitle>
          <DialogDescription>{t.confirmBody}</DialogDescription>
          <DialogFooter>
            <DialogClose render={<Button size="sm" variant="quiet" />}>{copy.common.cancel}</DialogClose>
            <Button
              className="bg-red text-white hover:opacity-90"
              disabled={busy !== null}
              onClick={async () => {
                if (await send("disconnect", "/api/stripe/disconnect", { method: "POST" })) setConfirm(false);
              }}
              size="sm"
            >
              {t.disconnect}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
