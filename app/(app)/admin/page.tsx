import { AdminBusinesses } from "@/components/admin-businesses";
import { PaperPage } from "@/components/paper";
import { listBusinessesForAdmin } from "@/lib/admin";
import { pageCallerOrNull, pageSuperAdmin } from "@/lib/page-session";

export default async function AdminPage() {
  await pageSuperAdmin();
  const [businesses, caller] = await Promise.all([listBusinessesForAdmin(), pageCallerOrNull()]);
  return (
    <PaperPage title="Businesses">
      <AdminBusinesses activeBusinessId={caller?.orgId ?? null} businesses={businesses} />
    </PaperPage>
  );
}
