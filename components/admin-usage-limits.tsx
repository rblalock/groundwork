"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { LimitOverrides, Limits } from "@/core/usage-limits";
import { Button } from "@/ui/beautiful/atoms/Button";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";

const FIELDS: Array<{ key: keyof Limits; label: string; hint: string }> = [
  { key: "hourlyTurns", label: "Turns per hour", hint: "Texts, web messages, and job steps the assistant answers in any hour." },
  { key: "hourlyOutputTokens", label: "Output tokens per hour", hint: "What the model writes, reasoning included, in any hour." },
  { key: "concurrentTurns", label: "Turns at once", hint: "Running or waiting to start." },
];

/** A super admin's editor for one business's usage limits. Blank puts a limit back to the app's default. */
export function AdminUsageLimits({ orgId, overrides, defaults }: { orgId: string; overrides: LimitOverrides; defaults: Limits }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string }>();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const patch: Record<string, number | null> = {};
    for (const { key } of FIELDS) {
      const raw = String(form.get(key) ?? "").replaceAll(",", "").trim();
      patch[key] = raw === "" ? null : Number(raw);
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/admin/businesses/${orgId}/usage-limits`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setMessage({ tone: "error", text: data?.error ?? "Couldn't save those limits. Try again." });
        return;
      }
      setMessage({ tone: "ok", text: "Saved." });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="rounded-card bg-surface shadow-card" onSubmit={save}>
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-[13px] font-medium">Limits</h2>
        <p className="mt-0.5 text-[12px] text-ink-3 text-pretty">
          This business's own limits. Leave one blank for the app's default. Over a limit, texts wait in line and web and job turns are refused until it frees up.
        </p>
      </div>
      <div className="grid gap-4 px-4 py-4 sm:grid-cols-3">
        {FIELDS.map(({ key, label, hint }) => (
          <div className="grid content-start gap-2" key={key}>
            <Label htmlFor={key}>{label}</Label>
            <Input
              defaultValue={overrides[key] ?? ""}
              id={key}
              inputMode="numeric"
              name={key}
              pattern="[0-9,]*"
              placeholder={`Default: ${defaults[key].toLocaleString("en-US")}`}
            />
            <p className="text-[12px] text-ink-3 text-pretty">{hint}</p>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-3 border-t border-line px-4 py-3">
        {message ? (
          <p className={message.tone === "error" ? "text-sm text-destructive" : "text-sm text-ink-2"} role={message.tone === "error" ? "alert" : "status"}>
            {message.text}
          </p>
        ) : null}
        <Button disabled={busy} size="sm" type="submit" variant="primary">
          {busy ? "Saving…" : "Save limits"}
        </Button>
      </div>
    </form>
  );
}
