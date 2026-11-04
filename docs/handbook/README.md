# Groundwork operations handbook

[Read the four-sheet PDF](groundwork-handbook.pdf) · [First-sheet preview](groundwork-handbook.png) ·
[Editable HTML](groundwork-handbook.html)

An Apollo Operations Handbook–style explanation of Groundwork, based on implementation revision
[`d59aa6f`](https://github.com/rblalock/groundwork/tree/d59aa6f19f1224eb8db61f7b6a53f6b1d04d7c2d),
dated 4 November 2026. Git is the canonical source. This is a system explanation, not a security
audit or a claim that every production service has been exercised.

## Contents

| Sheet | Subject | Figures |
| --- | --- | --- |
| 2.1-1 | System arrangement | Member → agent → guarded tools → records; quote → payment |
| 2.2-1 | Quotation and photo system | Photo regions and quote lines; calculator pipeline |
| 2.3-1 | Scheduling and dispatch | Availability and routes; guarded rescheduling |
| 2.4-1 | Setup and operating limits | Runtime and delivery adapters; customer-page designer |

The model interprets the request. Code checks identity, computes prices, and controls state changes.
The diagrams show functional paths, not every HTTP request or return message. The photo is a drawn
schematic, not an actual SAM result or a measured property. Tables distinguish base defaults from
landscaping-pack defaults; businesses can change their settings and rates.

## Worked example

The sample follows the repository's landscaping demo: 3 cubic yards of mulch at 9,500 cents per yard,
150 cubic feet of hedge trimming at 250 cents per cubic foot, and one mowing visit at 6,500 cents.
The calculator returns 28,500 + 37,500 + 6,500 = **72,500 cents ($725)**. No rule, adjustment, or tax
is selected; the 15,000-cent minimum adds nothing. Counts in the drawing are illustrative confirmed
inputs, not quantities inferred from its geometry. A photo region never adds a second charge.

## Start the app

Follow [development.md](../development.md) for the full setup. From the repo root, with Node 24+
and an **empty development Postgres database**:

```bash
npm ci
cp .env.example .env.local
```

Set `DATABASE_URL`, `META_MODEL_API_KEY`, and `BETTER_AUTH_SECRET` in `.env.local`. For development,
add these switches (the auth secret can be generated with `openssl rand -hex 32`):

```dotenv
VERTICAL=landscaping
IMESSAGE_FAKE=1
PHOTON_ADMIN_FAKE=1
EMAIL_FAKE=1
STRIPE_FAKE=1
AGENTMAIL_FAKE=1
BLOB_LOCAL_DIR=.local-blobs
LOGIN_CODE_LOG=1
```

```bash
node --env-file=.env.local node_modules/.bin/drizzle-kit migrate
cp provision.example.json provision.json
# Edit provision.json for the business and owner before provisioning.
npm run provision
npm run seed:vertical -- landscaping
npm run dev
```

Sign in with the provisioned owner's phone at `/sign-in`; the development code prints in the server
console. The app defaults to port 3000. On another port, set `BETTER_AUTH_URL` to its actual origin.
Fake delivery still makes real model calls and incurs Meta usage. Use `BLOB_LOCAL_DIR`, not only
`BLOB_FAKE`, when pricing photos: the tool needs stored image bytes.

For production, follow [production.md](../production.md): real credentials, public Blob URLs,
verified webhooks, Vercel Pro for the subdaily cron jobs, no fake switches or sign-in-code logging,
and explicit database migration before deployment. `DESIGNER_ENABLED=1` enables the optional
customer-page designer; its HTML/CSS is validated and prices/forms stay controlled by the server.

## Source map

All paths below are relative to the repository root and were inspected at the source revision above.

| Subject | Implementation and operating instructions |
| --- | --- |
| Architecture, channels, trade packs | [README](../../README.md), [AGENTS](../../AGENTS.md), [features](../features.md), [assistant instructions](../../agents/assistant/agent/instructions.md), [agent](../../agents/assistant/agent/agent.ts) |
| Caller, role, email and business boundary | [tool context](../../core/tool-context.ts), [members](../../core/members.ts) |
| Rates, calculation, revisions, approvals | [calculator](../../core/calculator.ts), [money](../../core/money.ts), [quotes](../../core/quotes.ts), [quote link](../../core/quote-link.ts), [landscaping pack](../../verticals/landscaping/index.ts) |
| Photo outlines and selection | [priced photo](../../core/priced-photo.ts), [candidate selection](../../core/priced-photo-select.ts), [SAM](../../core/sam.ts) |
| Visits, routes and move proposals | [jobs](../../core/jobs.ts), [places](../../core/places.ts), [scheduling](../../core/scheduling.ts), [route days](../../core/route-days.ts), [route order](../../core/route-order.ts), [proposals](../../core/proposals.ts), [running long](../../core/running-long.ts), [weather](../../core/weather.ts) |
| Profile defaults | [schema](../../schema/schema.ts) |
| Invoices and payments | [invoice tools](../../core/invoice-tools.ts), [quote acceptance/deposit](../../core/quote-link.ts) |
| Model selection and cost estimates | [model pricing](../../core/model-pricing.ts) |
| Customer-page restrictions | [template validation](../../core/customer-page-template.ts), [CSP](../../core/customer-page-csp.ts) |
| Scheduled work | [text queue](../../agents/assistant/agent/schedules/texts.ts), [running long](../../agents/assistant/agent/schedules/running-long.ts), [hourly](../../agents/assistant/agent/schedules/hourly.ts) |
| Setup and deployment | [development](../development.md), [production](../production.md), [environment example](../../.env.example), [package scripts](../../package.json) |

## Re-render and check

The source adapts the supplied template, typefaces, and drafting rules from
[R44VC0RP's nasa-handbook skill](https://github.com/R44VC0RP/skills/tree/0623f2ea9800f277e0e4e89bcc50a5290de3ab0f/skills/nasa-handbook).
Keep `fonts/` beside the HTML. Routed Gothic and Letter Gothic Code retain their bundled licenses.
The text face uses Georgia where available, with the browser's serif fallback otherwise.

Install Chrome/Chromium, Python 3, and PyMuPDF (the checked rendering used 1.26.7). Clone the skill
repository at that revision outside this project. From the Groundwork root, set `SKILL_DIR` to its
`skills/nasa-handbook` directory, then run:

```bash
sh "$SKILL_DIR/scripts/render.sh" docs/handbook/groundwork-handbook.html
python3 "$SKILL_DIR/scripts/check.py" docs/handbook/groundwork-handbook.pdf \
  --pages 4 --out /tmp/groundwork-handbook-check
```

`render.sh` writes the vector PDF and first-sheet PNG beside the HTML. Its fit check covers all four
sheets. Review every sheet and enlarged checker tile for touching labels, misdirected arrows, and
clipping. The output must remain four A4 sheets, black and white, with the supplied drawing and
checklist fonts embedded. Print the PDF at actual size, without browser headers or footers.

Repository checks:

```bash
npm run typecheck
npm run check:words
npm test
```

Run offline tests with `DATABASE_URL` unset. Database-backed tests are skipped without it; **when set,
the tests empty that database**. `test:db`, evals, and scorecards also erase their target database;
live evals spend model tokens. None is needed just to render this handbook.
