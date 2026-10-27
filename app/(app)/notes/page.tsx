import { NotebookText } from "lucide-react";
import { SearchBox } from "@/components/pages/client-kit";
import { Card, Nothing, PageBody, ViewingNotice } from "@/components/pages/kit";
import { NoteEditor } from "@/components/pages/note-editors";
import { NoteList } from "@/components/pages/note-list";
import { EmptyState, PaperPage } from "@/components/paper";
import { isPrivileged } from "@/core/members";
import { getProfile } from "@/core/profile";
import { pageCopyFor } from "@/lib/page-copy";
import { pageMember } from "@/lib/page-session";
import { canEditNote, notesFor } from "@/lib/pages/notes";

/**
 * How the business works and the notes on its customers. Everyone reads the business-wide notes; owners
 * and admins write them. Crew see the notes on their own work too, and change only their own.
 */
export default async function NotesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const caller = await pageMember();
  const query = (await searchParams).q?.trim() ?? "";
  const [page, profile] = await Promise.all([notesFor(caller, query), getProfile(caller.orgId)]);
  // Whether there are any at all, so an empty search isn't mistaken for no notes.
  const all = query ? await notesFor(caller) : page;
  const any = all.business.length + all.linked.length > 0;
  const { language } = caller;
  const copy = pageCopyFor(language);
  const n = copy.notes;
  const canAdd = caller.memberId !== null && isPrivileged(caller.role);
  const editable = (note: Parameters<typeof canEditNote>[1]) => canEditNote(caller, note);

  return (
    <PaperPage actions={canAdd ? <NoteEditor language={language} /> : null} title={n.title}>
      <PageBody>
        {caller.memberId === null ? <ViewingNotice language={language} /> : null}
        {!any ? (
          <EmptyState icon={<NotebookText size={18} />}>{n.empty}</EmptyState>
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-prose text-[12px] text-ink-3 text-pretty">{n.intro}</p>
              <SearchBox label={copy.common.search} placeholder={n.searchPlaceholder} />
            </div>
            {query && page.business.length + page.linked.length === 0 ? (
              <Card>
                <Nothing>{n.noMatch}</Nothing>
              </Card>
            ) : (
              <>
                <Card description={n.businessHelp} flush title={n.business}>
                  {page.business.length ? (
                    <NoteList editable={editable} language={language} notes={page.business} timeZone={profile.timeZone} />
                  ) : (
                    <Nothing>{query ? n.noMatch : n.noBusiness}</Nothing>
                  )}
                </Card>
                <Card description={n.linkedHelp} flush title={n.linked}>
                  {page.linked.length ? (
                    <NoteList editable={editable} language={language} notes={page.linked} timeZone={profile.timeZone} />
                  ) : (
                    <Nothing>{query ? n.noMatch : n.noLinked}</Nothing>
                  )}
                </Card>
              </>
            )}
          </>
        )}
      </PageBody>
    </PaperPage>
  );
}
