# Running Groundwork in production

How to run your own Groundwork with real iMessage texting, file storage, and, if you want them, email,
card payments, and email intake. The live demo runs this way. To run it on one machine without these
services, see [README.md: Run it locally](../README.md#run-it-locally).

Groundwork is one Vercel project for every business, with one Postgres database. Every table is scoped
by business, so one deployment serves many.

## What you need

| Service | Needed for | Required |
| --- | --- | --- |
| Meta Model API key | Muse Wonder (the agents) and SAM 3.1 (priced photos), on one key | Yes |
| [Vercel](https://vercel.com), Pro plan | Hosting. The scheduled jobs run as Vercel crons every minute, every 10 minutes, and hourly, which needs Pro. | Yes |
| Postgres ([Neon](https://neon.tech) works well) | Everything the app stores | Yes |
| Vercel Blob store | Photos, priced photos, and PDFs (they need public URLs for texts and customer links) | Yes |
| [Photon](https://photon.codes) project | iMessage: texting the agent, sign-in codes, crew texts | Yes, for texting |
| [Resend](https://resend.com) | Emailing quotes and invoices to customers | No: without it, members forward the PDF |
| [Stripe](https://stripe.com) with Connect | Deposits and invoice payments by card, on each business's own account | No: without it, invoices go out without a pay link |
| [AgentMail](https://agentmail.to) | Forwarding customer emails to the agent | No |

Addresses (US Census geocoder) and weather (api.weather.gov) need no keys and are always live on Vercel.

## 1. The database

Create an empty Postgres database and migrate it from your machine. Nothing migrates on its own, and a
production build stops if the database is missing a migration.

```bash
DATABASE_URL="<production url>" npm run db:migrate
DATABASE_URL="<production url>" npm run db:check
```

Run the same two commands before deploying any commit that adds a file under `schema/migrations/`.

## 2. The Vercel project

Import the repository into Vercel (framework: Next.js; the build command is `npm run build`, which
builds both agents with the app). Create a Blob store in the project's Storage tab, which sets
`BLOB_READ_WRITE_TOKEN`. Then set the environment for Production:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | The production database |
| `META_MODEL_API_KEY` | Your Meta Model API key |
| `BETTER_AUTH_SECRET` | `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | The app's public URL, such as `https://groundwork.example.com`. Optional on a `*.vercel.app` URL. |
| `VERTICAL` | `landscaping` (or `irrigation`, `pool`, `tree`): the trade pack's instructions |
| `BLOB_READ_WRITE_TOKEN` | Set by the Blob store |
| `IMESSAGE_PROJECT_ID`, `IMESSAGE_PROJECT_SECRET`, `IMESSAGE_WEBHOOK_SECRET` | From Photon, step 3 |
| `DESIGNER_ENABLED` | `1` to turn on the page designer agent (optional) |
| `WEATHER_CONTACT` | An email for api.weather.gov's User-Agent (optional) |
| `SUPER_ADMIN_EMAILS` | Emails allowed to become super admins (optional, step 6) |

Never set the `*_FAKE` switches, `LOGIN_CODE_LOG`, or `BLOB_LOCAL_DIR` in production. The model
settings (`MODEL_ID`, `MODEL_FALLBACK_ID`, `MODEL_REASONING_EFFORT`, usage limits) have working
defaults; `.env.example` lists them all.

## 3. iMessage with Photon

1. Install the CLI and sign in: `npx @photon-ai/cli login` (a browser sign-in).
2. Create a project. Its id and secret are `IMESSAGE_PROJECT_ID` and `IMESSAGE_PROJECT_SECRET`.
   Photon's free tier texts from a shared line, and Groundwork gives each member their own user on
   it. A dedicated line per business needs Photon's business plan.
3. Point the project's webhook at the deployment. With the two values in `.env.local`:

   ```bash
   npm run photon:webhook -- add https://<your-domain>/eve/assistant/v1/photon
   ```

   It prints only the signing secret. Set it as `IMESSAGE_WEBHOOK_SECRET` on Vercel, for example by
   piping it to `vercel env add IMESSAGE_WEBHOOK_SECRET production`. Keep one webhook per project,
   or every text is answered twice (`npm run photon:webhook -- list` and `remove <id>`).

To check it after deploying: an unsigned `POST` to the webhook URL answers 400, and a bad signature 401.

## 4. Deploy

Push to the branch Vercel deploys, or run `vercel deploy --prod`. The build checks the database's
migrations first and stops with a message if one is missing.

## 5. Add a business and its people

Each business is provisioned from a JSON file. Copy `provision.example.json` to `provision.json`
(it's gitignored), put in the business's name and time zone and the owner's name and real cell, and
run it against production with the Photon values set:

```bash
DATABASE_URL="<production url>" npm run provision          # prints the number each person texts
DATABASE_URL="<production url>" npm run seed:vertical -- landscaping   # price book, rules, notes
```

The owner texts that number once and gets the welcome. From then on they can text jobs, sign in on
the web with their cell (the code arrives in the same thread), and add their team by text ("add Carlos
as crew, 561 555 0123") or on the Team page. A member has to text the line once before the agent can
text them.

## 6. Optional services

- **Email out (Resend).** Verify a sending domain, then set `RESEND_API_KEY` and `EMAIL_FROM` (an
  address on that domain). "Email it to Maria" then sends the quote.
- **Payments (Stripe Connect).** Turn on Connect for your Stripe platform account and set
  `STRIPE_SECRET_KEY`. Add a webhook endpoint at `https://<your-domain>/api/webhooks/stripe` that
  listens to events on connected accounts (`checkout.session.completed`,
  `checkout.session.async_payment_succeeded`, `charge.refunded`, `account.updated`,
  `account.application.deauthorized`), and set its signing secret as `STRIPE_WEBHOOK_SECRET`. Each
  business connects its own Stripe account from Settings → Payments; deposits and invoice payments go
  to that account.
- **Email in (AgentMail).** Set `AGENTMAIL_API_KEY`, add a webhook at
  `https://<your-domain>/api/webhooks/agentmail`, and set its secret as `AGENTMAIL_WEBHOOK_SECRET`.
  Give a business its inbox with `npm run email:inbox -- <business slug>` or from the admin pages.
  Senders are verified with DKIM and DMARC before the agent reads anything.
- **Super admins.** List the email in `SUPER_ADMIN_EMAILS`, then run
  `DATABASE_URL="<production url>" npm run admin:create -- you@example.com`. Super admins manage
  businesses but can't read members' threads.

## 7. Check it

1. `npm run smoke:model` with the production key: text, a tool call and its second step, structured
   output, and the fallback model, against the live API.
2. Text the line from the owner's phone: "Maria at 412 Oak St, 3 yards of mulch, mow the front", with
   a yard photo. A quote PDF and a priced photo come back in the thread.
3. Sign in on the web with the same cell. The thread is there, and **Under the hood** shows the turn's
   tool calls.
