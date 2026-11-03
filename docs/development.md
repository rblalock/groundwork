# Development

Setup, configuration, tests, evals, and deploy.

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
(`openssl rand -hex 32`). For local work, turn on the switches below so nothing reaches a real
phone, inbox, or card, and save files to disk so photos can be priced:

```bash
VERTICAL=landscaping
IMESSAGE_FAKE=1
PHOTON_ADMIN_FAKE=1
EMAIL_FAKE=1
STRIPE_FAKE=1
AGENTMAIL_FAKE=1
BLOB_LOCAL_DIR=.local-blobs
LOGIN_CODE_LOG=1
```

Then:

```bash
node --env-file=.env.local node_modules/.bin/drizzle-kit migrate   # or: npm run db:migrate with DATABASE_URL set
cp provision.example.json provision.json                           # a business and its owner
npm run provision
npm run seed:vertical -- landscaping                                # the landscaping price book, rules, and notes (or irrigation, pool, tree)
npm run dev          # the web app at http://localhost:3000, agents at /eve/<name>/v1
npm run dev:agent    # optional: the assistant alone, in eve's terminal UI
```

`npm run dev` mounts each agent beside the app: the assistant at `/eve/assistant/v1` and the page
designer at `/eve/designer/v1` (off unless `DESIGNER_ENABLED=1`). Members sign in with their phone;
the code is posted in their iMessage thread, and with `LOGIN_CODE_LOG=1` it also prints to the server
console. Super admins are made with `npm run admin:create -- you@example.com` and must be listed in
`SUPER_ADMIN_EMAILS`.

The app reaches its own agent routes at `BETTER_AUTH_URL`, or `http://localhost:3000` when it's unset,
so on another port set `BETTER_AUTH_URL=http://localhost:<port>`. With iMessage faked, the web chat is
the way in: sign in, and the home page is the owner's thread.

## Using real services

Each outside service is optional and replaces one `*_FAKE` switch. Unset the switch when you set the
real keys. Webhooks need a public HTTPS URL: a deployment, or a tunnel to this machine.

- **Meta Model API** (required either way): `META_MODEL_API_KEY`. The same key runs Muse Wonder and
  SAM 3.1. `npm run smoke:model` checks it.
- **iMessage (Photon)**: a Photon project with a line. Set `IMESSAGE_PROJECT_ID` and
  `IMESSAGE_PROJECT_SECRET`, drop `IMESSAGE_FAKE` and `PHOTON_ADMIN_FAKE`, and point the line's
  webhook at `https://<host>/eve/assistant/v1/photon`:
  `npm run photon:webhook -- add <url>` prints the signing secret for `IMESSAGE_WEBHOOK_SECRET`.
  Locally, `scripts/photon-tunnel.sh up` gives a public URL for an agent run with `npm run dev:photon`.
  Then `npm run provision` assigns members to the line, and their first text gets the welcome.
- **File storage (Vercel Blob)**: `BLOB_READ_WRITE_TOKEN`, and unset `BLOB_LOCAL_DIR`. Customers' links
  and texted PDFs need public URLs, so production uses Blob.
- **Email out (Resend)**: `RESEND_API_KEY` and an `EMAIL_FROM` on a domain verified with Resend. Drop
  `EMAIL_FAKE`.
- **Payments (Stripe Connect)**: `STRIPE_SECRET_KEY` (test mode works) and a webhook to
  `https://<host>/api/webhooks/stripe` whose secret is `STRIPE_WEBHOOK_SECRET`. Drop `STRIPE_FAKE`.
  Each business connects its own account from Settings → Payments.
- **Email in (AgentMail)**: `AGENTMAIL_API_KEY` and a webhook to `https://<host>/api/webhooks/agentmail`
  whose secret is `AGENTMAIL_WEBHOOK_SECRET`. Drop `AGENTMAIL_FAKE`.
