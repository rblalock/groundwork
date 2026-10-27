import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { logoVersionFor } from "@/core/branding";
import { AppShell } from "@/components/app-shell";
import { businessesFor } from "@/lib/guards";
import { pageCallerOrNull, pageViewer } from "@/lib/page-session";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const viewer = await pageViewer();
  const caller = await pageCallerOrNull();
  if (!caller && !viewer.superAdmin) redirect("/no-business");
  if (caller?.suspended && !viewer.superAdmin) redirect("/paused");
  const businesses = await businessesFor(viewer);
  const open = caller ? businesses.find((b) => b.id === caller.orgId) : undefined;
  const logoVersion = open ? await logoVersionFor(open.id) : null;
  return (
    <AppShell
      business={caller && open ? { id: open.id, name: open.name, role: caller.role, logoVersion, member: caller.memberId !== null } : null}
      businesses={businesses.map(({ id, name }) => ({ id, name }))}
      language={caller?.language ?? "en"}
      user={{ name: viewer.name, email: viewer.email, superAdmin: viewer.superAdmin }}
    >
      {children}
    </AppShell>
  );
}
