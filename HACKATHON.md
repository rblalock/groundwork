# Groundwork: Meta AI Developer Hackathon 2026

Indie Developer track, solo entry.

Demo video: (link)

## What Groundwork is

Groundwork is a field-service agent for landscaping crews. A crew member texts a job the way they
would say it out loud, with a yard photo, over iMessage or the web chat. The agent asks for what is
missing, builds a quote PDF priced from the business's own price book and rules, outlines each quoted
thing on the photo with SAM 3.1, and hands the customer a link to approve the quote and pay a
deposit. From there it books the visit, and when the work is done it makes the invoice and its pay
link. The agent runs on Muse Wonder through Meta's Model API.

## The demo

What a judge sees, in order. The demo business is LOX Landscape Co, its owner is Pat Ortega
(+1 555-555-0142), and the customer is Maria Alvarez.

1. **Sign in on the web.** The owner enters their phone at `/sign-in`. A 6-digit code arrives in
   their iMessage thread with the business's line (locally, `LOGIN_CODE_LOG=1` prints it to the
   server console). There is no web sign-up.
2. **Text a messy job and a yard photo.** In the web chat: "Maria Alvarez at 412 Oak St, 3 yards of
   mulch in the beds, trim 150 cubic feet of hedge, mow the front", with a photo of the front yard.
   The assistant says in a line what it sees in the photo and sends one numbered message that
   confirms the quantities, or asks for a missing one in the trade's unit (cubic yards of mulch,
   linear feet of edging, cubic feet of hedge).
3. **The quote.** After the owner confirms, the assistant calls `create_quote`. The calculator in
   `core/calculator.ts` prices every line from the saved price book and applies the saved rules: the
   rush rule for same-week work, the slope rule, a haul-away load when cleanup runs over 2 hours, and
   the business's minimum charge. The quote comes back as a card in the chat with its PDF.
4. **The priced photo.** The assistant calls `price_photo`. SAM 3.1 finds the beds, the hedge, and
   the lawn; each is outlined and labeled with its line's quantity and price, with a legend of every
   line and the total under the photo. The reply names any line it could not find in the photo.
   On the quote page, **Edit** opens the photo with every object SAM found as an outline: hover to
   see what it is, tap one to put it on a line from a picker, or drag a box and ask SAM again for
   a word of your own ("bushes"). Every change redraws the photo without another SAM call.
5. **Approve and send.** The owner says "looks good". `approve_quote` re-renders the PDF without the
   DRAFT mark and makes the customer link, `/q/<token>`, which the PDF and the summary carry. The
   owner forwards it, or says "email it to Maria" to send it through Resend.
6. **The customer link.** Maria opens the link: the quote, the priced photo, and a form to approve
   with her name. Once approved, and when the business asks for a deposit (a percentage in
   Settings), she pays it by card through Stripe Checkout on the business's connected account. The
   owner gets a text that Maria approved, the total, the deposit asked, and "Want me to book the work?"
   The business can choose to show customers each line's scope and a single total instead of line
   prices, on the link, its PDF, and the priced photo.
7. **Scheduling.** "Schedule it for next Tuesday at 8am." `book_visit` checks the crew's work
   hours, time off, and other visits, and replies with the booking and its end time. On a conflict
   the assistant offers two or three open times from `find_availability`.
8. **The invoice.** After the visit, "it's all done, invoice it". `create_invoice` copies the agreed
   quote's lines and total, moves the paid deposit onto it, and `send_invoice` sends the PDF with a
   `/pay/<token>` link for the balance. The crew texts the done photo and `price_photo` prices it
   with the job. Paired with the quote's priced photo, it makes a before-and-after, outlined from the
   same lines, on the invoice and the customer's price guide.
9. **The same thread over iMessage.** The owner texts the business's line from their phone and
   picks up where the web chat left off. A member's web chat and iMessage thread are one agent
   session, so the quote, the customer, and the context carry over. Replies to texts go out by
   iMessage; replies to web turns stay on the web.

