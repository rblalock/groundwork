"use client";

import { BookA, Plus, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { GlossaryTerm } from "@/core/glossary";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import { Button } from "@/ui/beautiful/atoms/Button";
import { Card } from "./kit";
import { ErrorLine, inputClass, useMutation } from "./client-kit";

type Row = GlossaryTerm & { key: number };

let nextKey = 0;
const row = (term: Partial<GlossaryTerm> = {}): Row => ({ term: "", spanish: "", note: "", ...term, key: nextKey++ });

/**
 * Settings' glossary: the business's own Spanish words for its English terms, which the translated view
 * and the assistant use. Saved as one list (`PUT /api/glossary`); blank rows are dropped.
 */
export function GlossaryCard({ terms, language, canEdit }: { terms: GlossaryTerm[]; language: Language; canEdit: boolean }) {
  const copy = pageCopyFor(language);
  const g = copy.settings.glossary;
  const { send, busy, error, setError } = useMutation(copy.common.failed);
  const [rows, setRows] = useState<Row[]>(() => terms.map((t) => row(t)));
  const [notice, setNotice] = useState<string>();

  const change = (key: number, field: keyof GlossaryTerm, value: string) => {
    setNotice(undefined);
    setRows((current) => current.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(undefined);
    const filled = rows
      .map((r) => ({ term: r.term.trim(), spanish: r.spanish.trim(), note: r.note.trim() }))
      .filter((r) => r.term || r.spanish || r.note);
    if (filled.some((r) => !r.term || !r.spanish)) return setError(g.errors.GLOSSARY_INVALID);
    if (new Set(filled.map((r) => r.term.toLowerCase())).size !== filled.length) return setError(g.errors.GLOSSARY_DUPLICATE);
    const saved = await send<{ terms: GlossaryTerm[] }>("glossary", "/api/glossary", { method: "PUT", body: { terms: filled } });
    if (saved) {
      setRows(saved.terms.map((t) => row(t)));
      setNotice(g.saved);
    }
  }

  return (
    <div id="glossary">
      <Card
        description={g.help}
        title={
          <span className="flex items-center gap-1.5">
            <BookA aria-hidden="true" className="size-3.5 text-ink-3" />
            {g.title}
          </span>
        }
      >
        <form className="space-y-3" onSubmit={submit}>
          {rows.length === 0 ? <p className="text-[13px] text-ink-2 text-pretty">{g.empty}</p> : null}
          {rows.length > 0 ? (
            <div className="space-y-2">
              <div aria-hidden="true" className="hidden grid-cols-[1fr_1fr_1.3fr_2rem] gap-2 text-[12px] text-ink-3 sm:grid">
                <span>{g.term}</span>
                <span>{g.spanish}</span>
                <span>{g.note}</span>
              </div>
              {rows.map((r, index) => (
                <div className="grid grid-cols-[1fr_1fr_2rem] gap-2 sm:grid-cols-[1fr_1fr_1.3fr_2rem]" key={r.key}>
                  <input
                    aria-label={`${g.term} ${index + 1}`}
                    className={inputClass}
                    disabled={!canEdit}
                    lang="en"
                    maxLength={120}
                    onChange={(event) => change(r.key, "term", event.target.value)}
                    value={r.term}
                  />
                  <input
                    aria-label={`${g.spanish} ${index + 1}`}
                    className={inputClass}
                    disabled={!canEdit}
                    lang="es"
                    maxLength={120}
                    onChange={(event) => change(r.key, "spanish", event.target.value)}
                    value={r.spanish}
                  />
                  <input
                    aria-label={`${g.note} ${index + 1}`}
                    className={`${inputClass} col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto`}
                    disabled={!canEdit}
                    maxLength={300}
                    onChange={(event) => change(r.key, "note", event.target.value)}
                    placeholder={g.notePlaceholder}
                    value={r.note}
                  />
                  {canEdit ? (
                    <Button
                      aria-label={g.remove(r.term.trim())}
                      className="col-start-3 row-start-1 sm:col-start-auto sm:row-start-auto"
                      onClick={() => {
                        setNotice(undefined);
                        setRows((current) => current.filter((x) => x.key !== r.key));
                      }}
                      size="sm"
                      type="button"
                      variant="quiet"
                    >
                      <X aria-hidden="true" className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {canEdit ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button onClick={() => setRows((current) => [...current, row()])} size="sm" type="button" variant="quiet">
                <Plus aria-hidden="true" className="size-3.5" />
                {g.add}
              </Button>
              <div className="flex items-center gap-3">
                {notice ? (
                  <p className="text-[13px] text-ink-2" role="status">
                    {notice}
                  </p>
                ) : null}
                <ErrorLine>{error}</ErrorLine>
                <Button disabled={busy !== null} size="sm" type="submit" variant="primary">
                  {busy === "glossary" ? copy.common.saving : g.save}
                </Button>
              </div>
            </div>
          ) : null}
        </form>
      </Card>
    </div>
  );
}
