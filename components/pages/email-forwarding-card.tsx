"use client";

import { Check, Copy, Mail } from "lucide-react";
import { useState } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import type { EmailForwarding } from "@/lib/pages/settings";
import { Card } from "./kit";

/** Settings' email address: where the team forwards emails to the assistant, and what it does with them. */
export function EmailForwardingCard({ forwarding, language }: { forwarding: EmailForwarding; language: Language }) {
  const t = pageCopyFor(language).forwarding;
  const [copied, setCopied] = useState(false);
  return (
    <div id="forwarding">
      <Card
        description={t.help}
        title={
          <span className="flex items-center gap-1.5">
            <Mail aria-hidden="true" className="size-3.5 text-ink-3" />
            {t.title}
          </span>
        }
      >
        {!forwarding.available && !forwarding.address ? (
          <p className="text-[13px] text-ink-2 text-pretty">{t.notConfigured}</p>
        ) : !forwarding.address ? (
          <p className="text-[13px] text-ink-2 text-pretty">{t.none}</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-ink-3">{t.address}</span>
              <span className="min-w-0 rounded-[8px] bg-inset px-2.5 py-1 font-mono text-[13px] text-ink shadow-hairline select-all break-all">
                {forwarding.address}
              </span>
              <Button
                onClick={async () => {
                  await navigator.clipboard.writeText(forwarding.address ?? "");
                  setCopied(true);
                }}
                size="xs"
                variant="quiet"
              >
                {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
                {copied ? t.copied : t.copy}
              </Button>
            </div>
            <p className="text-[13px] text-ink-2 text-pretty">{t.fromHelp}</p>
            <p className="text-[13px] text-ink-2 text-pretty">{t.safety}</p>
            {forwarding.fake ? <p className="rounded-[8px] bg-accent-tint px-3 py-2 text-[12px] text-accent-ink">{t.fake}</p> : null}
          </div>
        )}
      </Card>
    </div>
  );
}
