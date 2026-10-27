import { FileText } from "lucide-react";
import Link from "next/link";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import type { Language } from "@/core/language";
import type { NoteView } from "@/core/notes";
import { formatDate } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import { ArchiveNoteButton, NoteEditor, type NoteCustomer } from "./note-editors";

/**
 * Notes as a list of hairline rows: title, where it's from, the text as written, tags, files, and who
 * last changed it. `editable` decides each row's edit and archive buttons; `customer` lets an edit move
 * a note between that customer's places.
 */
export function NoteList({
  notes,
  language,
  timeZone,
  editable,
  customer,
  showPlace = true,
}: {
  notes: NoteView[];
  language: Language;
  timeZone: string;
  editable: (note: NoteView) => boolean;
  customer?: NoteCustomer;
  showPlace?: boolean;
}) {
  const n = pageCopyFor(language).notes;
  return (
    <ul className="divide-y divide-line">
      {notes.map((note) => {
        const place = [note.propertyAddress, note.quoteTitle && note.quoteTitle !== note.propertyAddress ? note.quoteTitle : null].filter(Boolean).join(" · ");
        return (
          <li className="grid gap-1.5 px-4 py-3" key={note.id}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink">
                  {note.title}
                  {note.kind === "document" ? <StatusPill tone="accent">{n.document}</StatusPill> : null}
                </h3>
                {showPlace && (note.customerName || place) ? (
                  <p className="text-[12px] text-ink-3">
                    {note.customerId && note.customerName ? (
                      <Link className="hover:text-ink hover:underline" href={`/customers/${note.customerId}`}>
                        {note.customerName}
                      </Link>
                    ) : null}
                    {note.customerName && place ? " · " : null}
                    {place}
                  </p>
                ) : !showPlace && place ? (
                  <p className="text-[12px] text-ink-3">{place}</p>
                ) : null}
              </div>
              {editable(note) ? (
                <div className="-mt-0.5 flex shrink-0 gap-1">
                  <NoteEditor
                    customer={customer}
                    language={language}
                    note={{ id: note.id, title: note.title, body: note.body, tags: note.tags, revision: note.revision, propertyId: note.propertyId }}
                  />
                  <ArchiveNoteButton language={language} note={{ id: note.id, title: note.title, revision: note.revision }} />
                </div>
              ) : null}
            </div>
            {note.body ? <p className="text-[13px] whitespace-pre-line text-ink-2 text-pretty">{note.body}</p> : null}
            {note.files.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {note.files.map((file) => (
                  <li key={file.url}>
                    <a
                      className="inline-flex items-center gap-1 rounded-full bg-inset px-2 py-0.5 text-[12px] text-ink-2 hover:text-ink"
                      href={file.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <FileText aria-hidden="true" className="size-3" /> {file.name ?? n.files}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
              {note.tags.map((tag) => (
                <span className="rounded-full bg-inset px-2 py-0.5 text-ink-2" key={tag}>
                  {tag}
                </span>
              ))}
              <span>{n.by(note.updatedByName, formatDate(note.updatedAt, language, timeZone))}</span>
            </p>
          </li>
        );
      })}
    </ul>
  );
}
