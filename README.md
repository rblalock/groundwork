# Groundwork

Groundwork is a field-service agent for landscaping crews. A crew member texts a messy job
description and a few yard photos over iMessage or the web chat, and Groundwork turns it into a
priced quote PDF, a priced photo with each quoted thing outlined and labeled, a link where the
customer approves and pays a deposit, a booked visit, and an invoice. The agent runs on Muse Wonder
through Meta's Model API, and SAM 3.1 outlines the quoted lines on the yard photo. Every object SAM
finds is kept with its outline, so a member can edit the photo on the quote page without another SAM
call. The model judges what the member means; code checks who they are and does the math.

When a quote has a priced photo from before the job and one of the finished work, the two make a
before-and-after: side by side, with the quote's title and total under them (the PDF leaves the
total off when the business hides line prices). The photos are plain; on the quote page, "Show
outlines" draws each one's kept masks on it. It's drawn on demand from the two photos, with no SAM
call and nothing stored, and shows on the invoice and its PDF, the quote page, and the customer's
price guide.

The same pair makes a post the business can share: the two photos cropped to match, side by side on
a square or stacked on a story, with the business's name and logo and an optional line asking for
the next job by text or email. No outlines, prices, or address. On the quote page, Share shows it
with a caption to edit: download it, copy the caption, or send both through the phone's share
sheet. In chat, "make a post" sends the image and its caption to the member's thread.

A job done before is quoted again from its last quote. "Same as last time for Maria" proposes that
quote's lines in a numbered confirm at today's prices, with what changed since: a price that went
up, an item no longer in the price book (it stays unpriced for the owner), a total set by hand last
time (not repeated). Nothing is saved until the member says yes. "Quote it again" on the customer's
price guide and on a quote's page opens the chat with the request typed in.

Work from a quote gets a checklist, one item per line: its name, quantity, and unit, marked when the
priced photo outlines it, never with a price. The crew booked get it in their booking text with the
priced photo, drawn for them with quantities only. They tick items by text ("mulch is done"), or
anyone on the team ticks them on the work's page, and the schedule shows how many are done. The tick
that finishes the list marks the work's visit done when its day has come.

Every property and the business's yard (its address) are placed on the map when saved, through the
US Census geocoder. An address that can't be placed says so on its card and is never guessed. A
drive is the straight-line distance times a road factor at a town speed (1.3 and 28 mph unless the
owner changes them, by text or in Settings), rounded up to 5 minutes. Booking holds the drive in from
the crew's stop before, or the yard, and out to the next stop, or back; when a place is missing it
holds today's default and says so. The schedule shows each visit's drive, and the crew's booking text
says how far it is. `npm run places:backfill` places addresses saved before this.

Each crew member's day is a route, worked out from their visits every time and never saved: when they
leave the yard, each stop in booked order with the drive in, and when they're back, with the minutes
driving and on site against a day capacity the owner sets (95% unless changed). When another order
would drive 10 minutes less, the route says so; nothing is moved. Crew get their route as the morning
text, the schedule's Route view lists everyone's for owners and a crew member's own for crew, and the
assistant reads the same numbers from `read_schedule`.

Asked when a job fits, the assistant offers the slots that add the least driving to a crew's day
("Wed, Oct 21, 10:15 AM with Carlos (+5 min driving)"), ahead of an empty day across town, and marks a
slot that would take the day over its capacity. A price book item can list what the work needs
("trailer", "chipper") and a member what their truck carries, by text or on the price book and Team
pages; a job is only offered to crew who carry all of it, and booking someone who doesn't needs the
owner's say.

Crew run their day by text: "next" sends the next stop with a maps link, the drive, the visit's and
the site's notes, and the checklist; "here" starts it, "done" closes it and says what's next, and
"running 30 late" re-plans the rest of the day and says what shifts. Today's route re-plans from now
as the crew go. A stop 30 minutes past its finish, or a declared delay, is running long, and when the
return runs past the workday's end plus a 15-minute grace (both settings) the Route view marks the
day at risk. Nothing moves and no customer is texted.

