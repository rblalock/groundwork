# Landscaping eval scorecard

Generated 2026-10-27T21:03:53.343Z by `npm run scorecard`. Agent model: muse-wonder-1.0. Judge model: muse-wonder-1.0.

Every condition runs the same evals against the same seeded business (LOX Landscape Co: prices, rules, minimum, and notes). The baseline leaves out only the landscaping instructions.

| Condition | Pass rate | Judge mean | Completion | Quotes | Tokens (in / out) | Cost | Cost per quote |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline (no landscaping pack) | 85% (11/13) | 0.86 | yes | 7 | 1,195,640 / 10,605 | $1.17 | $0.1001 |
| Groundwork (landscaping pack) | 92% (12/13) | 0.98 | yes | 8 | 1,302,671 / 11,191 | $1.06 | $0.0995 |

Pass rate counts evals whose gates all held. Judge mean is the mean of every judge score. Completion is `landscaping/approve-and-schedule`: quoted, approved, and booked in three messages. Cost is estimated from token counts at list prices (core/model-pricing.ts), agent only; cost per quote divides the cost of the evals that made a quote by the quotes they made.

## Per eval

| Eval | Baseline (no landscaping pack) | Groundwork (landscaping pack) |
| --- | --- | --- |
| approve-and-schedule | pass (1.00) | pass (1.00) |
| customer-saved | pass | pass |
| haul-away-process | pass (1.00) | pass (1.00) |
| interview-quantities | failed (0.00) | pass (1.00) |
| minimum-charge | pass | pass |
| no-invented-price | pass (1.00) | pass (1.00) |
| photo-describe | pass (0.95) | pass (0.97) |
| photo-request | pass (0.92) | pass (1.00) |
| quote-direct | pass (1.00) | pass (0.96) |
| rush-rule | pass (1.00) | pass (1.00) |
| slope-rule | pass | pass |
| sod-by-sqft | failed | failed |
| vocabulary | pass (0.90) | pass (0.92) |

Each cell is the verdict and, in parentheses, the judge scores.

## Failed assertions

- Baseline (no landscaping pack), interview-quantities: judge.boolean
- Baseline (no landscaping pack), sod-by-sqft: calledTool(create_quote); sod square feet; quote total cents
- Groundwork (landscaping pack), sod-by-sqft: sod square feet; quote total cents