## How it uses Meta's stack

### Muse Wonder: the agent's model

- Every model call goes through `core/model-provider.ts`, which points the AI SDK's OpenAI provider
  at the Meta Model API (`MODEL_BASE_URL`, default `https://api.meta.ai/v1`) with
  `META_MODEL_API_KEY`, and uses the Responses API. `MODEL_API=chat` switches to Chat Completions.
- The default model is `muse-wonder-1.0` (`MODEL_ID`). `MODEL_USE_FALLBACK=1` switches every call to
  `MODEL_FALLBACK_ID`, default `muse-spark-1.3`.
- The agent works by tool calling: 58 tools under `agents/assistant/agent/tools/` that look up
  the caller and the records, price through the calculator, and write quotes, visits, and invoices.
  Calls send `store: false`, so each step after a tool call carries the full history instead of
  stored-item references.
- Reasoning effort is a knob: `MODEL_REASONING_EFFORT` (`low`, `medium`, `high`; default `medium`)
  for the agent. The eval judge runs at `low`.
- The eval judge is a Muse model too (`EVAL_JUDGE_MODEL_ID`, default `muse-wonder-1.0`), answering
  the judge's questions as structured output (`agents/assistant/evals/evals.config.ts`).
- Photos sent with a job go to the model as image input; it describes the yard and proposes
  quantities, and the member confirms before anything is priced.
- Every call is metered per business, member, and channel. Costs are estimates from list prices in
  `core/model-pricing.ts` (`MODEL_PRICES` overrides them), and per-business limits cap turns and
  output tokens per hour.
- `npm run smoke:model` checks text, a tool call and its second step, structured output, and the
  fallback model against the live API.

### SAM 3.1: the priced photo

- `core/sam.ts` sends one noun phrase and one image per call to `sam-3.1` on the Responses API,
  streamed, and decodes the masks, boxes, and confidences with `@meta-sam/parser`. Several phrases in
  one call do not work, so `segmentMany` runs one call per phrase in parallel.
- The phrases come from the trade pack: each price book item a photo can show has a `photoPrompt`
  ("lawn", "mulch bed", "hedge", "palm tree", "shrub", "sprinkler head"). Items a photo can't show
  (cleanup hours, haul-away) are not looked for.
