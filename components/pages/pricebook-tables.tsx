"use client";

import { Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle } from "@/ui/components/dialog";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import type { Language } from "@/core/language";
import { equipmentList } from "@/core/equipment";
import { formatCents, parseMoneyToCents } from "@/core/money";
import type { RuleEffect, UnitKind } from "@/core/calculator";
import { pageCopyFor } from "@/lib/page-copy";
import { cn } from "@/ui/lib/utils";
import { Nothing, Table, Td, Th } from "./kit";
import { ErrorLine, Field, NativeSelect, useMutation } from "./client-kit";

export type ItemRow = {
  id: string;
  name: string;
  unitKind: UnitKind;
  unitLabel: string;
  priceCents: number;
  taxable: boolean;
  status: "active" | "retired";
  group: string | null;
  /** What doing it needs. */
  equipment: string[];
  /** Rain or heat calls it off. */
  weatherSensitive: boolean;
};

export type RuleRow = {
  id: string;
  text: string;
  kind: "pricing_modifier" | "scope" | "exclusion" | "process" | "other";
  effect: RuleEffect | null;
  status: "active" | "suggested" | "retired";
  by: string | null;
};

const UNIT_KINDS: UnitKind[] = ["each", "sqft", "linear_ft", "hour", "visit", "flat", "other"];
const dollars = (cents: number) => (cents / 100).toFixed(2);

/**
 * Adds an item, or edits one (name, unit, price, taxable, what it needs), through the same library as the assistant.
 * Without `item`, it's the "Add an item" button.
 */
