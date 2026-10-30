# Roadmap

What comes after the hackathon build, roughly in order.

## Priced photo editor: what v1 leaves out

v1 is on the quote page, opened from the chat's quote card and the price guide too: every object SAM
found is kept with its outline, hover and tap put an outline on a line, "find in photo" asks SAM
again inside a drawn box for any phrase, or with no phrase for the one thing in the box (a tap off a
wrong answer asks again), and "draw" outlines by hand what SAM never finds. Edits save on
`priced_photos` and the photo is redrawn without SAM. Still to do:

- **Split and merge.** Cut one outline in two (the left and right hedge) or join two into one line
  object, so counts per piece match what was quoted.

## Social post: what v1 leaves out

v1 crops the before-and-after to a square or a story, evens out each photo, and adds the business's
name, logo, and a line asking for the next job, with a caption written in code. It's shared from the
quote page or sent to the thread by `make_post`. Still to do:

- **Captions in the business's voice.** The model writes the caption from the quote and the
  business's past posts, still with no price or address in it.
- **Exposure matched across the halves.** Each photo is leveled on its own; matching the after to
  the before would make the change read as the work, not the light.
- **Scheduling and posting.** Post to the business's accounts through the networks' APIs, now or at
  a set time, instead of the member sharing it by hand.
- **A template per business.** Its colors and fonts on the band and the labels.

## Post-train an open-weight model on exported traces

The recipe is [docs/post-training.md](docs/post-training.md).

