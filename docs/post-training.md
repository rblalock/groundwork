# Post-training an open-weight model on Groundwork's traces

Groundwork records every assistant turn (`turn_traces`, see HACKATHON.md, "Traces"). This is the recipe
for turning those turns into a supervised fine-tuning set, training a LoRA adapter for Muse Spark
Open (Meta's open-weight model) on it, and scoring the result beside Muse Wonder and the stock model
with the same evals. The repo does the first and last parts: the dataset and the measurement.
Training runs on Fireworks' Serverless Training API and hasn't been run yet; the order of work and
the budget are in [ROADMAP.md](../ROADMAP.md).

What the model would learn is the shape of the work: which tool to call, its arguments (saved item ids,
quantities in the trade's units, rule ids), the one numbered confirm or question, and a reply that
never states a price the calculator didn't return. Pricing stays in code either way.

## 1. Export the turns

```bash
npm run traces:dataset -- --org <slug> --out dataset.jsonl                  # openai format, redacted
npm run traces:dataset -- --org <slug> --format llama --out dataset.llama.jsonl
```

Flags: `--since <ISO time>`, `--labels <a,b>` or `all`, `--history <n>` (earlier turns of the same
session carried as context, 3 by default, `0` for none), `--vertical <id>` (the pack for traces older
than the `vertical` column), and `--no-redact`. With `--out`, a sidecar `<out>.meta.jsonl` holds each
example's trace id, session, model, pack, instructions hash, and labels, line for line.

Each example is one completed turn:

- **System prompt**: `instructions.md`, the pack's overlay, and the list of skills, as the turn ran with
  them. Each trace records a hash of these (`instructions_hash`) and the pack (`vertical`) when the
  turn starts; if the hash matches today's files, the prompt is exact, else the example is marked
  `reconstructed: true` in the sidecar. Per-member additions (the glossary for Spanish speakers, the
  email inbox line) aren't rebuilt.
- **Context**: up to `--history` earlier turns of the session, each the member's message and the
  assistant's calls, results, and reply. In the openai format their assistant messages carry
  `weight: 0`, so only the turn itself is trained on.
- **The turn**: the member's message, with a placeholder per attachment (`[photo: yard-front.jpg]`);
  then per model step, the tool calls with their arguments and the results (each cut to 4 KB, except a
  skill's instructions, which are kept whole); then the reply. Reasoning is left out. A skill load is
  written as a call to `eve__skill({ name })`, as the model made it.
- **Tools**: every tool the turn had, with its description and its zod input as JSON schema
  (`scripts/agent-tools.ts`), resolved for the turn's channel (no `no_reply` on the web, no
  `start_job` in a job's thread), plus `eve__skill`.

Redaction is on by default. Customers' and contacts' names, addresses, phone numbers, and emails become
placeholders that stay the same within an example: Maria Lopez is `[customer 1]` in the member's text,
the `create_quote` arguments, the tool result, and the reply. Names and addresses are found by the keys
they sit under in tool inputs and results (a first name alone and the street line of an address count
too); phones and emails also by their shape in any text. It is a best effort: read a sample before
uploading anything.

One line in the openai format, with the system prompt and all but one tool cut for this page:

```json
{"messages":[
 {"role":"system","content":"You are the quoting assistant for one small field-service business. … Available skills\n…\n- quoting: Use before quoting, revising, or approving a job, and when a member describes work to be priced.\n…"},
 {"role":"user","content":"[customer 1] at [address 1] wants her front yard mowed, her cell is [phone 1]\n[photo: yard-front.jpg]"},
 {"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"create_quote","arguments":"{\"lines\":[{\"itemId\":\"pbi_4cf8a5971a6c4f1a\",\"quantity\":1}],\"title\":\"[address 1]\",\"customer\":{\"name\":\"[customer 1]\",\"phone\":\"[phone 1]\",\"address\":\"[address 1]\"}}"}}]},
 {"role":"tool","tool_call_id":"c1","content":"{\"state\":\"ready\",\"quoteId\":\"quo_b4315cfeb1de42e1\",\"totalCents\":4500,\"summaryText\":\"Quote for [customer 1], [address 1]: 1) Mowing, 1 yard, $45.00. Total $45.00. Reply ok to approve.\"}"},
 {"role":"assistant","content":"Quote for [customer 1], [address 1]: 1) Mowing, 1 yard, $45.00. Total $45.00. Reply ok to approve."}],
 "tools":[{"type":"function","function":{"name":"find_customer","description":"Look up saved customers by name, phone, email, contact, or property address. …","parameters":{"type":"object","properties":{"query":{"type":"string","minLength":1}},"required":["query"]}}}, …]}
```

Its sidecar line:

```json
{"traceId":"trc_b262a5013e634def","turnId":"t1","eveSessionId":"ses_demo","source":"local","modelId":"muse-wonder-1.0","vertical":"landscaping","instructionsHash":"f2f31d69c69b00cb","reconstructed":false,"labels":["quote_approved_unchanged"],"startedAt":"2026-10-30T18:08:24.965Z"}
```

The llama format is the same example as Llama 3.x chat-template text, for trainers that take rendered
text. It is not Muse Spark Open's template (see section 4), so the openai format is the one to train
Spark Open on. It is split where training starts:
`prompt` is the system header (the tools as JSON after `Environment: ipython`, then the instructions),
the earlier turns, and the member's message, up to the assistant's header; `completion` is the rest.
A tool call is its JSON, `{"name": …, "parameters": {…}}`, one per line, and a result is an `ipython`
message:

```json
{"prompt":"<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\nEnvironment: ipython\n\nYou have access to the following functions. … <|eot_id|><|start_header_id|>user<|end_header_id|>\n\n[customer 1] at [address 1] wants her front yard mowed, her cell is [phone 1]\n[photo: yard-front.jpg]<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n","completion":"{\"name\":\"create_quote\",\"parameters\":{\"lines\":[{\"itemId\":\"pbi_4cf8a5971a6c4f1a\",\"quantity\":1}],\"title\":\"[address 1]\",\"customer\":{\"name\":\"[customer 1]\",\"phone\":\"[phone 1]\",\"address\":\"[address 1]\"}}}<|eot_id|><|start_header_id|>ipython<|end_header_id|>\n\n{\"state\":\"ready\",…}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\nQuote for [customer 1], [address 1]: 1) Mowing, 1 yard, $45.00. Total $45.00. Reply ok to approve.<|eot_id|>"}
```

Anything shaped like a special token in a member's text or a tool result is broken up, so no message
can open a turn of its own.

An example is about 110 KB, roughly 28,000 tokens: about 30 KB of instructions and 70 KB of tool
schemas, the same on every line, and a few hundred tokens of the turn itself.

## 2. The filter and the labels

`labelTurn` (core/dataset.ts) keeps a turn when it completed, has the member's message, has a reply or
a tool call, and no tool returned an error. It drops a turn whose quote was voided, or revised within a
day after the turn (the owner corrected it). The rest are labelled from the records they touched:

| Label | When |
| --- | --- |
| `quote_approved_unchanged` | A quote the turn named was approved and not revised after the approval. |
| `visit_booked_clean` | The turn booked or moved a visit (`book_visit`, `reschedule_visit`), with no refusal. |
| `answered` | The turn replied without calling a tool (loading a skill doesn't count). |
| `unverified` | Kept, but nothing vouches for it yet, such as a quote still waiting on the owner. |

A turn can carry more than one. The export keeps the first three by default; `--labels all` adds
`unverified`. It prints a count per label and per reason a turn was dropped (`dropped:tool_error`,
`dropped:quote_revised`, …).

## 3. Capture from eval runs

The evals on Muse Wonder with the pack are a teacher: each eval that passes is a few turns of the agent
doing the work right on a seeded business.

```bash
npm run evals:capture -- --tag landscaping            # writes .eve/capture/<time>/
VERTICAL=landscaping npm run evals:capture -- --tag landscaping --repeat 3
```

It is `npm run evals` with `EVAL_CAPTURE_DIR` set (`.eve/capture` by default). It costs what an eval
run costs, and like every eval run it empties the database `DATABASE_URL` points at, so use the local
test database. Every eval empties that database when it seeds, so each seed first copies the last
eval's traces and the quotes they name into memory (`agents/assistant/evals/capture.ts`). When the run
ends, a reporter matches each eval to its turns (by session, or by time, since evals run one at a
time) and writes `dataset.openai.jsonl`, `dataset.llama.jsonl`, and `dataset.meta.jsonl`, whose lines
add the eval's id, verdict, and attempt. Only evals that passed are written, with every label;
`EVAL_CAPTURE_FAILED=1` keeps failed ones too.

Sizes: the 17 landscaping evals send 19 member messages, so a passing run gives at most 19 examples.
`--repeat` runs each eval again, and the model's choices vary between runs. A real set needs more than
repeats: paraphrases of each eval's messages (a list of phrasings per eval, sent in turn with
`t.send`), more seeded businesses, and other packs' evals.

## 4. Train a LoRA adapter for a Muse open model

Muse Spark Open is an 816B mixture-of-experts model (42B active per token) with a channel-based chat
template: an assistant turn addresses `self` for its reasoning, a tool by name for a call, or `user`
for the reply, and tools go in as OpenAI-style function schemas. Muse Glimmer 30B shares its tokenizer
and template. Full fine-tuning is cluster work; a LoRA adapter on Fireworks' shared Serverless
Training pool is what a set of a few hundred examples wants. The base models there are
`accounts/fireworks/models/muse-glimmer-30b` (128K context; LoRA fine-tuning free until December 1,
2026) and `accounts/fireworks/models/muse-spark-open-nvfp4` (256K context, billed per training
token); the examples here are about 30,000 tokens each. ROADMAP.md tunes Glimmer first.

The SDK is Python (`pip install "fireworks-ai[training]"`, key in `FIREWORKS_API_KEY`), and the
starting point is the cookbook's `recipes/sft_loop.py` (github.com/fw-ai/cookbook, `training/`):

- The renderer for the base model turns each openai line (messages and tools) into tokens and
  per-token loss weights: 0 on the system prompt, the member's text, and tool results, 1 on the
  model's tool calls and replies. History turns carry `weight: 0` in the export and stay at 0.
  Reasoning isn't in the examples, so the adapter learns the calls and the reply; the model still
  reasons in its own channel at inference.
- `create_lora_training_client(base_model, rank)` attaches to the pool; `forward_backward` and
  `optim_step` run the epochs; `save_weights_for_sampler(name)` saves a checkpoint (names of 17
  characters or fewer).
- Rank 8 to 16, one or two epochs, the recipe's learning rate. Check the renderer's parity test
  (`training/renderer/`) against a serverless chat completion first, so the rendered tool list matches
  what the model sees when the agent calls it.

Billing is per token on three meters; Glimmer's training meter is waived until December 1, 2026, and
at list Spark Open trains at $18.58 per million tokens, so 100 examples is about 3 million tokens and
$56 an epoch. A DPO run (`recipes/dpo_loop.py`) takes
preference pairs: for one prompt, the stock model's failing turn as `rejected` and Wonder's passing
turn as `chosen`.

## 5. Score it

The agent reaches a model over an OpenAI-compatible API. Stock Spark Open is on Fireworks' serverless
inference with tool calling, so the baseline is a scorecard condition as it stands:

```bash
npm run scorecard -- --model accounts/fireworks/models/muse-spark-open \
  --base-url https://api.fireworks.ai/inference/v1 --api-key-env FIREWORKS_API_KEY
```

A trained adapter isn't served on that pool. Promote the checkpoint to a model and put it on an
on-demand deployment, billed by the GPU-second while it is up (one GPU for Glimmer 30B), then point
the scorecard at the deployment:

```bash
firectl deployment create accounts/<account>/models/<model> --deployment-shape default \\
  --deployment-id groundwork-tuned --min-replica-count 1 --wait
npm run scorecard -- --model accounts/<account>/deployments/groundwork-tuned \\
  --base-url https://api.fireworks.ai/inference/v1 --api-key-env FIREWORKS_API_KEY
firectl deployment delete groundwork-tuned --wait
```

The stock Glimmer baseline is the same with the base model deployed. For a model too big to deploy
cheaply, sample the saved checkpoint through the training endpoint's Completions API
(`https://api.fireworks.ai/training/v1/serverless`, per token) behind a small local shim that renders
the agent's messages and tools with the model's template and parses the tool-call blocks back into
`tool_calls`, and point the scorecard at the shim (`--base-url http://localhost:8010/v1`).

Either way that adds a condition, "Groundwork (tuned <id>)", beside the baseline and the pack: the
same evals on the same seeded business, with the pack's instructions, and the agent on the tuned model
over Chat Completions. The judge stays Muse Wonder (`agents/assistant/evals/evals.config.ts` builds it
before it points the agent elsewhere). The key reaches the run but is never written to the scorecard,
which goes to `docs/evals/scorecard-tuned.md` so the committed one is left alone. Its cost uses Muse
Wonder's rates unless `MODEL_PRICES` names the tuned model's.

## What to expect

The conditions side by side: Muse Wonder with the pack, stock and tuned Glimmer 30B, stock Spark Open
(and tuned, if it ran), all with the pack, on pass rate, judge mean, completion, and cost per quote. A set of one or two hundred
distilled turns moves the evals it was built from, the ones the stock model failed, and not much else;
the write-up reports whatever the difference is. A dataset worth more needs hundreds of real turns
from working businesses, labelled by what happened after (approved, booked, not corrected), across
trades and in both languages, with the captured eval turns as the seed. Most of every example is the
same instructions and tool list; a later export could trim the tools to those the pack uses, if the
agent's tool list is trimmed the same way.
