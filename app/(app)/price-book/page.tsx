import { ItemDialog, PricebookItems, PricebookRules, RuleDialog } from "@/components/pages/pricebook-tables";
import { Card, PageBody, ViewingNotice } from "@/components/pages/kit";
import { PaperPage } from "@/components/paper";
import { pageCopyFor } from "@/lib/page-copy";
import { pagePrivileged } from "@/lib/page-session";
import { pricebookFor } from "@/lib/pages/pricebook";
import { AskAssistantButton } from "@/components/threads/thread-rail";
import { copyFor } from "@/lib/copy";

// Owners and admins only: crew get a 404 here, and the nav doesn't show it to them.
export default async function PricebookPage() {
  const caller = await pagePrivileged();
  const { items, rules } = await pricebookFor(caller);
  const { language } = caller;
  const p = pageCopyFor(language).pricebook;
  const canEdit = caller.memberId !== null;
  const suggested = rules.filter((r) => r.status === "suggested").length;

  return (
    <PaperPage actions={<AskAssistantButton label={copyFor(language).rail.ask} start={{ topic: "pricebook" }} />} title={p.title}>
      <PageBody>
        {caller.memberId === null ? <ViewingNotice language={language} /> : null}
        <Card actions={canEdit ? <ItemDialog language={language} /> : null} flush title={p.items}>
          <PricebookItems
            canEdit={canEdit}
            items={items.map(({ id, name, unitKind, unitLabel, priceCents, taxable, status, group, equipment }) => ({ id, name, unitKind, unitLabel, priceCents, taxable, status, group, equipment }))}
            language={language}
          />
        </Card>
        <Card
          actions={canEdit ? <RuleDialog items={items.filter((i) => i.status === "active").map(({ id, name }) => ({ id, name }))} language={language} /> : null}
          description={suggested > 0 ? p.suggestedNote(suggested) : undefined}
          flush
          title={p.rules}
        >
          <PricebookRules
            canEdit={canEdit}
            language={language}
            rules={rules.map(({ id, text, kind, effect, status, by }) => ({ id, text, kind, effect, status, by }))}
          />
        </Card>
      </PageBody>
    </PaperPage>
  );
}
