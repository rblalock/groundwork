import Link from "next/link";
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
import { anyArchivedNotes, canEditNote, notesFor } from "@/lib/pages/notes";
import { cn } from "@/ui/lib/utils";

/**
 * How the business works and the notes on its customers. Everyone reads the business-wide notes; owners
 * and admins write them. Crew see the notes on their own work too, and change only their own.
 * `?view=archived` lists the archived ones, to bring back.
 */
export default async function NotesPage({ searchParams }: { searchParams: Promise<{ q?: string; view?: string }> }) {
  const caller = await pageMember();
  const params = await searchParams;
  const archived = params.view === "archived";
  const query = archived ? "" : (params.q?.trim() ?? "");
  const [page, profile, anyArchived] = await Promise.all([notesFor(caller, query, { archived }), getProfile(caller.orgId), anyArchivedNotes(caller)]);
  // Whether there are any at all, so an empty search isn't mistaken for no notes.
  const all = anyArchived ? null : query || archived ? await notesFor(caller) : page;
  const any = anyArchived || (all !== null && all.business.length + all.linked.length > 0);
  const { language } = caller;
  const copy = pageCopyFor(language);
  const n = copy.notes;
  const canAdd = caller.memberId !== null && isPrivileged(caller.role);
  const editable = (note: Parameters<typeof canEditNote>[1]) => canEditNote(caller, note);
  const views = [
    { key: "live", label: n.views.live, href: "/notes", active: !archived },
    { key: "archived", label: n.views.archived, href: "/notes?view=archived", active: archived },
  ];
  const archivedNotes = [...page.business, ...page.linked].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  return (
    <PaperPage actions={canAdd ? <NoteEditor language={language} /> : null} title={n.title}>
      <PageBody>
        {caller.memberId === null ? <ViewingNotice language={language} /> : null}
        {!any ? (
          <EmptyState icon={<NotebookText size={18} />}>{n.empty}</EmptyState>
        ) : (
          <>
            <p className="max-w-prose text-[12px] text-ink-3 text-pretty">{n.intro}</p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <nav aria-label={n.title} className="-mx-1 flex gap-1 px-1 py-0.5">
                {views.map((view) => (
                  <Link
                    aria-current={view.active ? "page" : undefined}
                    className={cn(
                      "flex h-7 shrink-0 items-center rounded-full px-2.5 text-[13px] transition-colors",
                      view.active ? "bg-surface font-medium text-ink shadow-hairline" : "text-ink-2 hover:bg-hover",
                    )}
                    href={view.href}
                    key={view.key}
                    scroll={false}
                  >
                    {view.label}
                  </Link>
                ))}
              </nav>
              {archived ? null : <SearchBox label={copy.common.search} placeholder={n.searchPlaceholder} />}
            </div>
            {archived ? (
              <Card description={n.archivedHelp} flush title={n.archivedTitle}>
                {archivedNotes.length ? (
                  <NoteList archived editable={editable} language={language} notes={archivedNotes} timeZone={profile.timeZone} />
                ) : (
                  <Nothing>{n.noArchived}</Nothing>
                )}
              </Card>
            ) : query && page.business.length + page.linked.length === 0 ? (
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
