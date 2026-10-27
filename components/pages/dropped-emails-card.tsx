import type { Language } from "@/core/language";
import { formatDate } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import type { DroppedEmail } from "@/lib/pages/settings";
import { Card, Nothing, Table, Td, Th } from "./kit";

/** Settings → Email: the latest emails the assistant didn't take, and why. Never their contents. */
export function DroppedEmailsCard({ dropped, language, timeZone }: { dropped: DroppedEmail[]; language: Language; timeZone: string }) {
  const t = pageCopyFor(language).dropped;
  return (
    <Card flush title={t.title}>
      {dropped.length === 0 ? (
        <Nothing>{t.empty}</Nothing>
      ) : (
        <Table
          head={
            <>
              <Th>{t.columns.when}</Th>
              <Th>{t.columns.from}</Th>
              <Th className="hidden @2xl:table-cell">{t.columns.subject}</Th>
              <Th>{t.columns.reason}</Th>
            </>
          }
        >
          {dropped.map((email) => (
            <tr key={email.id}>
              <Td className="whitespace-nowrap text-ink-2">{formatDate(new Date(email.at), language, timeZone)}</Td>
              <Td className="max-w-[24ch] truncate">{email.from ?? "—"}</Td>
              <Td className="hidden max-w-[32ch] truncate text-ink-2 @2xl:table-cell">{email.subject || t.noSubject}</Td>
              <Td className="text-ink-2">{t.reasons[email.reason] ?? t.other}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
