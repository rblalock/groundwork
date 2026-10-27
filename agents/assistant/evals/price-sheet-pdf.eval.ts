import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { listItems, listRules } from "../../../core/pricebook";
import type config from "./evals.config";

/** An obviously fake rate sheet, as a text PDF. */
async function rateSheetPdf(): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText("Sample Co. Rates", { x: 60, y: 720, size: 24, font: bold });
  const rows: Array<[string, string]> = [
    ["Gizmo cleaning", "$8 each"],
    ["Gadget fitting", "$2 each"],
    ["Setup", "$40 per hour"],
  ];
  rows.forEach(([name, price], i) => {
    page.drawText(name, { x: 60, y: 660 - i * 30, size: 14, font });
    page.drawText(price, { x: 400, y: 660 - i * 30, size: 14, font });
  });
  page.drawText("A $25 trip charge is added to every job.", { x: 60, y: 540, size: 12, font });
  page.drawText("Repeat customers get 10% off.", { x: 60, y: 520, size: 12, font });
  const dir = await mkdtemp(join(tmpdir(), "gw-eval-"));
  const file = join(dir, "rates.pdf");
  await writeFile(file, await doc.save());
  return file;
}

// A PDF rate sheet, with one item already saved at another price: the assistant shows old → new and
// saves the items and both rules only on the owner's ok.
export default defineEval<typeof config>({
  description: "A PDF rate sheet is proposed back, with a changed price shown old to new, and saved on ok.",
  async test(t) {
    const business = await t.context.seed.oneItem();
    const session = await t.session();

    const turn = await session.sendFile("can you put these in", await rateSheetPdf(), "application/pdf");
    t.succeeded();
    turn.notCalledTool("save_pricebook_items");
    turn.notCalledTool("save_rule");
    t.judge(
      "The reply proposes Gizmo cleaning $8 each, Setup $40 per hour, and Gadget fitting going from $3 to $2 each (shown as a change from the saved price), " +
        "plus a $25 trip charge on every job and 10% off for repeat customers, numbered, and asks for an ok before saving. " +
        "It asks no questions about prices it could read. No markdown.",
    ).gate(0.7);

    const next = await turn.session.send("ok");
    next.calledTool("save_pricebook_items");
    next.calledTool("save_rule");

    const items = await listItems(business.orgId);
    t.check(items.length, equals(3)).label("no duplicate of the saved item");
    t.check(items.find((item) => item.id === business.gadgetId)?.priceCents, equals(200)).label("saved item repriced");
    t.check(
      Object.fromEntries(items.map((item) => [item.name.toLowerCase(), item.priceCents])),
      satisfies(
        (p: Record<string, number>) => p["gizmo cleaning"] === 800 && p["setup"] === 4000,
        "the new items at the sheet's prices",
      ),
    ).label("new prices");
    const effects = (await listRules(business.orgId)).map((rule) => rule.effect);
    t.check(
      effects,
      satisfies(
        (list: unknown[]) =>
          list.some((e) => (e as { op?: string; amount?: number } | null)?.op === "add_fixed" && (e as { amount: number }).amount === 2500) &&
          list.some((e) => (e as { op?: string; amount?: number } | null)?.op === "percent" && (e as { amount: number }).amount === -1000),
        "a $25 fixed charge and a 10% discount",
      ),
    ).label("saved rules");
  },
});
