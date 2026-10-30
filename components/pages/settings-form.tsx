"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import type { Language } from "@/core/language";
import { parseMoneyToCents } from "@/core/money";
import { hourLabel } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import { Card } from "./kit";
import { ErrorLine, Field, NativeSelect, useMutation } from "./client-kit";

export type SettingsValues = {
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  licenseNumber: string | null;
  timeZone: string;
  quietStartHour: number;
  quietEndHour: number;
  quoteValidityDays: number;
  followUpDays: number;
  minimumChargeCents: number | null;
  taxRateBp: number | null;
  paymentTermsDays: number;
  depositPercent: number;
  customerLinePrices: boolean;
  language: Language;
  townMph: number;
  roadFactorBp: number;
  minDriveMinutes: number;
  capacityBp: number;
  /** Whether the address (the yard) is placed, and where. */
  yard: { status: "pending" | "ok" | "not_found" | "failed"; label: string | null };
};

const TIME_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

const dollars = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2).replace(/\.00$/, ""));
const percent = (bp: number | null) => (bp === null ? "" : String(bp / 100));
const text = (value: FormDataEntryValue | null) => {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};

const factor = (bp: number) => String(bp / 10_000);

/** "1.3" → 13000 basis points, from 1 to 3; anything else → undefined (invalid). */
function parseFactor(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d(\.\d{1,2})?$/.test(trimmed)) return undefined;
  const bp = Math.round(Number(trimmed) * 10_000);
  return bp >= 10_000 && bp <= 30_000 ? bp : undefined;
}

/** "7.25" → 725 basis points; blank → null; anything else → undefined (invalid). */
function parsePercent(value: string): number | null | undefined {
  const trimmed = value.trim().replace(/%$/, "");
  if (trimmed === "") return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return undefined;
  const bp = Math.round(Number(trimmed) * 100);
  return bp <= 10_000 ? bp : undefined;
}

export type SettingsSection = "business" | "schedule" | "invoicing" | "pricing";

/**
 * The business profile, saved through the same rules as update_profile. Only changed fields are stored.
 * `sections` are the cards this tab shows; it saves only their fields.
 */
