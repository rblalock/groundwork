# Groundwork

Groundwork is a field-service agent for landscaping crews. A crew member texts a messy job
description and a few yard photos over iMessage or the web chat, and Groundwork turns it into a
priced quote PDF, a priced photo with each quoted thing outlined and labeled, a link where the
customer approves and pays a deposit, a booked visit, and an invoice. The agent runs on Muse Wonder
through Meta's Model API, and SAM 3.1 outlines the quoted lines on the yard photo. Every object SAM
finds is kept with its outline, so a member can edit the photo on the quote page without another SAM
call. The model judges what the member means; code checks who they are and does the math.

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
