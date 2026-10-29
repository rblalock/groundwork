# Landscaping eval scorecard

Generated 2026-10-29T15:51:53.075Z by `npm run scorecard`. Agent model: muse-wonder-1.0. Judge model: muse-wonder-1.0.

Every condition runs the same evals against the same seeded business (LOX Landscape Co: prices, rules, minimum, and notes). The baseline leaves out only the landscaping instructions.

| Condition | Pass rate | Judge mean | Completion | Quotes | Tokens (in / out) | Cost | Cost per quote |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline (no landscaping pack) | 86% (12/14) | 0.79 | yes | 9 | 1,474,021 / 10,206 | $1.17 | $0.0979 |
| Groundwork (landscaping pack) | 100% (14/14) | 0.97 | yes | 9 | 1,598,078 / 10,897 | $1.32 | $0.1041 |

Pass rate counts evals whose gates all held. Judge mean is the mean of every judge score. Completion is `landscaping/approve-and-schedule`: quoted, approved, and booked in three messages. Cost is estimated from token counts at list prices (core/model-pricing.ts), agent only; cost per quote divides the cost of the evals that made a quote by the quotes they made.

## Per eval

| Eval | Baseline (no landscaping pack) | Groundwork (landscaping pack) |
| --- | --- | --- |
| approve-and-schedule | pass (1.00) | pass (0.99) |
| customer-saved | pass | pass |
| haul-away-process | pass (0.99) | pass (1.00) |
| interview-quantities | failed (0.15) | pass (0.98) |
| minimum-charge | pass | pass |
| no-invented-price | pass (1.00) | pass (1.00) |
| photo-describe | pass (0.98) | pass (0.98) |
| photo-request | pass (0.85) | pass (0.90) |
| priced-photo | failed (0.15) | pass (0.90) |
| quote-direct | pass (0.98) | pass (1.00) |
| rush-rule | pass (1.00) | pass (1.00) |
| slope-rule | pass | pass |
| sod-by-sqft | pass | pass |
| vocabulary | pass (0.85) | pass (0.92) |

Each cell is the verdict and, in parentheses, the judge scores.

## Failed assertions

- Baseline (no landscaping pack), interview-quantities: judge.boolean
- Baseline (no landscaping pack), priced-photo: calledTool(price_photo); judge.boolean; located lines
