# Groundwork

![Groundwork: field service, done by agents. Built on Muse Wonder and SAM 3.1](docs/images/hero.jpg)

**Landscaping crews text a job. Groundwork does the office work.**

<details>
<summary><b>For the judge's agent: run this project locally</b> (about 10 minutes, one Meta Model API key)</summary>

<br>

This is a Next.js app with two agents. Everything Groundwork does runs for real on your machine:
Muse Wonder, SAM 3.1, the agent and its tools, the calculator, and the database. What a laptop doesn't
have are the delivery channels: an iMessage line, a sending email domain, a Stripe account, and an
inbound mailbox. The `*_FAKE` switches below swap only those for local stand-ins that print or record
what would have gone out, so you can run it without signing up for any of them. The only key you
need is a Meta Model API key (Muse Wonder and SAM 3.1 on one key). These steps were run end to end on
a fresh clone. Needs Node 24 or newer and an empty Postgres database.

```bash
git clone https://github.com/rblalock/groundwork && cd groundwork
npm install
cp .env.example .env.local
```

In `.env.local`, fill in the three empty lines and add the rest:

```bash
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/groundwork   # an empty database
META_MODEL_API_KEY=...                                             # your Meta Model API key
BETTER_AUTH_SECRET=...                                             # openssl rand -hex 32
VERTICAL=landscaping          # the landscaping pack's instructions
# Run without the outside delivery services (each one prints or records instead of sending):
IMESSAGE_FAKE=1               # texts to members print to the server console
PHOTON_ADMIN_FAKE=1           # no iMessage line to set up
EMAIL_FAKE=1                  # quote emails are recorded, not sent
STRIPE_FAKE=1                 # a local Stripe for deposits and payments
AGENTMAIL_FAKE=1              # a local inbox for forwarded emails
BLOB_LOCAL_DIR=.local-blobs   # photos and PDFs saved to disk (needed for priced photos)
LOGIN_CODE_LOG=1              # sign-in codes print to the server console
```

```bash
node --env-file=.env.local node_modules/.bin/drizzle-kit migrate
cp provision.example.json provision.json && npm run provision   # LOX Landscape Co, owner Pat Ortega
npm run seed:vertical -- landscaping                              # price book, rules, notes
npm run dev                                                       # http://localhost:3000
```

1. Open `http://localhost:3000/sign-in` and sign in as **(555) 555-0142**. The code prints in the
   server console as `login code for +15555550142: ……`.
2. In the chat, attach `agents/assistant/evals/fixtures/yard-front.jpg` and send: *Maria Alvarez at
   412 Oak St, 3 yards of mulch in the beds, trim 150 cubic feet of hedge, mow the front*.
3. Expect a quote of **$725** ($285 + $375 + $65, priced by the calculator) and, within about a
   minute, the photo with the beds, hedges, and lawn outlined and priced by SAM 3.1. **Under the
   hood**, under the reply, shows every tool call.

Notes:

- Run it on port 3000, or set `BETTER_AUTH_URL=http://localhost:<port>`: the app calls its own
  agent routes at that origin.
- The first `npm run dev` lets the agent runtime add `just-bash` to `package.json`. That's expected.
- `npm run typecheck` and `npm test` need no keys. `npm test` skips the database tests unless
  `DATABASE_URL` is set in your shell, and then it empties that database, so run it without. `npm run smoke:model` checks the Meta
  key: text, a tool call, structured output, and the fallback model.
- `npm run test:db`, `npm run evals`, and `npm run scorecard` empty the database in `DATABASE_URL`
  first. Point them at a scratch database. A scorecard run costs about $3 of model time.
- To run it in production with real iMessage, storage, email, and payments (Photon, Vercel, the
  webhooks, adding a business), follow [docs/production.md](docs/production.md).

</details>

