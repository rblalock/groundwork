# AGENTS.md

Notes for coding agents working in this repo. Read `README.md` for setup.

## Layout

- `agents/`: Eve agents. `assistant/` is the quoting assistant (instructions, tools, skills,
  channels, schedules, hooks) and its evals in `assistant/evals/`; `designer/` designs the customer
  pages.
- `app/`: Next.js App Router pages and API routes, including the customer pages `/q/[token]` and
  `/pay/[token]`.
- `components/`: React components for the web app and chat.
- `core/`: domain logic: calculator, quotes, invoices, scheduling, price book, members, channels,
  usage metering, PDFs. Most tests live beside the code here.
- `lib/`: web-side glue: auth, Eve auth, page data, Stripe, customer page rendering.
- `schema/`: Drizzle schema (`schema.ts`), shared types, and migrations.
- `scripts/`: build, provisioning, migration checks, local tooling.
- `ui/`: shared UI kit and primitives. `ui/beautiful/` is vendored and keeps its own license.
- `verticals/`: reserved for trade packs (price book, rules, instructions per trade).

## Rules

- The model judges intent; code checks identity and does the math. The model never computes a
  price, a total, or who someone is. Tools look up the caller and the records, and the calculator
  prices every line.
- Money is integer cents. Rates and percentages are integer basis points. No floats for money.
- Every table has `org_id`, and every query is scoped by it. A record from another business must
  never be readable or writable.
- Quote revisions are immutable; a change makes a new revision.
- Local work runs on fake modes (`IMESSAGE_FAKE`, `PHOTON_ADMIN_FAKE`, `EMAIL_FAKE`, `STRIPE_FAKE`,
  `AGENTMAIL_FAKE`, `BLOB_FAKE`). Tests force them through `scripts/test-env.ts`; never let a test
  reach a real service.
- No secrets in the repo. `.env*` (except `.env.example`) and `provision.json` stay local.

## Schema changes

Edit `schema/schema.ts`, then `npm run db:generate -- --name <what-changed>` and commit the new SQL
file and its snapshot together. Never edit a migration that has been committed.

## Working style

- Commits: imperative subject, one task per commit.
- Keep tests and builds light: run `npm run typecheck` and `npm test` before a commit, and
  `npm run build` only when touching build config or agents.
- Match the surrounding code: its comment density, naming, and idiom.