- `core/priced-photo-select.ts` picks which objects each quote line keeps: it drops objects under
  0.5% of the image, under 10% of the largest object for that phrase (the neighbor's lawn), or under
  0.6 confidence. A per-piece line keeps up to its quantity of the largest objects; any other line
  keeps the largest two.
- `core/priced-photo.ts` draws the kept masks as filled outlines with sharp, labels each line once
  with its quantity and price, and adds a legend of every line, located or not, and the total. The
  PNG shows on the quote card in chat, the quote page, the customer link, and the customer's price
  guide. Making it again replaces the one for that photo.
- What it does not do: measure anything. No square footage, cubic yards, or counts come from pixels.
  Quantities and prices come from the quote the member confirmed; the photo shows where each line is.
- `npm run sam:probe -- <image> "<phrase>" ...` prints each call's latency, objects, boxes, mask
  areas, and confidences, and writes overlays to `/tmp/sam-probe/`. A recorded stream in
  `test-fixtures/sam/` lets the tests decode real SAM output offline.

### Muse Image: eval fixtures

`agents/assistant/evals/fixtures/generate-yard-photo.ts` asks `muse-image-1.0` for a Florida front
yard (lawn, two mulched beds with hedges, a palm, a driveway) and saves it as `yard-front.jpg`. The
photo evals and the priced photo eval send that image, so they run on a known yard with no real
customer's property in the repo.

## Evals and the scorecard

The assistant's evals are conversations in `agents/assistant/evals/`, run with `eve eval` against
a local agent and a seeded database. Each eval asserts on tool calls and records (a quote exists, its
total in cents is right) and asks the judge questions scored 0 to 1, some with a gate. The landscaping set
in `agents/assistant/evals/landscaping/` covers quantity interviews, trade vocabulary, the rush,
slope, and haul-away rules, the minimum charge, never inventing a price, photo requests and
descriptions, sod by the square foot, the priced photo, and quote-approve-book in three messages.

```bash
npm run evals                         # every eval, no trade pack
VERTICAL=landscaping npm run evals    # every eval, with the landscaping instructions
npm run scorecard                     # the landscaping set, baseline and pack
npm run scorecard -- --spark          # and a third run on Muse Spark
```

The scorecard runs the landscaping set twice on the same seeded business, with the same prices,
rules, minimum, and notes. The baseline (`VERTICAL=none`) leaves out only the landscaping
instruction overlay; the pack run (`VERTICAL=landscaping`) adds it. It reports pass rate, judge mean,
end-to-end completion, quotes made, tokens, estimated cost, and cost per quote, per condition and per
eval, in [docs/evals/scorecard.md](docs/evals/scorecard.md) and `scorecard.json`.

Latest run (Muse Wonder as agent and judge): baseline 85% pass (11/13), judge mean 0.86; pack 92%
pass (12/13), judge mean 0.98. The scorecard file holds the current numbers and the failed
assertions.

## Traces

- Every assistant turn is recorded as one `turn_traces` row (`core/turn-traces.ts`), appended to as
  eve's stream events arrive: the business, conversation, member, channel (web, text, email, job),
  model id, status, start and finish times, summed token counts, and the steps. Steps are model step
  starts and ends with finish reasons and usage, tool calls with their inputs, tool results with
  their outputs and error flags, reasoning text, and messages. Each value is capped at 32 KB and
  marked when cut. Traces are kept 180 days.
- In the web chat, "Under the hood" under each reply opens to the turn's model and tokens, then each
  step's reasoning and tool calls with inputs and outputs. It is shown only to someone who can read
  that conversation.
- `npm run traces:export -- --org <slug> [--since <ISO time>] [--redact] [--out <path>]` writes one
  business's traces as JSONL, one turn per line, oldest first. `--redact` blanks values under phone,
  email, and address keys, and phone numbers and emails in any text.
- Why it exists: each line is a real turn on real work (the tool calls the model chose with their
  arguments, what the tools returned, its reasoning, and its reply), which is the start of a dataset
  for fine-tuning an open-weight model on this work later, measured with the same scorecard. See
  [ROADMAP.md](ROADMAP.md).

## Architecture

1. Next.js 16 App Router and React 19: the member app, its API routes, and the customer pages
   `/q/[token]` (quote) and `/pay/[token]` (invoice).
2. Vercel Eve agent runtime: the assistant (instructions, tools, skills, hooks, schedules, channels)
   mounted at `/eve/assistant/v1`.
3. Drizzle ORM on Postgres: one database for every business.
4. Better Auth: organizations, and phone-code sign-in with the code posted in iMessage.
5. Photon iMessage: each delivery is stored in Postgres before Photon gets its 200, then worked per
   member in order.
6. Vercel Blob for photos, priced photos, and PDFs. Stripe Connect: each business connects its own
   account for deposits and invoice payments.
7. The model judges intent; code checks identity and does the math. Tools look up the caller and the
   records, and the calculator prices every line. The model never computes a price or a total.
8. Money is integer cents; rates and percentages in rules are integer basis points.
9. Every table has `org_id` and every query is scoped by it.
10. Quote revisions are immutable: a change makes a new revision.

The trade lives in a pack under `verticals/landscaping/`: price book items with photo prompts,
pricing rules, business notes, a minimum charge, and an instruction overlay added each turn while
`VERTICAL=landscaping`. `npm run seed:vertical -- landscaping` loads it into a business.

## Running it yourself

See [README.md](README.md) for setup, the fake modes that keep local work off real phones, inboxes,
and cards, tests, evals, and deploy.

## License

MIT, copyright 2026 Rick Blalock. See [LICENSE](LICENSE). The UI kit in `ui/beautiful/` keeps its own
MIT license.