export function ItemDialog({ item, language }: { item?: ItemRow; language: Language }) {
  const copy = pageCopyFor(language);
  const p = copy.pricebook;
  const [open, setOpen] = useState(false);
  const { send, busy, error, setError } = useMutation(copy.common.failed);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const priceCents = parseMoneyToCents(String(form.get("price") ?? ""));
    if (priceCents === null) return setError(p.errors.invalidPrice);
    const fields = {
      name: String(form.get("name") ?? "").trim(),
      unitKind: String(form.get("unitKind")) as UnitKind,
      unitLabel: String(form.get("unitLabel") ?? "").trim(),
      priceCents,
      taxable: form.get("taxable") === "on",
      equipment: equipmentList(String(form.get("equipment") ?? "")),
      weatherSensitive: form.get("weatherSensitive") === "on",
    };
    const saved = item
      ? await send("save", `/api/price-book/items/${item.id}`, { method: "PATCH", body: fields })
      : await send("save", "/api/price-book/items", { method: "POST", body: fields });
    if (saved) setOpen(false);
  }

  return (
    <>
      {item ? (
        <Button onClick={() => setOpen(true)} size="xs" variant="quiet">
          {p.editPrice}
        </Button>
      ) : (
        <Button onClick={() => setOpen(true)} size="xs" variant="secondary">
          <Plus aria-hidden="true" className="size-3.5" /> {p.addItem}
        </Button>
      )}
      <Dialog
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(undefined);
        }}
        open={open}
      >
        <DialogContent className="sm:max-w-md">
          <DialogTitle>{item ? p.editItemTitle(item.name) : p.newItemTitle}</DialogTitle>
          <form className="grid gap-4" onSubmit={submit}>
            <Field autoComplete="off" defaultValue={item?.name ?? ""} id="name" label={p.fields.name} maxLength={120} required />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field autoComplete="off" defaultValue={item ? dollars(item.priceCents) : ""} id="price" inputMode="decimal" label={p.fields.price} required />
              <Field autoComplete="off" defaultValue={item?.unitLabel ?? ""} id="unitLabel" label={p.fields.unitLabel} maxLength={40} placeholder={p.unitLabelPlaceholder} required />
              <Field id="unitKind" label={p.fields.unitKind}>
                <NativeSelect defaultValue={item?.unitKind ?? "each"} id="unitKind" name="unitKind">
                  {UNIT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {p.unitKinds[kind]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <label className="flex items-center gap-2 self-end pb-1.5 text-[13px]">
                <input className="size-4 accent-[var(--color-accent)]" defaultChecked={item?.taxable ?? true} name="taxable" type="checkbox" />
                {p.fields.taxable}
              </label>
            </div>
            <Field
              autoComplete="off"
              defaultValue={item?.equipment.join(", ") ?? ""}
              hint={p.equipmentHint}
              id="equipment"
              label={p.fields.equipment}
              maxLength={600}
              placeholder={p.equipmentPlaceholder}
            />
            <label className="flex items-start gap-2 text-[13px]">
              <input className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]" defaultChecked={item?.weatherSensitive ?? false} name="weatherSensitive" type="checkbox" />
              <span>
                {p.fields.weatherSensitive}
                <span className="block text-[12px] text-ink-3">{p.weatherSensitiveHint}</span>
              </span>
            </label>
            <ErrorLine>{error}</ErrorLine>
            <DialogFooter>
              <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
              <Button disabled={busy !== null} size="sm" type="submit" variant="primary">
                {busy ? copy.common.saving : copy.common.save}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The items, with an owner's edits and retire/restore. `canEdit` is false for a super admin looking. */
export function PricebookItems({ items, language, canEdit }: { items: ItemRow[]; language: Language; canEdit: boolean }) {
  const copy = pageCopyFor(language);
  const p = copy.pricebook;
  const { send, busy, error } = useMutation(copy.common.failed);

  if (items.length === 0) return <Nothing>{p.noItems}</Nothing>;
  return (
    <>
      <Table
        head={
          <>
            <Th>{p.columns.name}</Th>
            <Th className="hidden @xl:table-cell">{p.columns.unit}</Th>
            <Th className="text-right">{p.columns.price}</Th>
            <Th className="hidden @2xl:table-cell">{p.columns.taxable}</Th>
            <Th>{p.columns.status}</Th>
            {canEdit ? <Th className="text-right"><span className="sr-only">{copy.common.edit}</span></Th> : null}
          </>
        }
      >
        {items.map((item) => {
          const retired = item.status === "retired";
          return (
            <tr className={cn(retired && "text-ink-3")} key={item.id}>
              <Td>
                <span className={cn("font-medium", retired ? "text-ink-3" : "text-ink")}>{item.name}</span>
                <span className="block text-[12px] text-ink-3 sm:hidden">{item.unitLabel}</span>
                {item.equipment.length ? <span className="block text-[12px] text-ink-3">{p.needs(item.equipment.join(", "))}</span> : null}
                {item.weatherSensitive ? <span className="block text-[12px] text-ink-3">{p.fields.weatherSensitive}</span> : null}
              </Td>
              <Td className="hidden text-ink-2 @xl:table-cell">{item.unitLabel}</Td>
              <Td className="text-right whitespace-nowrap tabular-nums">{formatCents(item.priceCents, language)}</Td>
              <Td className="hidden @2xl:table-cell">{item.taxable ? copy.common.yes : copy.common.no}</Td>
              <Td>
                <StatusPill dot={!retired} tone={retired ? "neutral" : "green"}>
                  {p.itemStatus[item.status]}
                </StatusPill>
              </Td>
              {canEdit ? (
                <Td className="text-right whitespace-nowrap">
                  <span className="inline-flex flex-col items-end gap-1 sm:flex-row">
                    {!retired ? <ItemDialog item={item} language={language} /> : null}
                    <Button
                      disabled={busy !== null}
                      onClick={() =>
                        void send(`status:${item.id}`, `/api/price-book/items/${item.id}`, {
                          method: "PATCH",
                          body: { status: retired ? "active" : "retired" },
                        })
                      }
                      size="xs"
                      variant="quiet"
                    >
                      {retired ? p.restore : p.retire}
                    </Button>
                  </span>
                </Td>
              ) : null}
            </tr>
          );
        })}
      </Table>
      {error ? (
        <div className="border-t border-line px-4 py-2">
          <ErrorLine>{error}</ErrorLine>
        </div>
      ) : null}
    </>
  );
}

type RuleKind = RuleRow["kind"];
const RULE_KINDS: RuleKind[] = ["pricing_modifier", "scope", "exclusion", "process", "other"];

/** Adds an owner's rule, active now: the words, its kind, and for a pricing rule an optional price change on every item or one. */
export function RuleDialog({ items, language }: { items: Array<Pick<ItemRow, "id" | "name">>; language: Language }) {
  const copy = pageCopyFor(language);
  const p = copy.pricebook;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<RuleKind>("pricing_modifier");
  const [op, setOp] = useState<"none" | RuleEffect["op"]>("none");
  const { send, busy, error, setError } = useMutation(copy.common.failed);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let effect: RuleEffect | null = null;
    if (kind === "pricing_modifier" && op !== "none") {
      const raw = String(form.get("amount") ?? "").trim();
      const negative = raw.startsWith("-");
      const magnitude = op === "percent" ? Math.round(Number(raw.replace(/^[-+]/, "").replace(/%$/, "")) * 100) : parseMoneyToCents(raw.replace(/^[-+]/, ""));
      if (magnitude === null || !Number.isFinite(magnitude) || magnitude <= 0) return setError(p.errors.invalidAmount);
      const on = String(form.get("appliesTo") ?? "any");
      effect = { op, amount: negative ? -magnitude : magnitude, appliesTo: on === "any" ? "any" : [on] };
    }
    const saved = await send("save", "/api/price-book/rules", {
      method: "POST",
      body: { text: String(form.get("text") ?? "").trim(), kind, ...(effect ? { effect } : {}) },
    });
    if (saved) setOpen(false);
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} size="xs" variant="secondary">
        <Plus aria-hidden="true" className="size-3.5" /> {p.addRule}
      </Button>
      <Dialog
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setError(undefined);
            setKind("pricing_modifier");
            setOp("none");
          }
        }}
        open={open}
      >
        <DialogContent className="sm:max-w-md">
          <DialogTitle>{p.newRuleTitle}</DialogTitle>
          <form className="grid gap-4" onSubmit={submit}>
            <Field autoComplete="off" id="text" label={p.ruleFields.text} maxLength={500} placeholder={p.rulePlaceholder} required />
            <Field id="kind" label={p.ruleFields.kind}>
              <NativeSelect id="kind" onChange={(event) => setKind(event.target.value as RuleKind)} value={kind}>
                {RULE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {p.kinds[k]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {kind === "pricing_modifier" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="op" label={p.ruleFields.op}>
                  <NativeSelect id="op" onChange={(event) => setOp(event.target.value as typeof op)} value={op}>
                    {(["none", "add_fixed", "add_per_unit", "percent"] as const).map((o) => (
                      <option key={o} value={o}>
                        {p.ops[o]}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                {op !== "none" ? (
                  <>
                    <Field autoComplete="off" id="amount" inputMode="decimal" label={p.ruleFields.amount} placeholder={op === "percent" ? "10" : "50"} required />
                    <Field className="sm:col-span-2" id="appliesTo" label={p.ruleFields.appliesTo}>
                      <NativeSelect defaultValue="any" id="appliesTo" name="appliesTo">
                        <option value="any">{p.anyItem}</option>
                        {items.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                  </>
                ) : null}
              </div>
            ) : null}
            <ErrorLine>{error}</ErrorLine>
            <DialogFooter>
              <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
              <Button disabled={busy !== null} size="sm" type="submit" variant="primary">
                {busy ? copy.common.saving : copy.common.save}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function effectText(effect: RuleEffect | null, language: Language): string | null {
  if (!effect) return null;
  const p = pageCopyFor(language).pricebook;
  const sign = effect.amount < 0 ? "−" : "+";
  if (effect.op === "percent") return p.effect.percent(`${sign}${Math.abs(effect.amount) / 100}%`);
  const amount = `${sign}${formatCents(Math.abs(effect.amount), language, { concise: true })}`;
  return effect.op === "add_fixed" ? p.effect.add_fixed(amount) : p.effect.add_per_unit(amount);
}

const RULE_TONES = { active: "green", suggested: "orange", retired: "neutral" } as const;

/** The rules: crew suggestions to accept or turn down, and active rules to retire. */
export function PricebookRules({ rules, language, canEdit }: { rules: RuleRow[]; language: Language; canEdit: boolean }) {
  const copy = pageCopyFor(language);
  const p = copy.pricebook;
  const { send, busy, error } = useMutation(copy.common.failed);
  const act = (rule: RuleRow, action: "accept" | "retire") =>
    void send(`${action}:${rule.id}`, `/api/price-book/rules/${rule.id}`, { method: "POST", body: { action } });

  if (rules.length === 0) return <Nothing>{p.noRules}</Nothing>;
  return (
    <>
      <Table
        head={
          <>
            <Th>{p.columns.rule}</Th>
            <Th className="hidden @xl:table-cell">{p.columns.kind}</Th>
            <Th>{p.columns.status}</Th>
            <Th className="hidden @2xl:table-cell">{p.columns.by}</Th>
            {canEdit ? <Th><span className="sr-only">{copy.common.edit}</span></Th> : null}
          </>
        }
      >
        {rules.map((rule) => {
          const effect = effectText(rule.effect, language);
          return (
            <tr className={cn(rule.status === "retired" && "text-ink-3")} key={rule.id}>
              <Td>
                <span className="text-pretty">{rule.text}</span>
                {effect ? <span className="block text-[12px] text-ink-3 tabular-nums">{effect}</span> : null}
              </Td>
              <Td className="hidden whitespace-nowrap text-ink-2 @xl:table-cell">{p.kinds[rule.kind]}</Td>
              <Td>
                <StatusPill className="whitespace-nowrap" dot={rule.status !== "retired"} tone={RULE_TONES[rule.status]}>
                  {p.ruleStatus[rule.status]}
                </StatusPill>
              </Td>
              <Td className="hidden text-ink-2 @2xl:table-cell">{rule.by ?? copy.common.none}</Td>
              {canEdit ? (
                <Td className="text-right whitespace-nowrap">
                  {rule.status === "suggested" ? (
                    <span className="inline-flex flex-col items-end gap-1 sm:flex-row">
                      <Button disabled={busy !== null} onClick={() => act(rule, "accept")} size="xs" variant="primary">
                        {p.accept}
                      </Button>
                      <Button disabled={busy !== null} onClick={() => act(rule, "retire")} size="xs" variant="quiet">
                        {p.decline}
                      </Button>
                    </span>
                  ) : rule.status === "active" ? (
                    <Button disabled={busy !== null} onClick={() => act(rule, "retire")} size="xs" variant="quiet">
                      {p.retire}
                    </Button>
                  ) : null}
                </Td>
              ) : null}
            </tr>
          );
        })}
      </Table>
      {error ? (
        <div className="border-t border-line px-4 py-2">
          <ErrorLine>{error}</ErrorLine>
        </div>
      ) : null}
    </>
  );
}
