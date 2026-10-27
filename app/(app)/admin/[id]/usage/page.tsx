import { notFound } from "next/navigation";
import { getOrganization } from "@/core/organizations";
import { getProfile } from "@/core/profile";
import { usageNow } from "@/core/usage-limits";
import { isMonth, monthlyUsage, recentReceipts } from "@/core/usage-report";
import { AdminUsageLimits } from "@/components/admin-usage-limits";
import { Card, Crumb, Nothing, PageBody, Table, Td, Th } from "@/components/pages/kit";
import { formatTokens, formatUsd, HourMeters, UsageReport } from "@/components/pages/usage-report";
import { PaperPage } from "@/components/paper";
import { formatDateTime } from "@/lib/format";
import { pageSuperAdmin } from "@/lib/page-session";

/**
 * One business's usage, for super admins: the same report its owner sees under Settings → Usage, its
 * limits to raise or lower, and its latest model calls.
 */
export default async function AdminBusinessUsagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  await pageSuperAdmin();
  const { id } = await params;
  const { month } = await searchParams;
  const org = await getOrganization(id);
  if (!org) notFound();
  const profile = await getProfile(org.id);
  const [usage, hour, receipts] = await Promise.all([
    monthlyUsage(org.id, { timeZone: profile.timeZone, month: isMonth(month) ? month : undefined }),
    usageNow(org.id),
    recentReceipts(org.id, 15),
  ]);
  return (
    <PaperPage title={<Crumb href="/admin/usage" parent="Usage">{org.name}</Crumb>}>
      <PageBody>
        <HourMeters language="en" limits={hour.limits} window={hour.window} />
        <AdminUsageLimits defaults={hour.defaults} orgId={org.id} overrides={hour.overrides} />
        <UsageReport language="en" monthHref={(m) => `/admin/${org.id}/usage?month=${m}`} usage={usage} />
        <Card description="Each model call, newest first. Costs are estimates at list prices." flush title="Latest calls">
          {receipts.length === 0 ? (
            <Nothing>No model calls recorded yet.</Nothing>
          ) : (
            <Table
              head={
                <>
                  <Th>When</Th>
                  <Th>Member</Th>
                  <Th>Channel</Th>
                  <Th className="hidden @2xl:table-cell">Deployment</Th>
                  <Th className="text-right">Input (cached)</Th>
                  <Th className="text-right">Output (reasoning)</Th>
                  <Th className="text-right">Est. cost</Th>
                </>
              }
            >
              {receipts.map((row) => (
                <tr key={row.id}>
                  <Td className="whitespace-nowrap text-ink-2">{formatDateTime(row.at, "en", profile.timeZone)}</Td>
                  <Td className="whitespace-nowrap">{row.memberName ?? "None"}</Td>
                  <Td className="whitespace-nowrap text-ink-2">
                    {row.channel}
                    {row.kind === "compaction" ? " · compaction" : ""}
                  </Td>
                  <Td className="hidden font-mono text-[12px] @2xl:table-cell">
                    {row.deployment}
                    {row.priceSource === "fallback" ? " (unlisted price)" : ""}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {formatTokens(row.inputTokens, "en")} ({formatTokens(row.cachedInputTokens, "en")})
                  </Td>
                  <Td className="text-right tabular-nums">
                    {formatTokens(row.outputTokens, "en")} ({row.reasoningTokens === null ? "–" : formatTokens(row.reasoningTokens, "en")})
                  </Td>
                  <Td className="text-right tabular-nums">{formatUsd(row.estimatedCostUsd, "en")}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </PaperPage>
  );
}