export function SettingsForm({
  values,
  language,
  canEdit,
  canEditOwnerFields = canEdit,
  sections,
}: {
  values: SettingsValues;
  language: Language;
  canEdit: boolean;
  /** The deposit is the owner's: an admin sees it, locked. */
  canEditOwnerFields?: boolean;
  sections: SettingsSection[];
}) {
  const shows = (section: SettingsSection) => sections.includes(section);
  const copy = pageCopyFor(language);
  const s = copy.settings;
  const { send, busy, error, setError } = useMutation(copy.common.failed);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(undefined);
    const form = new FormData(event.currentTarget);
    const errors: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    if (shows("business")) {
      body = {
        ...body,
        name: String(form.get("name") ?? "").trim(),
        phone: text(form.get("phone")),
        email: text(form.get("email")),
        address: text(form.get("address")),
        licenseNumber: text(form.get("licenseNumber")),
      };
    }
    if (shows("schedule")) {
      body = {
        ...body,
        timeZone: String(form.get("timeZone")),
        language: String(form.get("language")),
        quietStartHour: Number(form.get("quietStartHour")),
        quietEndHour: Number(form.get("quietEndHour")),
        quoteValidityDays: Number(form.get("quoteValidityDays")),
        followUpDays: Number(form.get("followUpDays")),
        townMph: Number(form.get("townMph")),
        minDriveMinutes: Number(form.get("minDriveMinutes")),
        capacityBp: Number(form.get("capacity")) * 100,
      };
      const roadFactorBp = parseFactor(String(form.get("roadFactor") ?? ""));
      if (roadFactorBp === undefined) errors.roadFactor = s.errors.factor;
      body = { ...body, roadFactorBp };
    }
    if (shows("invoicing")) {
      body = { ...body, paymentTermsDays: Number(form.get("paymentTermsDays")) };
      if (canEditOwnerFields) body = { ...body, depositPercent: Number(form.get("depositPercent")) };
    }
    if (shows("pricing")) {
      const minimumRaw = String(form.get("minimumCharge") ?? "").trim();
      const minimumChargeCents = minimumRaw === "" ? null : parseMoneyToCents(minimumRaw);
      if (minimumRaw !== "" && minimumChargeCents === null) errors.minimumCharge = s.errors.money;
      const taxRateBp = parsePercent(String(form.get("taxRate") ?? ""));
      if (taxRateBp === undefined) errors.taxRate = s.errors.percent;
      body = { ...body, minimumChargeCents, taxRateBp, customerLinePrices: form.get("customerLinePrices") === "on" };
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      setError(s.errors.invalid);
      return;
    }
    const saved = await send<{ changed: string[] }>("save", "/api/settings", { method: "PATCH", body });
    if (saved) setNotice(saved.changed.length ? s.saved : s.nothingChanged);
  }

  const zones = TIME_ZONES.includes(values.timeZone) ? TIME_ZONES : [values.timeZone, ...TIME_ZONES];
  return (
    <form className="space-y-6" onSubmit={submit}>
      <fieldset className="min-w-0 space-y-6" disabled={!canEdit}>
        {shows("business") ? (
          <Card description={s.businessHelp} title={s.business}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field autoComplete="organization" defaultValue={values.name} id="name" label={s.name} required />
              <Field autoComplete="off" defaultValue={values.licenseNumber ?? ""} id="licenseNumber" label={s.license} />
              <Field autoComplete="off" defaultValue={values.phone ?? ""} id="phone" inputMode="tel" label={s.phone} type="tel" />
              <Field autoComplete="off" defaultValue={values.email ?? ""} id="email" label={s.email} type="email" />
              <Field
                autoComplete="off"
                className="sm:col-span-2"
                defaultValue={values.address ?? ""}
                hint={values.address ? s.yard[values.yard.status](values.yard.label ?? values.address) : s.yardHelp}
                id="address"
                label={s.address}
              />
            </div>
          </Card>
        ) : null}

        {shows("schedule") ? (
          <Card title={s.schedule}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="timeZone" label={s.timeZone}>
                <NativeSelect defaultValue={values.timeZone} id="timeZone" name="timeZone">
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone.replace(/_/g, " ")}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field id="language" label={s.language}>
                <NativeSelect defaultValue={values.language} id="language" name="language">
                  <option value="en">{copy.common.languages.en}</option>
                  <option value="es">{copy.common.languages.es}</option>
                </NativeSelect>
              </Field>
              <Field hint={s.quietHelp} id="quietStartHour" label={s.quietStart}>
                <NativeSelect defaultValue={values.quietStartHour} id="quietStartHour" name="quietStartHour">
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {hourLabel(h, language)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field id="quietEndHour" label={s.quietEnd}>
                <NativeSelect defaultValue={values.quietEndHour} id="quietEndHour" name="quietEndHour">
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {hourLabel(h, language)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field
                defaultValue={values.quoteValidityDays}
                id="quoteValidityDays"
                inputMode="numeric"
                label={s.validity}
                max={365}
                min={1}
                required
                type="number"
              />
              <Field defaultValue={values.followUpDays} id="followUpDays" inputMode="numeric" label={s.followUp} max={60} min={1} required type="number" />
              <Field defaultValue={values.townMph} hint={s.townMphHelp} id="townMph" inputMode="numeric" label={s.townMph} max={65} min={5} required type="number" />
              <Field
                autoComplete="off"
                defaultValue={factor(values.roadFactorBp)}
                error={fieldErrors.roadFactor}
                hint={s.roadFactorHelp}
                id="roadFactor"
                inputMode="decimal"
                label={s.roadFactor}
                placeholder="1.3"
              />
              <Field
                defaultValue={values.minDriveMinutes}
                id="minDriveMinutes"
                inputMode="numeric"
                label={s.minDrive}
                max={60}
                min={0}
                required
                type="number"
              />
              <Field
                defaultValue={Math.round(values.capacityBp / 100)}
                hint={s.capacityHelp}
                id="capacity"
                inputMode="numeric"
                label={s.capacity}
                max={100}
                min={50}
                required
                type="number"
              />
            </div>
          </Card>
        ) : null}

        {shows("invoicing") ? (
          <Card title={s.invoicing}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                defaultValue={values.paymentTermsDays}
                hint={s.paymentTermsHelp}
                id="paymentTermsDays"
                inputMode="numeric"
                label={s.paymentTerms}
                max={120}
                min={0}
                required
                type="number"
              />
              <Field
                defaultValue={values.depositPercent}
                disabled={!canEditOwnerFields}
                hint={canEditOwnerFields ? s.depositHelp : s.depositOwnerOnly}
                id="depositPercent"
                inputMode="numeric"
                label={s.deposit}
                max={100}
                min={0}
                required
                type="number"
              />
            </div>
          </Card>
        ) : null}

        {shows("pricing") ? (
          <Card title={s.pricing}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                autoComplete="off"
                defaultValue={dollars(values.minimumChargeCents)}
                error={fieldErrors.minimumCharge}
                hint={s.minimumHelp}
                id="minimumCharge"
                inputMode="decimal"
                label={s.minimum}
                placeholder="150"
              />
              <Field
                autoComplete="off"
                defaultValue={percent(values.taxRateBp)}
                error={fieldErrors.taxRate}
                hint={s.taxHelp}
                id="taxRate"
                inputMode="decimal"
                label={s.tax}
                placeholder="7.25"
              />
              <div className="grid gap-1.5 sm:col-span-2">
                <label className="flex items-center gap-2 text-[13px] text-ink">
                  <input
                    className="size-4 accent-[var(--color-ink)]"
                    defaultChecked={values.customerLinePrices}
                    id="customerLinePrices"
                    name="customerLinePrices"
                    type="checkbox"
                  />
                  {s.linePrices}
                </label>
                <p className="text-[12px] text-ink-3 text-pretty">{s.linePricesHelp}</p>
              </div>
            </div>
          </Card>
        ) : null}
      </fieldset>

      {canEdit ? (
        <div className="flex items-center justify-end gap-3">
          {notice ? (
            <p className="text-[13px] text-ink-2" role="status">
              {notice}
            </p>
          ) : null}
          <ErrorLine>{error}</ErrorLine>
          <Button disabled={busy !== null} size="sm" type="submit" variant="primary">
            {busy ? copy.common.saving : s.save}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
