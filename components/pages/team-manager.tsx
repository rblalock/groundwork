"use client";

import { Check, Copy, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/ui/components/dialog";
import type { Language } from "@/core/language";
import type { PhoneStatus, Role } from "@/core/members";
import { formatPhone } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import type { AddMemberResult } from "@/lib/pages/team";
import { Card, Table, Td, Th } from "./kit";
import { ErrorLine, Field, NativeSelect, useMutation } from "./client-kit";

export type TeamRow = {
  id: string;
  name: string;
  role: Role;
  language: Language;
  hasLogin: boolean;
  /** The address they forward emails from. */
  email: string | null;
  /** An address asked for, waiting on the code texted to them. */
  pendingEmail: string | null;
  phones: Array<{ e164: string; status: PhoneStatus }>;
};

const PHONE_TONES = { pending: "orange", verified: "green", stopped: "neutral" } as const;
const RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1 };

/**
 * The team: who's on it and how they reach the assistant. Owners and admins add, edit, and remove people
 * below them (and edit themselves); only the owner changes roles.
 */
export function TeamManager({
  team,
  language,
  me,
  myRole,
  canEdit,
}: {
  team: TeamRow[];
  language: Language;
  /** The signed-in member, who can't remove themselves here. */
  me: string | null;
  /** Their role: they set their own email, and only the emails of people below them. */
  myRole: Role;
  canEdit: boolean;
}) {
  const copy = pageCopyFor(language);
  const t = copy.team;
  const add = useMutation(copy.common.failed);
  const remove = useMutation(copy.common.failed);
  const [formOpen, setFormOpen] = useState(false);
  const [result, setResult] = useState<AddMemberResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState<TeamRow | null>(null);
  const emailEdit = useMutation(copy.common.failed);
  const [editingEmail, setEditingEmail] = useState<TeamRow | null>(null);
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const memberEdit = useMutation(copy.common.failed);
  const [editing, setEditing] = useState<TeamRow | null>(null);
  // Only the owner changes roles, never their own, and the owner's stays.
  const canSetRole = (member: TeamRow) => myRole === "owner" && member.id !== me && member.role !== "owner";

  async function saveMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const data = new FormData(event.currentTarget);
    const body: Record<string, string> = {
      name: String(data.get("edit-name") ?? ""),
      language: String(data.get("edit-language") ?? editing.language),
    };
    if (canSetRole(editing)) body.role = String(data.get("edit-role") ?? editing.role);
    const saved = await memberEdit.send("edit", `/api/team/${editing.id}`, { method: "PATCH", body });
    if (saved) setEditing(null);
  }

  async function saveEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingEmail) return;
    const email = String(new FormData(event.currentTarget).get("member-email") ?? "");
    const saved = await emailEdit.send<{ member: { pending: unknown } }>("email", `/api/team/${editingEmail.id}`, { method: "PATCH", body: { email } });
    if (saved) {
      setCodeSentTo(saved.member.pending ? editingEmail.name : null);
      setEditingEmail(null);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const added = await add.send<AddMemberResult>("add", "/api/team", {
      method: "POST",
      body: {
        name: String(data.get("name") ?? ""),
        phone: String(data.get("phone") ?? ""),
        role: String(data.get("role") ?? "member"),
        language: String(data.get("language") ?? "en"),
      },
    });
    if (added) {
      setResult(added);
      setCopied(false);
      setFormOpen(false);
      form.reset();
    }
  }

  return (
    <div className="space-y-6">
      {canEdit ? (
        <div className="flex justify-end">
          {!formOpen ? (
            <Button onClick={() => { setFormOpen(true); setResult(null); }} size="sm" variant="primary">
              <Plus aria-hidden="true" className="size-3.5" /> {t.add}
            </Button>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <section className="space-y-2 rounded-card bg-green-tint px-4 py-3 text-[13px]" role="status">
          <p className="font-medium text-ink">
            <Check aria-hidden="true" className="mr-1.5 inline size-4 text-green" />
            {result.invite ? t.added(result.member.name) : t.alreadyOn(result.member.name)}
          </p>
          {result.roleKept ? <p className="text-ink-2">{t.roleKept}</p> : null}
          {result.invite ? (
            <div className="flex items-start gap-2 rounded-[8px] bg-surface px-3 py-2 shadow-hairline">
              <p className="min-w-0 flex-1 text-ink select-all">{result.invite}</p>
              <Button
                onClick={async () => {
                  await navigator.clipboard.writeText(result.invite ?? "");
                  setCopied(true);
                }}
                size="xs"
                variant="quiet"
              >
                {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
                {copied ? t.copied : t.copy}
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      {codeSentTo ? (
        <p className="rounded-card bg-green-tint px-4 py-3 text-[13px] text-ink" role="status">
          <Check aria-hidden="true" className="mr-1.5 inline size-4 text-green" />
          {t.codeSent(codeSentTo)}
        </p>
      ) : null}

      {formOpen ? (
        <Card description={t.formIntro} title={t.formTitle}>
          <form className="grid gap-4" onSubmit={submit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field autoComplete="off" id="name" label={t.name} required />
              <Field autoComplete="off" id="phone" inputMode="tel" label={t.cell} placeholder="(555) 555-0142" required type="tel" />
              <Field hint={t.roleHelp} id="role" label={t.role}>
                <NativeSelect defaultValue="member" id="role" name="role">
                  <option value="member">{t.roles.member}</option>
                  {RANK[myRole] > RANK.admin ? <option value="admin">{t.roles.admin}</option> : null}
                </NativeSelect>
              </Field>
              <Field id="language" label={t.language}>
                <NativeSelect defaultValue={language} id="language" name="language">
                  <option value="en">{copy.common.languages.en}</option>
                  <option value="es">{copy.common.languages.es}</option>
                </NativeSelect>
              </Field>
            </div>
            <ErrorLine>{add.error}</ErrorLine>
            <div className="flex justify-end gap-2">
              <Button onClick={() => { setFormOpen(false); add.setError(undefined); }} size="sm" type="button" variant="quiet">
                {copy.common.cancel}
              </Button>
              <Button disabled={add.busy !== null} size="sm" type="submit" variant="primary">
                {add.busy ? t.adding : t.submit}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card flush>
        <Table
          head={
            <>
              <Th>{t.columns.name}</Th>
              <Th className="hidden @xl:table-cell">{t.columns.role}</Th>
              <Th>{t.columns.phones}</Th>
              <Th className="hidden @3xl:table-cell">{t.columns.email}</Th>
              <Th className="hidden @2xl:table-cell">{t.columns.language}</Th>
              <Th className="hidden @xl:table-cell">{t.columns.login}</Th>
              {canEdit ? <Th><span className="sr-only">{t.remove}</span></Th> : null}
            </>
          }
        >
          {team.map((member) => (
            <tr key={member.id}>
              <Td>
                <span className="font-medium">{member.name}</span>
                {member.id === me ? <span className="ml-1.5 text-[12px] text-ink-3">({t.you})</span> : null}
                <span className="block text-[12px] text-ink-3 sm:hidden">{t.roles[member.role]}</span>
              </Td>
              <Td className="hidden whitespace-nowrap @xl:table-cell">{t.roles[member.role]}</Td>
              <Td>
                <ul className="space-y-1">
                  {member.phones.map((phone) => (
                    <li className="flex flex-wrap items-center gap-x-2 gap-y-1" key={phone.e164}>
                      <span className="tabular-nums whitespace-nowrap">{formatPhone(phone.e164)}</span>
                      <StatusPill className="h-5 px-2 text-[12px] whitespace-nowrap" tone={PHONE_TONES[phone.status]}>
                        {t.phoneStatus[phone.status]}
                      </StatusPill>
                    </li>
                  ))}
                </ul>
              </Td>
              <Td className="hidden max-w-[220px] @3xl:table-cell">
                <span className={`block truncate ${member.email ? "text-ink-2" : "text-ink-3"}`} title={member.email ?? undefined}>
                  {member.email ?? (member.pendingEmail ? null : t.noEmail)}
                </span>
                {member.pendingEmail ? (
                  <span className="block truncate text-[12px] text-ink-3" title={member.pendingEmail}>
                    {t.pendingEmail(member.pendingEmail)}
                  </span>
                ) : null}
              </Td>
              <Td className="hidden text-ink-2 @2xl:table-cell">{copy.common.languages[member.language]}</Td>
              <Td className="hidden whitespace-nowrap text-ink-2 @xl:table-cell">{member.hasLogin ? t.login.yes : t.login.no}</Td>
              {canEdit ? (
                <Td className="text-right whitespace-nowrap">
                  {member.id === me || RANK[myRole] > RANK[member.role] ? (
                    <>
                      <Button onClick={() => { setEditing(member); memberEdit.setError(undefined); }} size="xs" variant="quiet">
                        {t.edit}
                      </Button>
                      <Button onClick={() => { setEditingEmail(member); emailEdit.setError(undefined); }} size="xs" variant="quiet">
                        {t.setEmail}
                      </Button>
                    </>
                  ) : null}
                  {member.id !== me && RANK[myRole] > RANK[member.role] ? (
                    <Button onClick={() => { setRemoving(member); remove.setError(undefined); }} size="xs" variant="quiet">
                      {t.remove}
                    </Button>
                  ) : null}
                </Td>
              ) : null}
            </tr>
          ))}
        </Table>
      </Card>

      <Dialog onOpenChange={(open) => { if (!open) setEditing(null); }} open={editing !== null}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{editing ? t.editTitle(editing.name) : ""}</DialogTitle>
          <DialogDescription>{t.editHelp}</DialogDescription>
          {editing ? (
            <form className="grid gap-4" onSubmit={saveMember}>
              <Field autoComplete="off" defaultValue={editing.name} id="edit-name" label={t.name} maxLength={100} required />
              <Field id="edit-language" label={t.language}>
                <NativeSelect defaultValue={editing.language} id="edit-language" name="edit-language">
                  <option value="en">{copy.common.languages.en}</option>
                  <option value="es">{copy.common.languages.es}</option>
                </NativeSelect>
              </Field>
              {canSetRole(editing) ? (
                <Field hint={t.roleHelp} id="edit-role" label={t.role}>
                  <NativeSelect defaultValue={editing.role} id="edit-role" name="edit-role">
                    <option value="member">{t.roles.member}</option>
                    <option value="admin">{t.roles.admin}</option>
                  </NativeSelect>
                </Field>
              ) : myRole === "admin" && editing.id !== me ? (
                <p className="text-[12px] text-ink-3">{t.roleOwnerOnly}</p>
              ) : null}
              <ErrorLine>{memberEdit.error}</ErrorLine>
              <DialogFooter>
                <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
                <Button disabled={memberEdit.busy !== null} size="sm" type="submit" variant="primary">
                  {memberEdit.busy ? t.saving : t.save}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={(open) => { if (!open) setEditingEmail(null); }} open={editingEmail !== null}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{editingEmail ? t.emailTitle(editingEmail.name) : ""}</DialogTitle>
          <DialogDescription>{t.emailHelp}</DialogDescription>
          <form className="grid gap-4" onSubmit={saveEmail}>
            <Field
              autoComplete="off"
              defaultValue={editingEmail?.pendingEmail ?? editingEmail?.email ?? ""}
              id="member-email"
              inputMode="email"
              label={t.columns.email}
              placeholder="name@example.com"
              type="email"
            />
            <ErrorLine>{emailEdit.error}</ErrorLine>
            <DialogFooter>
              <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
              <Button disabled={emailEdit.busy !== null} size="sm" type="submit" variant="primary">
                {t.saveEmail}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={(open) => { if (!open) setRemoving(null); }} open={removing !== null}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{removing ? t.confirmRemoveTitle(removing.name) : ""}</DialogTitle>
          <DialogDescription>{t.confirmRemoveBody}</DialogDescription>
          <ErrorLine>{remove.error}</ErrorLine>
          <DialogFooter>
            <DialogClose render={<Button size="sm" variant="quiet" />}>{copy.common.cancel}</DialogClose>
            <Button
              className="bg-red text-white hover:opacity-90"
              disabled={remove.busy !== null}
              onClick={async () => {
                if (!removing) return;
                const done = await remove.send("remove", `/api/team/${removing.id}`, { method: "DELETE" });
                if (done) setRemoving(null);
              }}
              size="sm"
            >
              {t.remove}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
