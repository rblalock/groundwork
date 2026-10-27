import Link from "next/link";
import { notFound } from "next/navigation";
import { activityFor, activitySummary, type ActivityRow } from "@/core/conversation-events";
import { getOrganization } from "@/core/organizations";
import { getProfile } from "@/core/profile";
import { Card, Crumb, Nothing, PageBody, Table, Td, Th } from "@/components/pages/kit";
import { PaperPage } from "@/components/paper";
import { formatDateTime } from "@/lib/format";
import { pageSuperAdmin } from "@/lib/page-session";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";

const PAGE = 100;

const KIND_LABEL: Record<string, string> = {
  "turn.started": "Turn started",
  "message.received": "Received",
  "message.completed": "Replied",
  "tool.started": "Tool called",
  "tool.completed": "Tool finished",
  "turn.completed": "Turn completed",
  "turn.failed": "Turn failed",
  "turn.cancelled": "Turn cancelled",
};

function tone(row: ActivityRow): "green" | "red" | "orange" | "neutral" {
  if (row.kind === "turn.failed" || row.status === "error") return "red";
  if (row.kind === "turn.cancelled" || row.status === "rejected") return "orange";
  if (row.kind === "turn.completed" || row.status === "ok") return "green";
  return "neutral";
}

function detail(row: ActivityRow) {
  if (row.kind === "tool.started") return <span className="font-mono text-[12px]">{row.toolName}</span>;
  if (row.kind === "tool.completed") {
    return (
      <span className="font-mono text-[12px]">
        {row.toolName} · {row.status}
        {row.durationMs !== null ? ` · ${row.durationMs} ms` : ""}
        {row.error ? ` · ${row.error}` : ""}
      </span>
    );
  }
  if (row.kind === "turn.failed") return <span className="font-mono text-[12px]">{row.error ?? "failed"}</span>;
  return row.text ? <span className="line-clamp-3 whitespace-pre-line text-pretty">{row.text}</span> : null;
}

/**
 * A business's conversation activity, for super admins: each turn the assistant ran, what came in and
 * went out, and every tool call with its outcome and time. Newest first, a hundred at a time.
 */
export default async function ActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ before?: string; member?: string }>;
}) {
  await pageSuperAdmin();
  const { id } = await params;
  const { before, member } = await searchParams;
  const org = await getOrganization(id);
  if (!org) notFound();
  const beforeAt = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : undefined;
  const [rows, summary, profile] = await Promise.all([
    activityFor(org.id, { limit: PAGE, before: beforeAt, memberId: member || undefined }),
    activitySummary(org.id, new Date(Date.now() - 24 * 60 * 60_000)),
    getProfile(org.id),
  ]);
  const older = rows.length === PAGE ? rows[rows.length - 1].at : null;
  const query = (extra: Record<string, string | undefined>) => {
    const search = new URLSearchParams(Object.entries({ member: member || undefined, ...extra }).filter((e): e is [string, string] => Boolean(e[1])));
    const text = search.toString();
    return `/admin/${org.id}/activity${text ? `?${text}` : ""}`;
  };
  return (
    <PaperPage title={<Crumb href="/admin" parent="Businesses">{org.name} activity</Crumb>}>
      <PageBody>
        <p className="text-sm text-ink-2">
          Last 24 hours: {summary.turns} turns, {summary.failed} failed; {summary.tools} tool calls, {summary.toolErrors} with an error.
          Times are in {profile.timeZone}. Kept for 180 days.
        </p>
        {member ? (
          <p className="text-[13px] text-ink-2">
            One member only. <Link className="text-accent-ink underline" href={query({ member: undefined })}>Show everyone</Link>
          </p>
        ) : null}
        <Card flush>
          {rows.length === 0 ? (
            <Nothing>No activity recorded{beforeAt ? " before this" : ""}.</Nothing>
          ) : (
            <Table
              head={
                <>
                  <Th>When</Th>
                  <Th>Member</Th>
                  <Th>Where</Th>
                  <Th>Event</Th>
                  <Th>Detail</Th>
                </>
              }
            >
              {rows.map((row) => (
                <tr key={row.id}>
                  <Td className="whitespace-nowrap text-ink-2">{formatDateTime(row.at, "en", profile.timeZone)}</Td>
                  <Td className="whitespace-nowrap">
                    {row.memberId ? (
                      <Link className="hover:underline" href={query({ member: row.memberId })}>
                        {row.memberName ?? row.memberId}
                      </Link>
                    ) : (
                      "None"
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-ink-2">
                    {row.conversationKind === "job" ? `Job: ${row.conversationTitle ?? row.conversationId}` : "Thread"}
                    {row.origin ? ` · ${row.origin}` : ""}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <StatusPill dot={false} tone={tone(row)}>
                      {KIND_LABEL[row.kind] ?? row.kind}
                    </StatusPill>
                  </Td>
                  <Td className="max-w-md text-ink">{detail(row)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        {older ? (
          <p className="pb-8 text-[13px]">
            <Link className="text-accent-ink underline" href={query({ before: older })}>
              Older
            </Link>
          </p>
        ) : null}
      </PageBody>
    </PaperPage>
  );
}