A day at risk becomes a proposal: the code takes the crew's last stops not yet started off the end
until the return fits, keeping any stop within the 45-minute lead time, and places each with someone
else that day who carries what it needs, else with the same crew on their next day with room. The
owners get it as a numbered text ("Move 2 stops for Carlos? 1. 4 Elm Rd → Pat today 2 PM 2. 40 Pine
Ave → Carlos tomorrow 8:15 AM. Reply the numbers to keep, 'all', or 'no'.") and as a card on the
Schedule page. Applying it re-checks every stop in one transaction, moves the ones that still hold,
and texts the crew; the customer texts come back as drafts for the owner to forward.

The weather comes from api.weather.gov for the yard, by the hour. A price book item rain or heat calls
off is weather-sensitive (the landscaping pack marks mowing, sod, mulch, edging, and cleanup). The
evening before (15 hours before the workday starts, 5 PM for an 8 AM start), tomorrow's stops doing
that work are read against the owner's limits, 60% rain and 95°F unless changed by text or in
Settings, and those at risk become one proposal for the business: each to its own crew's next dry day
with room ("Rain likely tomorrow 10 AM–2 PM (70%) over 3 lawn mowing stops. Move 3 stops to a dry
day?"), decided like any other. `read_schedule` and the Route view show the day's forecast in one line.

Recurring work ("mow it every week") repeats from its first visit: each visit marked done books the
next, same crew and time, a day later when the crew are off, with no text to anyone. "Plan our mowing
days" (or Plan route days on the Schedule page) groups the recurring work by area from the yard, one
loop for each weekday the business works, and proposes moving each job whose day changes to its new
weekday next week, decided like any other proposal; a new recurring customer is offered the weekday
their neighbors are on ("Tue, Nov 10, 10 AM with Carlos (+5 min driving; your Tue loop)").

Above the Route view's lists, a map of the day (Leaflet over OpenStreetMap tiles, no key): the yard,
each placed stop numbered in its crew member's color, a straight line per crew member from the yard and
back, the shorter order dashed when there is one, and a late or at-risk stop ringed in the warning
color. A marker opens the visit like its row; crew see only their own day, and "Hide map" keeps it out
of the way for crew who only want the list.

See [HACKATHON.md](HACKATHON.md) for the demo and how each Meta model is used, and
[ROADMAP.md](ROADMAP.md) for what comes next.

## Stack

- Next.js 16 (App Router) and React 19, TypeScript, Node 24
- Vercel Eve agent runtime and the AI SDK
- Meta Model API: Muse Wonder (agent and eval judge), Muse Spark (fallback), SAM 3.1 (priced photo),
  Muse Image (eval fixtures)
- Drizzle ORM on Postgres
- Better Auth (organizations, phone-code sign-in)
- Photon iMessage
- Stripe Connect for deposits and invoice payments
- Vercel Blob for photos, priced photos, and PDFs
- sharp for drawing the priced photo, pdf-lib for quote and invoice PDFs

## Run locally

Needs Node 24 or newer and a local Postgres.

```bash
npm install
cp .env.example .env.local
```

Fill in `.env.local`: at least `DATABASE_URL`, `META_MODEL_API_KEY`, and `BETTER_AUTH_SECRET`
(`openssl rand -hex 32`). For local work, turn on the fake modes below so nothing reaches a real
phone, inbox, or card. Then:

```bash
node --env-file=.env.local node_modules/.bin/drizzle-kit migrate   # or: npm run db:migrate with DATABASE_URL set
cp provision.example.json provision.json                           # a business and its owner
npm run provision
npm run seed:vertical -- landscaping                                # the landscaping price book, rules, and notes
npm run dev          # the web app at http://localhost:3000, agents at /eve/<name>/v1
npm run dev:agent    # optional: the assistant alone, in eve's terminal UI
```

`npm run dev` mounts each agent beside the app: the assistant at `/eve/assistant/v1` and the page
designer at `/eve/designer/v1` (off unless `DESIGNER_ENABLED=1`). Members sign in with their phone;
the code is posted in their iMessage thread, and with `LOGIN_CODE_LOG=1` it also prints to the server
console. Super admins are made with `npm run admin:create -- you@example.com` and must be listed in
`SUPER_ADMIN_EMAILS`.

## Trade packs

A trade lives in `verticals/<id>/`: price book items (each with a `photoPrompt` when a photo can show
it), pricing rules, business notes, a minimum charge, and an instruction overlay. Landscaping is the
one pack today.

- `npm run seed:vertical -- landscaping [provision.json]` loads the pack's items, rules, notes, and
  minimum into the business whose owner is in `provision.json`. It finds the business by the owner's
  phone, touches no other business, and is safe to run again.
- `VERTICAL=landscaping` adds the pack's instructions (vocabulary, units to ask for, photo and rule
  handling) to the assistant every turn. Unset or `none`, the assistant stays trade-agnostic; an
  unknown name is an error.

## Line prices for customers

Each business chooses whether its customers see line prices (Settings → Payments, or text the
assistant "hide line prices from customers"). Off, the quote link, its PDF, and the priced photo show
each line's name and quantity and only the totals; the business still sees every price. It's on by
default, and a trade pack may set it with `profile.customerLinePrices`. Invoices follow the same
setting.

## Environment

Everything is listed with comments in `.env.example`.

- `DATABASE_URL`: the Postgres for every business.
- `META_MODEL_API_KEY` (required), `MODEL_BASE_URL` (default `https://api.meta.ai/v1`), `MODEL_ID`
  (default `muse-wonder-1.0`), `MODEL_FALLBACK_ID` (default `muse-spark-1.3`), `MODEL_USE_FALLBACK=1`
  to run on the fallback, `MODEL_REASONING_EFFORT` (`low`, `medium`, `high`), `MODEL_CONTEXT_TOKENS`
  (the context budget compaction works from), and `MODEL_API=chat` to use Chat Completions instead
  of the Responses API. `SAM_MODEL_ID` (default `sam-3.1`) is the segmentation model for priced
  photos.
- `VERTICAL`: the trade pack's instructions. `EVAL_MODEL_ID` and `EVAL_JUDGE_MODEL_ID`: the agent's
  and the judge's models in evals.
- `MODEL_PRICES` (list prices for cost estimates, JSON) and `USAGE_HOURLY_TURNS`,
  `USAGE_HOURLY_OUTPUT_TOKENS`, `USAGE_CONCURRENT_TURNS`, `USAGE_TURN_OUTPUT_RESERVE` (default limits
  per business).
- `IMESSAGE_PROJECT_ID`, `IMESSAGE_PROJECT_SECRET`, `IMESSAGE_WEBHOOK_SECRET`: Photon iMessage.
- `BLOB_READ_WRITE_TOKEN`: Vercel Blob.
- `RESEND_API_KEY`, `EMAIL_FROM`: emailing quotes. Without them, members forward the PDF.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`: Stripe Connect. Without them, invoices go out
  without a pay link.
- `AGENTMAIL_API_KEY`, `AGENTMAIL_WEBHOOK_SECRET`, `AGENTMAIL_DOWNLOAD_HOSTS`: email intake.
- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `SUPER_ADMIN_EMAILS`: web sign-in and super admins.

## Fake modes

Each switch stands in for an outside service on this machine. Never set them in production.

- `IMESSAGE_FAKE=1`: prints iMessage posts, files, and tapbacks instead of sending them.
- `PHOTON_ADMIN_FAKE=1`: provisions businesses and members without Photon credentials.
- `EMAIL_FAKE=1`: records quote emails instead of sending them through Resend.
- `STRIPE_FAKE=1`: a local Stripe with accounts, a checkout page, and signed webhook events.
- `AGENTMAIL_FAKE=1`: local inboxes and signed webhook events for email intake.
- `BLOB_FAKE=1`: skips Vercel Blob and returns placeholder URLs (`BLOB_LOCAL_DIR` saves files to a folder instead).
  For photos sent in web chat, set `BLOB_LOCAL_DIR=.local-blobs` so the stored copy opens on the quote
  page; the model is sent the photo's bytes either way. The priced photo needs the stored bytes too:
  with only `BLOB_FAKE=1`, `price_photo` reports the photo as unreadable.
- `PLACES_FAKE=1`: places the seeded addresses at made-up points without asking the geocoder. On by
  default locally when unset; `PLACES_FAKE=0` asks the US Census geocoder.
- `WEATHER_FAKE=1`: a fixed forecast, dry but for rain at 70% from 10 AM to 2 PM tomorrow. On by default
  locally when unset; `WEATHER_FAKE=0` asks api.weather.gov (`WEATHER_CONTACT` is the email its User-Agent gives).
- `LOGIN_CODE_LOG=1`: prints sign-in codes to the server console.

## Tests, evals, and tools

```bash
npm run typecheck
npm test            # no database or keys needed; every outside service is forced to its fake
npm run test:db     # also the tests that need DATABASE_URL; empties its tables
npm run evals       # conversation evals in agents/assistant/evals/ against a local agent
VERTICAL=landscaping npm run evals   # the same, with the landscaping instructions
npm run scorecard   # landscaping evals with and without the pack; writes docs/evals/scorecard.md
npm run scorecard -- --spark         # and a third run of the pack on Muse Spark
npm run traces:export -- --org <slug> --redact > traces.jsonl   # every turn's trace, one JSON line each
npm run smoke:model # live check of the Meta Model API: text, tool call, structured output, fallback
npm run sam:probe -- agents/assistant/evals/fixtures/yard-front.jpg lawn "mulch bed"   # SAM 3.1 on a photo
```

`npm test` runs offline: `scripts/test-env.ts` switches every outside service to its fake and blanks
real credentials. SAM tests decode a recorded stream in `test-fixtures/sam/`. `npm run test:db`,
`npm run evals`, and `npm run scorecard` empty the tables of the database they point at, so give them
a local database of their own, and never run them at the same time.

The scorecard runs the evals tagged `landscaping` twice on the same seeded business: a baseline with
`VERTICAL=none` and a run with `VERTICAL=landscaping`. The latest results are in
[docs/evals/scorecard.md](docs/evals/scorecard.md). `traces:export` also takes `--since <ISO time>`
and `--out <path>`; `--redact` blanks phones, emails, and addresses. `sam:probe` writes overlays to
`/tmp/sam-probe/`. The yard photo the photo evals send is made by Muse Image:
`node --env-file=.env.local node_modules/.bin/tsx agents/assistant/evals/fixtures/generate-yard-photo.ts`.

## Deploy

Groundwork runs as one Vercel project for every business, with a Neon Postgres and a Vercel Blob
store.

1. Set the environment on the project: everything in `.env.example` that production needs, none of
   the fake switches.
2. Migrate production before deploying. Nothing migrates on its own, and a production build stops if
   the database is missing a migration:
   ```bash
   DATABASE_URL="<production url>" npm run db:migrate
   npm run db:check
   ```
3. `vercel deploy --prod`.
4. Provision each business against production and point the Photon webhook at the deployment.

## License

MIT. See [LICENSE](LICENSE). The UI kit in `ui/beautiful/` keeps its own MIT license.
