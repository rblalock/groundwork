import Link from "next/link";
import { allBusinessesUsage } from "@/core/usage-report";
import { Card, Crumb, Nothing, PageBody, Table, Td, Th } from "@/components/pages/kit";
import { formatTokens, formatUsd } from "@/components/pages/usage-report";
import { PaperPage } from "@/components/paper";
import { pageSuperAdmin } from "@/lib/page-session";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";

const DAYS = 30;

/** Every business's usage over the last 30 days, most expensive first, for super admins. */
export default async function AdminUsagePage() {
  await pageSuperAdmin();
  const rows = await allBusinessesUsage({ since: new Date(Date.now() - DAYS * 24 * 60 * 60_000) });
  const total = rows.reduce((sum, row) => sum + row.estimatedCostUsd, 0);
  return (
    <PaperPage title={<Crumb href="/admin" parent="Businesses">Usage</Crumb>}>
      <PageBody>
        <p className="text-sm text-ink-2">
          The last {DAYS} days, most expensive first: {formatUsd(total, "en")} estimated across every business. Costs are estimates at the model's list prices, not
          the Meta bill.
        </p>
        <Card flush>
          {rows.length === 0 ? (
            <Nothing>No businesses yet.</Nothing>
          ) : (
            <Table
              head={
                <>
                  <Th>Business</Th>
                  <Th className="text-right">Turns</Th>
                  <Th className="text-right">Output tokens</Th>
                  <Th className="hidden text-right @xl:table-cell">Input tokens</Th>
                  <Th className="text-right">Est. cost</Th>
                  <Th>Limits</Th>
                </>
              }
            >
              {rows.map((row) => (
                <tr className="relative transition-colors hover:bg-hover" key={row.orgId}>
                  <Td>
                    <Link className="font-medium text-ink after:absolute after:inset-0" href={`/admin/${row.orgId}/usage`}>
                      {row.name}
                    </Link>
                    {row.suspended ? <span className="ml-2 text-[12px] text-ink-3">Paused</span> : null}
                  </Td>
                  <Td className="text-right tabular-nums">{row.turns}</Td>
                  <Td className="text-right tabular-nums">{formatTokens(row.outputTokens, "en")}</Td>
                  <Td className="hidden text-right tabular-nums @xl:table-cell">{formatTokens(row.inputTokens, "en")}</Td>
                  <Td className="text-right tabular-nums">{formatUsd(row.estimatedCostUsd, "en")}</Td>
                  <Td>
                    <StatusPill dot={false} tone={row.customLimits ? "accent" : "neutral"}>
                      {row.customLimits ? "Custom" : "Default"}
                    </StatusPill>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </PaperPage>
  );
}