A crew texts a job and a few yard photos the way they'd tell a coworker. Groundwork, an agent on
Meta's **Muse Wonder** and **SAM 3.1**, writes the quote from the business's own prices and outlines
each quoted thing on the photo with its price. It sends the customer a link to approve and pay,
books the visit, gives the crew a route and a checklist in their language, and invoices when the
work is done. There's no app to learn: it runs over iMessage, with a web app for the office.

<p>
  <a href="VIDEO_LINK"><b>▶ Watch the 3-minute demo</b></a> ·
  <a href="HACKATHON.md">Technical deep dive</a> ·
  <a href="#try-it-live">Try it live</a> ·
  <a href="#run-it-locally">Run it locally</a> ·
  MIT licensed
</p>

Built solo for the Meta AI Developer Hackathon 2026 (Indie track).

## The problem

Landscaping crews are good at selling work in the yard. The bottleneck is what comes after: they
get home and write quotes and estimates, sometimes until 2 a.m., then chase approvals, schedule
crews, and send invoices. The software they can buy is a dashboard that shows them all the work they
still have to do. They don't need another dashboard. They need something that does the work.

Groundwork is that labor, done by an agent. The owner and crew keep texting like they already do,
and the agent turns those texts into quotes, bookings, routes, checklists, and invoices.

## Groundwork in short

