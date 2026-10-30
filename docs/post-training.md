# Post-training an open-weight model on Groundwork's traces

Groundwork records every assistant turn (`turn_traces`, see HACKATHON.md, "Traces"). This is the recipe
for turning those turns into a supervised fine-tuning set, training a Llama 3.x 8B adapter on it, and
scoring the result beside Muse Wonder with the same evals. The repo does the first and last parts:
the dataset and the measurement. Training needs a GPU or a provider account, and hasn't been run.

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

The llama format is the same example as Llama 3.x chat-template text, split where training starts:
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

## 4. Fine-tune a Llama 3.x 8B with LoRA

These are starting points; check each provider's current flags and its format for tool calls.

**Together** (the openai format; `weight` keys may need removing if its checker refuses them, or export
with `--history 0`):

```bash
together files upload dataset.jsonl
together fine-tuning create \
  --training-file <file-id> \
  --model meta-llama/Meta-Llama-3.1-8B-Instruct-Reference \
  --lora --lora-r 16 --n-epochs 3 --learning-rate 1e-4 --suffix groundwork
```

**Fireworks** (the openai format):

```bash
firectl create dataset groundwork-turns dataset.jsonl
firectl create sftj \
  --base-model accounts/fireworks/models/llama-v3p1-8b-instruct \
  --dataset groundwork-turns --output-model groundwork-8b \
  --lora-rank 16 --epochs 3 --learning-rate 1e-4
```

**Locally with torchtune** (the llama format, one GPU with 48 GB or more at this sequence length): the
lines are already in the template, so a small dataset component tokenizes them as they are and trains
on the completion only. Check that your tokenizer turns the `<|…|>` strings into their special tokens;
if it reads them as text, encode with special tokens allowed.

```python
# groundwork_dataset.py
from datasets import load_dataset
from torch.utils.data import Dataset
from torchtune.data import CROSS_ENTROPY_IGNORE_IDX

class GroundworkTurns(Dataset):
    def __init__(self, tokenizer, path, max_seq_len=32768):
        self.rows = load_dataset("json", data_files=path, split="train")
        self.tokenizer, self.max_seq_len = tokenizer, max_seq_len

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        row = self.rows[i]
        prompt = self.tokenizer.encode(row["prompt"], add_bos=False, add_eos=False)
        completion = self.tokenizer.encode(row["completion"], add_bos=False, add_eos=False)
        tokens = (prompt + completion)[: self.max_seq_len]
        labels = ([CROSS_ENTROPY_IGNORE_IDX] * len(prompt) + completion)[: self.max_seq_len]
        return {"tokens": tokens, "labels": labels}

def groundwork_turns(tokenizer, path):
    return GroundworkTurns(tokenizer, path)
```

```yaml
# groundwork_lora.yaml, from torchtune's llama3_1/8B_lora_single_device
dataset:
  _component_: groundwork_dataset.groundwork_turns
  path: dataset.llama.jsonl
tokenizer:
  max_seq_len: 32768
model:
  lora_rank: 16
  lora_alpha: 32
epochs: 3
batch_size: 1
gradient_accumulation_steps: 8
enable_activation_checkpointing: True
```

```bash
tune run lora_finetune_single_device --config groundwork_lora.yaml
```

## 5. Serve it and score it

The agent reaches a model over an OpenAI-compatible API, so the tuned model needs one. Together and
Fireworks serve a fine-tuned adapter at `https://api.together.xyz/v1` and
`https://api.fireworks.ai/inference/v1` once it is deployed. Locally, vLLM serves the adapter and parses
the Llama JSON tool calls:

```bash
vllm serve meta-llama/Llama-3.1-8B-Instruct \
  --enable-lora --lora-modules groundwork=./output/lora \
  --enable-auto-tool-choice --tool-call-parser llama3_json --max-model-len 65536
```

Then:

```bash
TUNED_MODEL_API_KEY=<key> npm run scorecard -- --model groundwork --base-url http://localhost:8000/v1
npm run scorecard -- --model <id> --base-url <url> --api-key-env TOGETHER_API_KEY
```

That adds a condition, "Groundwork (tuned <id>)", beside the baseline and the pack: the same evals on
the same seeded business, with the pack's instructions, and the agent on the tuned model over Chat
Completions. The judge stays Muse Wonder (`agents/assistant/evals/evals.config.ts` builds it before it
points the agent elsewhere). The key reaches the run but is never written to the scorecard, which goes
to `docs/evals/scorecard-tuned.md` so the committed one is left alone. Its cost uses Muse Wonder's
rates unless `MODEL_PRICES` names the tuned model's.

## What to expect

With a few dozen captured turns, this run proves the pipeline, not a better model: an 8B adapter on 50
examples will copy the format and some of the tool choices, and likely score below Muse Wonder on the
judge. A dataset worth training needs hundreds of real turns from working businesses, labelled by what
happened after (approved, booked, not corrected), across trades and in both languages, with the
captured eval turns as a small seed. The win to look for is cost: if the tuned model holds the pass
rate on the evals that matter (the interview, no invented price, approve and schedule), it quotes for a
fraction of Muse Wonder's cost per quote.

A rough cost for a real run: 500 examples of about 28,000 tokens is 14 million tokens an epoch, 42
million over three epochs. LoRA on an 8B model is priced at roughly $0.50 per million training tokens
at Together and Fireworks, so about $20 a run; most of those tokens are the same instructions and tool
list on every line, which a later export could trim to the tools each example uses.
