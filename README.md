# Groundwork

Groundwork is a field-service agent for landscaping crews. A crew member texts a messy job
description and a few yard photos over iMessage or the web chat, and Groundwork turns it into a
priced quote PDF, a link where the customer approves and pays a deposit, a booked visit, and an
invoice. It runs on Meta's Muse models and uses SAM 3.1 on yard photos.

## Stack

- Next.js 16 (App Router) and React 19, TypeScript, Node 24
- Vercel Eve agent runtime and the AI SDK
- Drizzle ORM on Postgres
- Better Auth (organizations, phone-code sign-in)
- Photon iMessage
- Stripe Connect for deposits and invoice payments
- Vercel Blob for photos and PDFs

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
npm run seed:vertical -- landscaping                                # optional: the landscaping price book, rules, and notes
npm run dev          # the web app at http://localhost:3000, agents at /eve/<name>/v1
npm run dev:agent    # optional: the assistant alone, in eve's terminal UI
```

`npm run dev` mounts each agent beside the app: the assistant at `/eve/assistant/v1` and the page
designer at `/eve/designer/v1`. Members sign in with their phone; with `LOGIN_CODE_LOG=1` the
sign-in code prints to the server console. Super admins are made with
`npm run admin:create -- you@example.com` and must be listed in `SUPER_ADMIN_EMAILS`.

## Fake modes

Each switch stands in for an outside service on this machine. Never set them in production.

- `IMESSAGE_FAKE=1`: prints iMessage posts, files, and tapbacks instead of sending them.
- `PHOTON_ADMIN_FAKE=1`: provisions businesses and members without Photon credentials.
- `EMAIL_FAKE=1`: records quote emails instead of sending them through Resend.
- `STRIPE_FAKE=1`: a local Stripe with accounts, a checkout page, and signed webhook events.
- `AGENTMAIL_FAKE=1`: local inboxes and signed webhook events for email intake.
- `BLOB_FAKE=1`: skips Vercel Blob and returns placeholder URLs (`BLOB_LOCAL_DIR` saves files to a folder instead).
- `LOGIN_CODE_LOG=1`: prints sign-in codes to the server console.

## Tests and evals

```bash
npm run typecheck
npm test            # no database or keys needed; every outside service is forced to its fake
npm run test:db     # also the tests that need DATABASE_URL; empties its tables
npm run evals       # conversation evals in agents/assistant/evals/ against a local agent
VERTICAL=landscaping npm run evals   # the same, with the landscaping instructions
```

`npm test` runs offline: `scripts/test-env.ts` switches every outside service to its fake and blanks
real credentials. `npm run test:db` and `npm run evals` empty the tables of the database they point at,
so give them a local database of their own, and never run them at the same time.

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