- **Addresses and weather**: no keys. `PLACES_FAKE=0` uses the US Census geocoder and
  `WEATHER_FAKE=0` uses api.weather.gov (`WEATHER_CONTACT` is the email its User-Agent gives).

## Trade packs

A trade lives in `verticals/<id>/`: price book items (each with a `photoPrompt` when a photo can show
it, and the `equipment` the work needs), pricing rules, business notes, a minimum charge, and an
instruction overlay. Four packs ship:

- `landscaping`: mowing, mulch, edging, hedges, palms, shrubs, sod, cleanup, haul-away, sprinkler heads.
- `irrigation`: zone inspections, heads, valves, controllers, drip line, pipe repairs, backflow tests,
  wire tracing, seasonal start-ups.
- `pool` (pool service): weekly service and chemicals, green-to-clean, filter and salt cell cleaning,
  pump motors, acid wash, waterline tile, leak detection.
- `tree` (tree work): removals, crown and palm trimming, stump grinding, limbs, storm debris, chipping,
  haul-away, crane days.

Each has three or more evals in `agents/assistant/evals/<id>/`, tagged with its id.

- `npm run seed:vertical -- landscaping [provision.json]` (or `-- pool`, and so on) loads the pack's
  items, rules, notes, and minimum into the business whose owner is in `provision.json`. It finds the
  business by the owner's phone, touches no other business, and is safe to run again.
- `VERTICAL=landscaping` (or another pack's id) adds the pack's instructions (vocabulary, units to
  ask for, photo and rule handling) to the assistant every turn. Unset or `none`, the assistant stays
  trade-agnostic; an unknown name warns once and runs without a pack.

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

## Running without outside services

The `*_FAKE` switches let the app run on one machine with no iMessage line, email domain, Stripe
account, or inbound mailbox. Each one replaces only the delivery to that service: what would have gone
out is printed or recorded instead. The agent, Muse Wonder, SAM 3.1, the calculator, and the database
run for real either way. Never set them in production.

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
npm run scorecard -- --vertical pool # another pack's evals; writes docs/evals/scorecard-pool.md
npm run traces:export -- --org <slug> --redact > traces.jsonl   # every turn's trace, one JSON line each
npm run traces:dataset -- --org <slug> --out dataset.jsonl       # the turns as training examples, redacted
npm run evals:capture -- --tag landscaping                       # a passing eval run's turns as examples
npm run scorecard -- --model <id> --base-url <url>               # and a tuned model as one more condition
npm run smoke:model # live check of the Meta Model API: text, tool call, structured output, fallback
npm run sam:probe -- agents/assistant/evals/fixtures/yard-front.jpg lawn "mulch bed"   # SAM 3.1 on a photo
```

`npm test` runs offline: `scripts/test-env.ts` switches every outside service to its fake and blanks
real credentials. SAM tests decode a recorded stream in `test-fixtures/sam/`. `npm run test:db`,
`npm run evals`, `npm run evals:capture`, and `npm run scorecard` empty the tables of the database
they point at, so give them a local database of their own, and never run them at the same time.

The scorecard runs the evals tagged with a pack's id (`landscaping` unless `--vertical` names
another) twice on the same seeded business: a baseline with `VERTICAL=none` and a run with the pack.
The latest landscaping results are in [docs/evals/scorecard.md](evals/scorecard.md). `traces:export` also takes `--since <ISO time>`
and `--out <path>`; `--redact` blanks phones, emails, and addresses.

`traces:dataset` writes one fine-tuning example per completed turn: the system prompt it ran with, the
member's message, the tool calls, results, and reply, and the tools it had, as chat-completions JSONL
(`--format openai`) or Llama 3.x template text (`--format llama`), with customers' names, addresses,
phones, and emails replaced. `evals:capture` writes the same from the evals that pass, and
`scorecard -- --model` scores the tuned model. The recipe is in
[docs/post-training.md](post-training.md).

`sam:probe` writes overlays to `/tmp/sam-probe/`. The yard photo the photo evals send is made by Muse Image:
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
