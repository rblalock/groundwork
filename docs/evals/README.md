The scorecard runs the evals tagged `landscaping` (agents/assistant/evals/landscaping/) twice, with and without the landscaping instructions, on the same seeded business, and compares pass rate, judge scores, completion, tokens, and cost.
Run it with `npm run scorecard` (add `-- --spark` for a third run on Muse Spark); it needs the local eval database and writes `scorecard.md` and `scorecard.json` here.
`npm run scorecard -- --vertical irrigation` (or `pool`, `tree`) does the same for another pack's evals and writes `scorecard-<id>.md` and `.json`; those packs have no end-to-end eval, so their completion is n/a.
The numbers come from `eve eval --json`; cost is estimated from token counts at the list prices in core/model-pricing.ts.