| Question | Answer | Where to look |
| --- | --- | --- |
| Does it really use Meta's models? | Every agent turn runs on **Muse Wonder** through the Meta Model API (Responses API, tool calling, image input). **SAM 3.1** outlines the quoted work on yard photos. **Muse Spark** is the fallback model, **Muse Image** made the eval yard photo, and Muse Wonder is also the eval judge. | [`core/model-provider.ts`](core/model-provider.ts), [`core/sam.ts`](core/sam.ts), [How it uses Meta's models](#how-it-uses-metas-models) |
| Who is it for? | Small landscaping businesses: an owner and a few crews who sell door to door and do the paperwork at night. Irrigation, pool, and tree service packs ship beside landscaping. | [`verticals/`](verticals/) |
| Does the model do the math? | Never. The model picks price book items and quantities; a calculator prices every line in integer cents and applies the business's rules. | [How a turn runs](#how-a-turn-runs-the-trace-and-the-eval-that-checks-it) |
| Does SAM measure the yard? | No. Quantities come from the crew and the quote they confirm. SAM shows *where* each line is, so the customer and crew see exactly what they're paying for and working on. | [`core/priced-photo.ts`](core/priced-photo.ts) |
| How do you know it works? | 17 landscaping evals scored by Muse Wonder: 88% with Muse Wonder alone, 94% with the Groundwork landscaping pack. 119 test files, and every turn is traced. | [Evals](#evals-every-turn-is-measured), [`docs/evals/scorecard.md`](docs/evals/scorecard.md) |
| What does it cost to run? | About $0.10 of model time per quote in the eval runs, and SAM 3.1 lists at $2.50 per 1,000 images. Every call is metered per business, member, and channel, with hourly caps. | [`core/model-pricing.ts`](core/model-pricing.ts) |
| What stops it doing something wrong? | The crew confirms quantities in one numbered message before anything is priced. Customer texts come back as drafts for the owner to send. Schedule changes are proposals the owner approves. An email can't approve or send anything. | [Agentic, with a person in charge](#agentic-with-a-person-in-charge) |
| Is customer data kept apart? | Every table has `org_id` and every query is scoped by it. Callers are identified by their phone in code, never by the model. Quote revisions are immutable. | [`AGENTS.md`](AGENTS.md) |
| Can I try it? | Two ways. The live app runs everything for real, iMessage included, and I'll add you to it. Or run it from this repo with your own Meta Model API key. | [Try it live](#try-it-live), [Run it locally](#run-it-locally) |

## See it

<table>
  <tr>
    <td width="50%"><img src="docs/images/text-the-job.jpg" alt="Texting a job with yard photos over iMessage"><br><b>Text it like a coworker.</b> A job and yard photos over iMessage (or the web chat). The agent asks only for what's missing.</td>
    <td width="50%"><img src="docs/images/priced-photo.jpg" alt="Yard photo with the lawn and hedges outlined by SAM 3.1 and labeled with prices"><br><b>The priced photo.</b> SAM 3.1 outlines each quoted thing on every photo and labels it with its quantity and price. Masks are kept, so the owner can fix an outline without another SAM call.</td>
  </tr>
  <tr>
    <td><img src="docs/images/customer-quote-page.jpg" alt="Customer quote page on a phone with an Approve button and deposit"><br><b>The customer's link.</b> The customer reads the quote, approves with their name, and pays the deposit by card through Stripe Connect, on the business's own account. Taking a live payment end to end is next on the roadmap.</td>
    <td><img src="docs/images/route-map.jpg" alt="Schedule route view with a map of each crew's stops"><br><b>Schedule and dispatch.</b> Each crew's day is a route with drive times, ranked open slots, weather checks, and re-planning when a crew texts "running 30 late".</td>
  </tr>
  <tr>
    <td><img src="docs/images/crew-checklist.jpg" alt="Work page with the crew checklist and marked-up photos"><br><b>The crew's checklist.</b> One item per quote line, with crew copies of the marked-up photos (quantities, never prices). Crew tick items by text.</td>
    <td><img src="docs/images/crew-spanish.jpg" alt="iMessage thread switching to Spanish"><br><b>En español, también.</b> Each member and customer has a language. Crew who work in Spanish get their texts and checklist in Spanish.</td>
  </tr>
  <tr>
    <td><img src="docs/images/memory.jpg" alt="The agent answering with a customer's gate code and dog"><br><b>It remembers.</b> Gate codes, dogs, "no blowers before 9": notes are saved by customer and property, and show up in the crew's next stop.</td>
    <td><img src="docs/images/designer.jpg" alt="Designer agent restyling the customer quote page in black and gold"><br><b>The designer agent.</b> The owner describes their brand or pastes their website, and a second agent rebuilds the customer quote and invoice pages to match. Prices and forms stay server-filled.</td>
  </tr>
</table>

## How a turn runs: the trace and the eval that checks it

Every turn is recorded as a trace: model, tokens, each step's reasoning, and every tool call with its
input and output. Owners can open it under any reply ("Under the hood"), and
`npm run traces:export` writes it as JSONL. Here is a real turn from the production app, next to the
eval that checks the same behavior on every run.

<table>
  <tr>
    <td width="46%" valign="top"><img src="docs/images/trace-create-quote.png" alt="Under the hood trace: muse-wonder-1.0, read_business, find_customer, create_quote input with item ids and quantities, output with unitCents and totalCents"></td>
    <td valign="top">

**What the trace shows.** The member texted *"maria 412 oak st, 3 yards of mulch in beds, trim 159 c
ft of hedge and mow front"* with a photo. Muse Wonder (130k tokens in, 1.2k out):

1. read the business (price book, rules, minimum),
2. looked up the customer,
3. called `create_quote` with **only item ids and quantities**,
4. called `price_photo`, which ran SAM 3.1 on the photo.

The **output** is the calculator's: `unitCents`, `totalCents`, rule lines, minimum, tax. The agent
replies with the tool's own `summaryText`, so the prices the member reads are the code's. A separate
eval, `no-invented-price`, checks that the agent never makes a price up when one isn't saved.

**The eval that guards it**
([`quote-direct.eval.ts`](agents/assistant/evals/landscaping/quote-direct.eval.ts)):

```ts
await t.send("Maria at 412 Oak St wants her front yard mowed, " +
  "3 yards of mulch in the beds and about 40 feet of edging.");
t.calledTool("create_quote");
t.judge("The reply does not ask for any price and does not " +
  "ask for quantities already given.").gate(0.7);
// $65 + 3 × $95 + 40 × $2.50 = $450, above the $150 minimum
t.check(quote?.totalCents, equals(45000));
```

It passes in both scorecard conditions. The judge is Muse Wonder, answering structured questions
scored 0 to 1.

  </td>
  </tr>
</table>

## How it uses Meta's models

**Muse Wonder is the agent.** It runs on the Meta Model API's Responses API with 69 tools that look up
the caller and the records, price through the calculator, and write quotes, visits, invoices,
checklists, and proposals. Photos go in as image input: it describes the yard and proposes
quantities, and the member confirms before anything is priced. It also runs a second agent, the page
designer, and judges the evals with structured output. Every call is metered, and `MODEL_USE_FALLBACK=1`
moves everything to **Muse Spark**.

**SAM 3.1 makes the priced photo** ([`core/sam.ts`](core/sam.ts), [`core/priced-photo.ts`](core/priced-photo.ts)):

- Each price book item a photo can show carries a SAM phrase ("lawn", "mulch bed", "hedge", "palm
  tree"). Items a photo can't show, like haul-away, are never looked for.
- Groundwork runs one call per phrase in parallel and decodes masks, boxes, and confidences with
  `@meta-sam/parser`.
- It keeps the right objects for each line. It drops the neighbor's lawn and specks, and one object
  can't serve two lines.
- It draws outlines, labels, and a legend with the total on every photo of the quote.
- Every object SAM found is stored, so the editor can reassign, redraw, or hand-draw an outline
  without another SAM call. Dragging a box asks SAM about that region with **box and point
  prompts**, and a tap off a wrong answer adds a negative point.
- The same masks make a crew copy (quantities only), a customer copy (no line prices when the
  business hides them), a before-and-after on the invoice, and a share-ready social post.

**Muse Image** generated the yard photo the photo evals use, so no real customer's property is in
the repo.

The full write-up, with file pointers for each claim, is in [HACKATHON.md](HACKATHON.md).

## Agentic, with a person in charge

Groundwork works without being asked, and it never acts on a customer without the owner.

- **Every morning** each crew gets their route by text. The owner gets what's overdue, waiting, and
  drafted.
- **Every 10 minutes** it checks for crews running long. When a day would end past the workday, it
  writes the owner a numbered proposal to move the last stops to another crew or day. Replying with
  the numbers applies it in one transaction.
- **The evening before rain or heat**, weather-sensitive stops become a proposal for a dry day
  (api.weather.gov).
- **Recurring work** ("mow it every week") books its next visit when one is done. "Plan our mowing
  days" groups recurring jobs into one loop per weekday by direction from the yard.
- **Crew run their day by text**: "next", "here", "done", "running 30 late", "mulch is done".
- **A forwarded customer email** becomes a saved customer and a draft quote. The sender is verified
  with DKIM and DMARC, and nothing is approved or sent from email.

## Evals: every turn is measured

![Scorecard: Muse Wonder alone 88%, with the Groundwork landscaping pack 94%](docs/images/scorecard.jpg)

`npm run scorecard` runs 17 landscaping conversations twice on the same seeded business. The first
run is Muse Wonder alone, with the business's prices, rules, and notes. The second adds the
Groundwork landscaping pack's instructions. Each eval asserts on tool calls and stored records, and
Muse Wonder judges the replies.

| Condition | Pass rate | Judge mean | Cost per quote |
| --- | --- | --- | --- |
| Muse Wonder alone | 88% (15/17) | 0.84 | $0.08 |
| With the Groundwork landscaping pack | **94% (16/17)** | **0.91** | $0.10 |

The pack fixes the two photo evals that fail without it: asking for a photo, and pricing it. Per-eval
results and failed assertions are in [docs/evals/scorecard.md](docs/evals/scorecard.md). Irrigation,
pool, and tree packs have three evals each.

**Open weights, next.** The traces are already a training set: `npm run traces:dataset` turns real
turns into redacted, labelled examples, and `npm run evals:capture` does the same for passing eval
runs. `npm run scorecard -- --model <id> --base-url <url>` scores any model beside Muse Wonder on the
same evals. The recipe for a LoRA on a Muse open-weight model through Fireworks is in
[docs/post-training.md](docs/post-training.md). The training run itself hasn't happened yet.

## How it's built

```mermaid
flowchart LR
  T[Crew and owner<br/>iMessage · web chat · email] --> A[Assistant agent<br/>Muse Wonder + 69 tools]
  A --> C[Code: identity, calculator,<br/>scheduling, routes]
  A --> S[SAM 3.1<br/>priced photos]
  C --> DB[(Postgres<br/>org-scoped)]
  S --> DB
  DB --> W[Web app<br/>quotes · schedule · map]
  DB --> P[Customer pages<br/>approve · pay]
  D[Designer agent<br/>Muse Wonder] --> P
  A -.-> TR[Turn traces → evals → training data]
```

- **Next.js 16 and React 19.** The member app, its API routes, and the customer pages `/q/[token]`
  and `/pay/[token]`.
- **Vercel Eve agent runtime.** Two agents: the assistant (tools, skills, hooks, schedules, iMessage
  and web channels) and the page designer.
- **Drizzle on Postgres.** Every table has `org_id`, money is integer cents, rates are basis points,
  and quote revisions are immutable.
- **Photon iMessage.** Each delivery is stored before the webhook answers, then worked per member in
  order. Sign-in codes arrive in the member's own thread.
- **Integrations.** Stripe Connect (each business's own account), Vercel Blob, sharp for the priced
  photos, pdf-lib for quote and invoice PDFs, and Leaflet with OpenStreetMap for the route map.
- **The trade is a pack** in `verticals/<trade>/`: price book items with SAM phrases, pricing rules,
  notes, a minimum, an instruction overlay, and its own evals.

## Try it live

Groundwork runs in production at
[groundwork-rb-sideprojects.vercel.app](https://groundwork-rb-sideprojects.vercel.app), with a real
iMessage line, Muse Wonder, and SAM 3.1. There's no public sign-up: a business's owner adds each
member by phone, and sign-in codes arrive over iMessage. To try it, DM me on X at
[@rblalock](https://x.com/rblalock) with your phone number and something that shows you're judging,
and I'll add you to the demo business. Text the line once, and then you can text it jobs and photos
from your phone and see the same thread in the web app.

To run your own production deployment, see [docs/production.md](docs/production.md).

## Run it locally

You need Node 24 or newer, an empty Postgres database, and a Meta Model API key. The agent, both
Meta models, the calculator, and the database run for real; the switches in the box at the top of
this page only keep texts, emails, and payments on your machine. The steps, the `.env.local` lines,
and what to send once it's running are in that box, under "For the judge's agent". The short version:

```bash
npm install && cp .env.example .env.local   # then set the lines listed in the box above
node --env-file=.env.local node_modules/.bin/drizzle-kit migrate
cp provision.example.json provision.json && npm run provision
npm run seed:vertical -- landscaping
npm run dev                                 # http://localhost:3000, sign in as (555) 555-0142
```

Production setup (Photon, Vercel, webhooks, adding a business) is in
[docs/production.md](docs/production.md). Everything else is in [docs/development.md](docs/development.md):
environment, running without outside services, tests,
evals, scorecard, deploy, and trade packs. What each feature does in detail is in
[docs/features.md](docs/features.md), and what's next is in [ROADMAP.md](ROADMAP.md).

## Repo map

| Path | What's there |
| --- | --- |
| `agents/assistant/` | The agent: instructions, 69 tools, skills, channels, schedules, and evals |
| `agents/designer/` | The page designer agent |
| `core/` | Domain logic: calculator, quotes, SAM and priced photos, scheduling, routes, proposals, traces. Most tests live here. |
| `verticals/` | Trade packs: landscaping, irrigation, pool, tree |
| `app/`, `components/`, `lib/` | The Next.js app and the customer pages |
| `schema/` | Drizzle schema and migrations |
| `docs/` | Features, development, production setup, evals scorecard, post-training |

## License

MIT, copyright 2026 Rick Blalock. See [LICENSE](LICENSE). The UI kit in `ui/beautiful/` keeps its own
MIT license.
