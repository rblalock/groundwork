"use client";

import { UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import { Card } from "./kit";
import { ErrorLine, Field, NativeSelect, useMutation } from "./client-kit";

/** A member's own name, and the language they read the app and the assistant's texts in. */
export function AccountProfileForm({ name, memberLanguage, language }: { name: string; memberLanguage: Language; language: Language }) {
  const copy = pageCopyFor(language);
  const t = copy.account;
  const { send, busy, error } = useMutation(copy.common.failed);
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    const form = new FormData(event.currentTarget);
    const done = await send("save", "/api/account", {
      method: "PATCH",
      body: { name: String(form.get("account-name") ?? ""), language: String(form.get("account-language") ?? memberLanguage) },
    });
    if (done) setSaved(true);
  }

  return (
    <Card
      description={t.youHelp}
      title={
        <span className="flex items-center gap-1.5">
          <UserRound aria-hidden="true" className="size-3.5 text-ink-3" />
          {t.youTitle}
        </span>
      }
    >
      <form className="grid gap-4" onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field autoComplete="name" defaultValue={name} id="account-name" label={t.name} maxLength={100} required />
          <Field id="account-language" label={t.language}>
            <NativeSelect defaultValue={memberLanguage} id="account-language" name="account-language">
              <option value="en">{copy.common.languages.en}</option>
              <option value="es">{copy.common.languages.es}</option>
            </NativeSelect>
          </Field>
        </div>
        <ErrorLine>{error}</ErrorLine>
        <div className="flex items-center justify-end gap-3">
          {saved ? (
            <p className="text-[13px] text-ink-2" role="status">
              {t.saved}
            </p>
          ) : null}
          <Button disabled={busy !== null} size="sm" type="submit" variant="primary">
            {busy ? t.saving : t.save}
          </Button>
        </div>
      </form>
    </Card>
  );
}
