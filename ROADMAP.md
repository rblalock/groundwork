# Roadmap

What comes after the hackathon build, roughly in order.

## Priced photo editor: what v1 leaves out

v1 is on the quote page: every object SAM found is kept with its outline, hover and tap put an
outline on a line, and "find in photo" asks SAM again inside a drawn box for any phrase. Edits save
on `priced_photos` and the photo is redrawn without SAM. Still to do:

- **Point and box prompts.** v1 sends a noun phrase and keeps what lands in the box. If the SAM
  endpoint takes point or box prompts, "find it here" gets more precise with no phrase at all.
- **Draw it by hand.** A rough polygon for the thing SAM never finds, kept as a candidate like the
  rest.
- **Edit from the chat card and the price guide**, not only the quote page, and let a crew member
  fix a finished-job photo from their phone before it's saved to the customer.
- **Split and merge.** Cut one outline in two (the left and right hedge) or join two into one line
  object, so counts per piece match what was quoted.

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

## A social post from the before-and-after

This builds on the before-and-after composite the invoice and the price guide already show, and
makes it a post the business can share as it is: the two photos side by side, lightly cleaned up
(crop to one frame, level the exposure between the two, the business's name in a corner), with an
optional line inviting people to get their own quote. The operator taps share and goes; nothing to
design, nothing to write.

## Repeat quotes proposed from the price guide

The customer's price guide holds every priced photo of their yard. When the member says "same as last
spring for Maria", propose the lines from that priced photo's quote in the numbered confirm, at
today's prices from the calculator.

## Crew checklist from the priced photo

Turn each located line of the priced photo into a checklist item for the visit (mulch the outlined
beds, trim the outlined hedge) and send it with the photo to the crew booked on it. Crew mark items
done by text, and the visit closes when they are.

## Dispatch: routes for crews and jobs

Today the schedule is visits with a crew, a start, an end, and buffers a person guesses. Dispatch
makes the day a route: where each crew goes, in what order, how long the driving takes, and what to
do when the day stops fitting. The rules decide; the model explains and writes the messages; the
owner approves anything that moves a customer. Done in the order below; each step is useful alone.

- **Places.** Geocode every property and the business's yard once, when the address is saved (the
  US Census geocoder needs no key; a paid one can replace it behind the same function). A property
  that can't be placed says so on its card and is left out of route math, never guessed.
- **Drive times.** Straight-line distance times a road factor at a town speed, between any two
  places. No road graph, no routing service: a landscaping crew's day is one county, and the number
  only has to be honest to the quarter hour. Visit buffers stop being a guess: `book_visit` and
  `find_availability` take the drive from the previous stop and to the next one into account.
- **The crew's day.** A plan per crew per day: ordered stops with planned arrival and finish, the
  legs between them, leaving from and returning to the yard. Ordering is nearest-neighbor with a
  two-opt pass, which is enough at a crew's size. The plan is derived from the visits and recomputed
  when they change; it is never the record, the visits are. The morning line becomes the route: each
  stop with its arrival, a maps link, the gate note, and the drive to the next one.
- **Slots that fit the route.** `find_availability` offers the cheapest insertion into each crew's
  day (least added driving), inside working hours and under a day capacity (jobs plus driving fill no
  more than a set share of the day, so there is room for the unexpected), before it offers an empty
  slot on a far day. Equipment matters: a price book item can list what it needs (trailer, mower
  deck size, sprayer license, chipper), a member can list what their truck carries, and a job only
  goes to a crew that carries all of it.
- **Running long.** `start_job` and `close_job` already time the work. When a stop passes its
  planned finish by a set number of minutes, or the crew texts that it will, the rest of the day
  re-plans from now. When the projected return runs past the end of the workday by more than a
  grace, the assistant proposes moving the crew's last unstarted stops: to another crew today when
  one nearby has room, else to the customer's next open day. A stop starting within the lead time
  stays; the crew is already on its way.
- **Proposals.** A move is a proposal, not a change: the stops moved, from where to where, the reason
  in one line, and a drafted text per customer and per receiving crew member. It goes to the owner as
  a numbered confirm, by text or on the web, with items they can drop; applying it is one transaction
  that re-checks every item still holds. Customer texts are drafts the member forwards, as invoices
  are today. Nothing reaches a customer because a rule fired.
- **Route days.** Recurring work (weekly mowing, monthly beds) is placed by area: the assistant
  proposes which weekday each neighborhood gets so a crew's recurring day is one loop, and new
  recurring customers land on the day their neighbors have.
- **Weather.** The forecast from api.weather.gov (no key) for each crew's day: rain probability and
  heat by hour for the yard's grid point. A day with a high chance of rain over a mowing route gets
  a proposal the evening before, with the next dry day per customer. Thresholds are business
  settings the owner can change by text, with sensible defaults, not constants in code.
- **The board.** The schedule page shows each crew's day as a route: the stops in order with drive
  legs between them, the running total against capacity, and what is at risk. A map comes after the
  list works; the list with honest minutes is the product, the map is the picture of it.
- **Crew phone.** Each crew member's day on their phone from a text: "next" for the next stop with
  the address link and notes, "done" to close it and re-plan, "running 30 late" to re-plan with the
  delay, and the owner sees the day shift on the board.

Out of scope: live truck positions, a road graph, radar, parcels, and anything that needs a
telematics or routing service. The record stays the visit; the route is always computed from it.

## Real Stripe Connect onboarding

The demo runs on `STRIPE_FAKE`. The Connect code creates the business's account and Stripe's hosted
onboarding link; next is onboarding a real business through it and taking a live deposit and invoice
payment end to end.

## Email intake in the demo

Members can forward an email to their business's AgentMail inbox, and the sender is verified (DKIM
and DMARC) before the assistant acts on it. Next: add a forwarded customer email to the demo flow,
from intake to quote.
