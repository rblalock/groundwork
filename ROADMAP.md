# Roadmap

What comes after the hackathon build, roughly in order.

## Edit the priced photo by hand

The priced photo is drawn once by code from what SAM found, and the only fix today is "Price it
again". The next version is an editor on the quote page and in the customer's price guide, for the
member on a phone or a laptop:

- **Hover and tap.** Every object SAM found is drawn as an outline on the photo (an SVG layer over
  the image, not baked into a PNG). Hovering or tapping one lights it up and shows which line it
  carries, or that it carries none.
- **Assign from the quote.** Tapping an outline opens a picker of the quote's lines. Pick one to
  assign it, pick another to move it, or clear it. Lines marked "not located" sit at the top of
  the picker so the obvious fix is one tap.
- **Find it here.** For a line SAM missed, tap or drag a box on the photo and the editor asks SAM
  for that spot (point and box prompts, if the API takes them; otherwise the line's photo prompt
  run again, keeping only objects inside the box). Drawing a rough polygon by hand is the fallback.
- **Saved, then redrawn.** Edits save the regions on `priced_photos` (with who changed them and
  when), and the PNG for the customer link, the PDF, and the price guide is redrawn from the saved
  regions without calling SAM again.
- **What has to change underneath.** Keep every object SAM returned, not only the ones the selector
  kept, and keep each object's mask outline (today only its box is stored), so the editor has
  something to show and the redraw keeps SAM's shapes. The same stored outlines feed the crew
  checklist and the before-and-after pairing below.

## Post-train an open-weight model on exported traces

- **The dataset.** `npm run traces:export -- --org <slug> --redact` already writes one turn per JSONL
  line: channel, model id, status, token counts, and the steps (tool calls with arguments, tool
  results, reasoning, the reply). To make each line a training example, the export would add the
  member's message and attachments from the conversation, and the instructions and tool schemas the
  turn ran with.
- **The filter.** Keep completed turns with no tool errors, and label them from the records they
  touched: a quote the owner approved without a revision, a visit booked without a conflict, a
  question the member answered. Drop turns whose quote was voided or corrected.
- **What we would tune.** An open-weight Llama model, supervised on these trajectories: which tool to
  call, its arguments (saved item ids, quantities in the trade's units, rule ids), the one numbered
  confirm or question, and never stating a price the calculator didn't return. Pricing stays in code
  either way.
- **How it is measured.** The tuned model runs as one more scorecard condition beside the baseline,
  the pack on Muse Wonder, and the pack on Muse Spark: the same seeded business, the same evals, and
  Muse Wonder as the judge, compared on pass rate, judge mean, completion, and cost per quote.

## More trades as packs

Each trade is a pack under `verticals/<id>/` (price book items with photo prompts, rules, notes, a
minimum charge, and an instruction overlay) with its own eval set tagged by trade and its own
scorecard run. Candidates: irrigation, pool service, pest control, tree work.

## Before-and-after photos from the same masks

The priced photo already runs SAM on the quote's photo, and `price_photo` with a job prices the
finished-job photo. Next: pair the two for the same lines and show them side by side on the invoice
and the customer's price guide.

## Repeat quotes proposed from the price guide

The customer's price guide holds every priced photo of their yard. When the member says "same as last
spring for Maria", propose the lines from that priced photo's quote in the numbered confirm, at
today's prices from the calculator.

## Crew checklist from the priced photo

Turn each located line of the priced photo into a checklist item for the visit (mulch the outlined
beds, trim the outlined hedge) and send it with the photo to the crew booked on it. Crew mark items
done by text, and the visit closes when they are.

## Real Stripe Connect onboarding

The demo runs on `STRIPE_FAKE`. The Connect code creates the business's account and Stripe's hosted
onboarding link; next is onboarding a real business through it and taking a live deposit and invoice
payment end to end.

## Email intake in the demo

Members can forward an email to their business's AgentMail inbox, and the sender is verified (DKIM
and DMARC) before the assistant acts on it. Next: add a forwarded customer email to the demo flow,
from intake to quote.
