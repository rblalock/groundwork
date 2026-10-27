import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { CustomerPageEditor } from "@/components/customer-pages/editor";
import { Crumb, PageBody, ViewingNotice } from "@/components/pages/kit";
import { PaperPage } from "@/components/paper";
import { pagePrivileged } from "@/lib/page-session";
import { pageCopyFor } from "@/lib/page-copy";
import { designSessionFor, editorFor, pageKindSchema } from "@/lib/pages/customer-pages";

/**
 * A customer page's designer (Settings → Branding → Customer pages), for owners and admins: their
 * conversation with the page designer beside the page. `?v=` opens on a version.
 */
export default async function CustomerPageDesignPage({ params, searchParams }: { params: Promise<{ page: string }>; searchParams: Promise<{ v?: string }> }) {
  const caller = await pagePrivileged();
  const parsed = pageKindSchema.safeParse((await params).page);
  if (!parsed.success) notFound();
  const page = parsed.data;
  const { v } = await searchParams;
  const data = await editorFor(caller, page);
  const sessionId = caller.memberId === null ? null : await designSessionFor(caller, page, (await headers()).get("cookie") ?? "");
  const t = pageCopyFor(caller.language).customerPages;
  return (
    <PaperPage title={<Crumb href="/settings/branding" parent={t.back}>{t.pages[page]}</Crumb>}>
      <PageBody className="max-w-6xl pb-8">
        {caller.memberId === null ? <ViewingNotice language={caller.language} /> : null}
        <CustomerPageEditor
          hasRecent={data.hasRecent}
          initialVersion={v && /^\d+$/.test(v) ? Number(v) : null}
          language={caller.language}
          latest={data.state.latest?.version ?? null}
          page={page}
          published={data.state.published?.version ?? null}
          sessionId={sessionId}
          versions={data.versions.map(({ version, request }) => ({ version, request }))}
        />
      </PageBody>
    </PaperPage>
  );
}