- **The dataset.** Shipped: `npm run traces:dataset` and `npm run evals:capture` write each turn as a
  redacted training example (instructions, tools, the member's message, calls, results, the reply).
- **The filter.** Shipped: clean completed turns are kept and labelled from their quotes and visits;
  voided or corrected quotes are dropped.
- **How it is measured.** Shipped: `npm run scorecard -- --model <id> --base-url <url>` adds the tuned
  model as a condition, judged by Muse Wonder.
- **What we would tune.** An open-weight Llama model, supervised on these trajectories: which tool to
  call, its arguments (saved item ids, quantities in the trade's units, rule ids), the one numbered
  confirm or question, and never stating a price the calculator didn't return. Pricing stays in code
  either way. Next: a few hundred real turns and an 8B LoRA run, about $20 at Together or Fireworks
  list prices (500 examples of about 28,000 tokens, three epochs).

## Trades: what v1 leaves out

v1 ships four packs under `verticals/`: landscaping, irrigation, pool service, and tree work, each
with items, rules, the three notes, a minimum, an instruction overlay, and evals tagged with its id.
`npm run scorecard -- --vertical <id>` scores any of them. Still to do:

- **Pest control.** A pack priced per treatment, per square foot, and per visit, with rules for the
  applicator's license number and the re-entry time after a spray.
- **SAM prompts tuned per trade on real photos.** The irrigation, pool, and tree photo prompts are
  first guesses; each needs a probe on the trade's own photos, as landscaping's had.
- **A scorecard run per pack.** Run the irrigation, pool, and tree scorecards and record their
  numbers in HACKATHON beside landscaping's.

## Repeat quotes: what v1 leaves out

v1 is `repeat_quote`: a past quote's lines and rules at today's prices in a numbered confirm, made
into a new quote by `create_quote` when the member says yes. "Quote it again" on the price guide and
the quote page opens the chat with the request typed in. Still to do:

- **A button that quotes without the chat.** Make the repeat from the quote page in one tap, with
  the same confirm on the page.
- **Recurring work every season.** Repeat the spring cleanup each spring on its own, which belongs
  with dispatch's route days rather than one quote at a time.

## Crew checklist: what v1 leaves out

v1 makes one item per quote line when the work's first visit is booked, marks the ones the priced
photo outlines, and sends the list with a quantities-only copy of the photo to the crew booked. Crew
tick items by text and anyone ticks them on the work's page; the last tick marks today's visit done.
Still to do:

- **Crew verbs per price book item.** "Spread 3 yards of mulch", "trim the front hedge": a verb saved
  on the item, so the list reads as the work rather than the quote.
- **A photo per item.** Crop the priced photo to each item's outline, so a crew member sees exactly
  which bed or hedge it means.
- **A checklist template per job type.** The steps a spring cleanup always has, beyond what was
  quoted.
- **Items from site notes.** "Lock the gate", "dog in the back yard": the property's notes as items
  to tick before leaving.

## Dispatch: routes for crews and jobs

Today the schedule is visits with a crew, a start, an end, and buffers a person guesses. Dispatch
makes the day a route: where each crew goes, in what order, how long the driving takes, and what to
do when the day stops fitting. The rules decide; the model explains and writes the messages; the
owner approves anything that moves a customer. Done in the order below; each step is useful alone.

- **Places.** Geocode every property and the business's yard once, when the address is saved (the
  US Census geocoder needs no key; a paid one can replace it behind the same function). A property
  that can't be placed says so on its card and is left out of route math, never guessed.
  Shipped: properties and the yard are placed when saved (or by `npm run places:backfill`); a property
  card says when its address couldn't be placed; `PLACES_FAKE` stands in locally and in tests.
- **Drive times.** Straight-line distance times a road factor at a town speed, between any two
  places. No road graph, no routing service: a landscaping crew's day is one county, and the number
  only has to be honest to the quarter hour. Visit buffers stop being a guess: `book_visit` and
  `find_availability` take the drive from the previous stop and to the next one into account.
  Shipped: a visit's buffers are the drive in from the crew's stop before or the yard and out to the
  next or back (factor 1.3 at 28 mph, 5 minutes at least, owner-set by text or in Settings), falling
  back to the default with `driveEstimated: false` when a place is missing; tool results, the
  schedule's visit panel, and the crew's booking text show the minutes.
- **The crew's day.** A plan per crew per day: ordered stops with planned arrival and finish, the
  legs between them, leaving from and returning to the yard. Ordering is nearest-neighbor with a
  two-opt pass, which is enough at a crew's size. The plan is derived from the visits and recomputed
  when they change; it is never the record, the visits are. The morning line becomes the route: each
  stop with its arrival, a maps link, the gate note, and the drive to the next one.
  Shipped: a plan per crew member per day (leave the yard, each stop's drive in, planned arrival and
  finish, back at the yard, driving and on-site minutes, load against a day capacity the owner sets) in
  booked order, with a shorter order suggested when it saves 10 minutes or more; the crew's morning
  text is the route, and `read_schedule` returns it; "next" by text gives the stop's maps link, notes, and checklist.
- **Slots that fit the route.** `find_availability` offers the cheapest insertion into each crew's
  day (least added driving), inside working hours and under a day capacity (jobs plus driving fill no
  more than a set share of the day, so there is room for the unexpected), before it offers an empty
  slot on a far day. Equipment matters: a price book item can list what it needs (trailer, mower
  deck size, sprayer license, chipper), a member can list what their truck carries, and a job only
  goes to a crew that carries all of it.
  Shipped: `find_availability` ranks every free slot (for the crew named, or each member on their
  own) by the driving it adds to the crew's day, and puts slots that would take a day over its capacity
  last, marked; its lines say who and the minutes. Price book items and members list equipment (by text,
  on the price book page, and on the Team page); members who lack it aren't offered, a named crew who
  lack it hear what, and `book_visit` refuses them unless the owner says to book anyway.
- **Running long.** `start_visit` and `change_visit_status` time the work. When a stop passes its
  planned finish by a set number of minutes, or the crew texts that it will, the rest of the day
  re-plans from now. When the projected return runs past the end of the workday by more than a
  grace, the assistant proposes moving the crew's last unstarted stops: to another crew today when
  one nearby has room, else to the customer's next open day. A stop starting within the lead time
  stays; the crew is already on its way.
  Shipped so far: crew start a stop by text (`start_visit`) and declare a delay (`declare_delay`), and
  today's route re-plans from now: a stop under way finishes no sooner than now, a done stop leaves when
  it was marked done, and the stops after shift with their drives. A stop under way 30 minutes past its
  finish (the owner's setting), or a delay, is running long; with the return past the workday's end plus
  a 15-minute grace, the day is at risk on the Route view. A ten-minute check finds those days and
  raises a proposal for each (below): the last stops not yet started, keeping any within the 45-minute
  lead time, to someone else that day who carries what they need, else to the same crew's next day
  with room.
- **Proposals.** A move is a proposal, not a change: the stops moved, from where to where, the reason
  in one line, and a drafted text per customer and per receiving crew member. It goes to the owner as
  a numbered confirm, by text or on the web, with items they can drop; applying it is one transaction
  that re-checks every item still holds. Customer texts are drafts the member forwards, as invoices
  are today. Nothing reaches a customer because a rule fired.
  Shipped: a proposal per crew member and day, with the reason in one line and each stop's move, a
  customer draft in the customer's language, and the line the receiving crew will get. The owners and
  admins get it as a numbered text (quiet hours hold it) and as a card on the Schedule page with a box
  per stop; "all", the numbers, or "no" by text, or Apply and Drop on the web, decide it. Applying is one
  transaction that re-checks each stop (unchanged since, the time still free, the crew carry what it
  needs), moves the ones that hold, says why the rest didn't, and texts the crew; the customer drafts
  come back to forward. Open proposals expire when their day ends.
- **Route days.** Recurring work (weekly mowing, monthly beds) is placed by area: the assistant
  proposes which weekday each neighborhood gets so a crew's recurring day is one loop, and new
  recurring customers land on the day their neighbors have.
  Shipped: work can repeat every week, two weeks, or month (the same weekday of the month), set when
  it's booked or opened and stopped by text; each visit marked done books the next with the same crew
  and time, on the first later day with room when the crew are off, silently, and the hourly tick
  books any that went missing. On demand (by text or on the Schedule page), the recurring jobs are
  sorted by bearing from the yard and cut into contiguous arcs, one per weekday worked, balanced by
  count; each job whose day changes becomes an item of one proposal to its new weekday next week,
  applied like the others, which moves the work's weekday too. `find_availability` gives recurring
  work the weekday whose loop it adds the least driving to, first in its lines.
- **Weather.** The forecast from api.weather.gov (no key) for each crew's day: rain probability and
  heat by hour for the yard's grid point. A day with a high chance of rain over a mowing route gets
  a proposal the evening before, with the next dry day per customer. Thresholds are business
  settings the owner can change by text, with sensible defaults, not constants in code.
  Shipped: the hourly forecast for the yard's grid point (cached, fail-soft, `WEATHER_FAKE` locally).
  Price book items can be weather-sensitive (by text or on the price book page). Each evening, 15
  hours before the workday by default, tomorrow's stops with that work are read against the
  rain and heat limits (60% and 95°F, settings by text and in Settings); the ones at risk become one
  proposal for the business, each to its own crew's next later slot that fits and is dry in the
  forecast (past its reach counts as dry), texted to the owners (queued past quiet hours) and on the
  Schedule page, applied like the others. `read_schedule` and the Route view show each day's line.
- **The board.** The schedule page shows each crew's day as a route: the stops in order with drive
  legs between them, the running total against capacity, and what is at risk. A map comes after the
  list works; the list with honest minutes is the product, the map is the picture of it.
  Shipped: the schedule's Route view lists each crew member's day (the default for crew with visits
  that day): the stops in order with the drive into each, the leg back, and the day's minutes and load,
  over capacity in the warning color, with a shorter order when there is one. Shipped: the map, above
  those lists: the yard, each placed stop numbered in its crew member's color, straight lines from the
  yard and back (not roads), the shorter order dashed, late stops ringed; a marker opens the visit.
- **Crew phone.** Each crew member's day on their phone from a text: "next" for the next stop with
  the address link and notes, "done" to close it and re-plan, "running 30 late" to re-plan with the
  delay, and the owner sees the day shift on the board.
  Shipped: `next_stop` sends the next stop with its time, a maps link, the drive from where they are,
  the visit's and site's notes, and the checklist; "here" starts it, "done" replies with what's next,
  and "running 30 late" says what shifts and whether the day is at risk. The Route view shows when a
  crew got on site, the projected arrival of the stops they'd reach late, and the re-planned return.

Out of scope: live truck positions, a road graph, radar, parcels, and anything that needs a
telematics or routing service. The record stays the visit; the route is always computed from it.

## Real Stripe Connect onboarding

The demo runs on `STRIPE_FAKE`. The Connect code creates the business's account and Stripe's hosted
onboarding link; next is onboarding a real business through it and taking a live deposit and invoice
payment end to end.

## Email intake in the demo

Members can forward an email to their business's AgentMail inbox, and the sender is verified (DKIM
and DMARC) before the assistant acts on it. The flow is described in HACKATHON.md's demo (step 11)
and runs locally on `AGENTMAIL_FAKE`. Still to do: an AgentMail inbox on the production business, so
the recorded demo can show a real forwarded email from intake to quote.
