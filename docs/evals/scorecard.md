# Landscaping eval scorecard

Generated 2026-10-30T17:53:15.340Z by `npm run scorecard`. Agent model: muse-wonder-1.0. Judge model: muse-wonder-1.0.

Every condition runs the same evals against the same seeded business (LOX Landscape Co: prices, rules, minimum, and notes). The baseline leaves out only the landscaping instructions.

| Condition | Pass rate | Judge mean | Completion | Quotes | Tokens (in / out) | Cost | Cost per quote |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline (no landscaping pack) | 88% (15/17) | 0.84 | yes | 10 | 2,009,986 / 10,462 | $1.22 | $0.0815 |
| Groundwork (landscaping pack) | 94% (16/17) | 0.91 | yes | 10 | 2,026,402 / 11,768 | $1.38 | $0.0972 |

Pass rate counts evals whose gates all held. Judge mean is the mean of every judge score. Completion is `landscaping/approve-and-schedule`: quoted, approved, and booked in three messages. Cost is estimated from token counts at list prices (core/model-pricing.ts), agent only; cost per quote divides the cost of the evals that made a quote by the quotes they made.

## Per eval

| Eval | Baseline (no landscaping pack) | Groundwork (landscaping pack) |
| --- | --- | --- |
| approve-and-schedule | pass (1.00) | pass (1.00) |
| crew-checklist | pass (0.97) | pass (1.00) |
| customer-saved | pass | pass |
| haul-away-process | pass (1.00) | pass (1.00) |
| interview-quantities | pass (1.00) | pass (0.97) |
| minimum-charge | pass | pass |
| no-invented-price | pass (1.00) | pass (1.00) |
| photo-describe | pass (0.98) | pass (0.95) |
| photo-request | failed (0.00) | pass (0.93) |
| priced-photo | failed (0.08) | pass (0.92) |
| quote-direct | pass (1.00) | pass (1.00) |
| repeat-quote | pass (0.96) | pass (1.00) |
| rush-rule | pass (1.00) | pass (1.00) |
| slope-rule | pass | pass |
| social-post | pass (0.95) | failed (0.15) |
| sod-by-sqft | pass | pass |
| vocabulary | pass (0.95) | pass (0.90) |

Each cell is the verdict and, in parentheses, the judge scores.

## Failed assertions

- Baseline (no landscaping pack), photo-request: judge.boolean
- Baseline (no landscaping pack), priced-photo: calledTool(price_photo); judge.boolean; located lines
- Groundwork (landscaping pack), social-post: judge.boolean
