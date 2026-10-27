import Link from "next/link";
import { localeFor, type Language } from "@/core/language";
import type { MonthlyUsage, UsageTotals } from "@/core/usage-report";
import type { Limits, UsageWindow } from "@/core/usage-limits";
import { Stat } from "@/components/invoices/kit";
import { Card, Nothing, Table, Td, Th } from "@/components/pages/kit";
import { pageCopyFor } from "@/lib/page-copy";
import { cn } from "@/ui/lib/utils";

// A business's usage for one month: its totals, the last hour against its limits, a bar per day, and
// tables by channel and by member. Shared by Settings → Usage (owners and admins) and the super
// admins' page for one business. Every cost is an estimate, and says so.

export function formatTokens(value: number, language: Language): string {
  return new Intl.NumberFormat(localeFor(language), { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export function formatUsd(value: number, language: Language): string {
  return new Intl.NumberFormat(localeFor(language), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 1 ? 4 : 2,
  }).format(value);
}

const percent = (part: number, whole: number, language: Language) =>
  new Intl.NumberFormat(localeFor(language), { style: "percent", maximumFractionDigits: 0 }).format(whole > 0 ? part / whole : 0);

export function monthLabel(month: string, language: Language): string {
  const [year, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(localeFor(language), { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, m - 1, 1)));
}

export function shiftMonth(month: string, by: number): string {
  const [year, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, m - 1 + by, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function Meter({ label, used, limit, value }: { label: string; used: number; limit: number; value: string }) {
  const share = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-ink-2">{label}</span>
        <span className="tabular-nums text-ink">{value}</span>
      </div>
      <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-inset">
        <div className={cn("h-full rounded-full", share >= 1 ? "bg-red" : share >= 0.8 ? "bg-orange" : "bg-accent")} style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

/** The last hour against the business's limits. */
export function HourMeters({ window, limits, language }: { window: UsageWindow; limits: Limits; language: Language }) {
  const u = pageCopyFor(language).usage;
  const n = (value: number) => formatTokens(value, language);
  return (
    <Card description={u.hourHelp} title={u.hour}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Meter label={u.hourTurns} limit={limits.hourlyTurns} used={window.turns} value={u.of(n(window.turns), n(limits.hourlyTurns))} />
        <Meter label={u.hourOutput} limit={limits.hourlyOutputTokens} used={window.outputTokens} value={u.of(n(window.outputTokens), n(limits.hourlyOutputTokens))} />
        <Meter label={u.hourRunning} limit={limits.concurrentTurns} used={window.active} value={u.of(n(window.active), n(limits.concurrentTurns))} />
      </div>
    </Card>
  );
}

function DailyBars({ days, language }: { days: MonthlyUsage["byDay"]; language: Language }) {
  const u = pageCopyFor(language).usage;
  const max = Math.max(...days.map((d) => d.estimatedCostUsd), 0);
  const dayLabel = (ymd: string) => String(Number(ymd.slice(8, 10)));
  return (
    <Card description={u.dailyHelp} title={u.daily}>
      <div className="flex h-32 items-end gap-[3px]" role="img" aria-label={u.daily}>
        {days.map((day) => (
          <div className="flex h-full min-w-0 flex-1 flex-col justify-end" key={day.day} title={`${day.day}: ${formatUsd(day.estimatedCostUsd, language)} · ${day.turns} ${u.columns.turns.toLowerCase()}`}>
            <div
              className={cn("w-full rounded-t-[3px]", day.estimatedCostUsd > 0 ? "bg-accent" : "bg-line")}
              style={{ height: max > 0 && day.estimatedCostUsd > 0 ? `${Math.max(4, (day.estimatedCostUsd / max) * 100)}%` : "2px" }}
            />
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="mt-1.5 flex gap-[3px] text-[11px] text-ink-3 tabular-nums">
        {days.map((day, i) => (
          <span className="min-w-0 flex-1 text-center" key={day.day}>
            {i === 0 || (i + 1) % 5 === 0 ? dayLabel(day.day) : ""}
          </span>
        ))}
      </div>
    </Card>
  );
}

function TotalsCells({ row, language }: { row: UsageTotals; language: Language }) {
  return (
    <>
      <Td className="text-right tabular-nums">{row.turns}</Td>
      <Td className="text-right tabular-nums">{formatTokens(row.outputTokens, language)}</Td>
      <Td className="hidden text-right tabular-nums @xl:table-cell">{formatTokens(row.inputTokens, language)}</Td>
      <Td className="text-right tabular-nums">{formatUsd(row.estimatedCostUsd, language)}</Td>
    </>
  );
}

function TotalsHead({ first, language }: { first: string; language: Language }) {
  const c = pageCopyFor(language).usage.columns;
  return (
    <>
      <Th>{first}</Th>
      <Th className="text-right">{c.turns}</Th>
      <Th className="text-right">{c.output}</Th>
      <Th className="hidden text-right @xl:table-cell">{c.input}</Th>
      <Th className="text-right">{c.cost}</Th>
    </>
  );
}

/** The month's usage. `monthHref` builds the link to another month; without it there's no month switcher. */
export function UsageReport({ usage, language, monthHref }: { usage: MonthlyUsage; language: Language; monthHref?: (month: string) => string }) {
  const u = pageCopyFor(language).usage;
  const { totals } = usage;
  const current = shiftMonth(usage.month, 0);
  const isFuture = (month: string) => month > new Date().toISOString().slice(0, 7);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-sm text-ink-2">{u.intro(monthLabel(usage.month, language), usage.timeZone)}</p>
          <p className="text-[12px] text-ink-3">
            {u.estimateNote}
            {usage.fallbackPriced ? ` ${u.fallbackNote}` : ""}
          </p>
        </div>
        {monthHref ? (
          <nav className="flex gap-3 text-[13px]">
            <Link className="text-accent-ink hover:underline" href={monthHref(shiftMonth(current, -1))}>
              ← {u.previous}
            </Link>
            {!isFuture(shiftMonth(current, 1)) ? (
              <Link className="text-accent-ink hover:underline" href={monthHref(shiftMonth(current, 1))}>
                {u.next} →
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Stat help={u.stats.turnsHelp} label={u.stats.turns} value={totals.turns} />
        <Stat
          help={u.stats.outputHelp(percent(totals.reasoningTokens, totals.outputTokens, language))}
          label={u.stats.output}
          value={formatTokens(totals.outputTokens, language)}
        />
        <Stat
          help={u.stats.inputHelp(percent(totals.cachedInputTokens, totals.inputTokens, language))}
          label={u.stats.input}
          value={formatTokens(totals.inputTokens, language)}
        />
        <Stat help={u.stats.costHelp} label={u.stats.cost} value={formatUsd(totals.estimatedCostUsd, language)} />
      </div>
      <DailyBars days={usage.byDay} language={language} />
      <div className="grid gap-6 @3xl:grid-cols-2">
        <Card flush title={u.byChannel}>
          {usage.byChannel.length === 0 ? (
            <Nothing>{u.empty}</Nothing>
          ) : (
            <Table head={<TotalsHead first={u.columns.channel} language={language} />}>
              {usage.byChannel.map((row) => (
                <tr key={row.channel}>
                  <Td>{u.channels[row.channel] ?? row.channel}</Td>
                  <TotalsCells language={language} row={row} />
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card flush title={u.byMember}>
          {usage.byMember.length === 0 ? (
            <Nothing>{u.empty}</Nothing>
          ) : (
            <Table head={<TotalsHead first={u.columns.member} language={language} />}>
              {usage.byMember.map((row) => (
                <tr key={row.memberId ?? "none"}>
                  <Td>{row.name ?? u.noMember}</Td>
                  <TotalsCells language={language} row={row} />
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
