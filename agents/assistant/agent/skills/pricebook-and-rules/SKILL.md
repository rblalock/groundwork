---
description: Use when a member states a price, a pricing rule, an exclusion, a process rule, or asks what the prices and rules are.
---

# Prices and rules

Save a price or a rule the moment a member states it, then confirm in one line ("Saved: widget service $12 each."), or react with a thumbs up when that says it all. Prices sent as a photo or file of a price list are proposed first and saved on their ok: see the `price-sheet` skill. Only owners and admins change prices and rules. A crew member's rule is saved as a suggestion for the owner, and a crew member's price is used only on their quote.

## Prices to pricebook items

Each price becomes one item for `save_pricebook_items`, or a change to a saved item with `update_pricebook_item`.

- `name`: the member's words for the work, lightly tidied ("widget service"). Never rename it into trade jargon.
- `unitKind`, from how they price it:
  - per piece, per one, each ("12 a widget") → `each`
  - per square foot → `sqft`
  - per linear foot or per foot of length → `linear_ft`
  - per hour → `hour`
  - per visit or per trip → `visit`
  - one price for the whole job → `flat`
  - anything else → `other`
- `unitLabel`: the unit in their words, singular ("widget", "hour", "visit").
- `priceCents`: integer cents. $12 is 1200 and $12.50 is 1250.
- `taxable`: leave it out unless the owner said the item isn't taxed. Then pass false.

Save several prices in one call. A name that's already saved updates its price, and the old price stays on old quotes. The minimum charge per visit is not an item: save it with `update_profile` `minimumChargeCents`. A sales tax rate is `update_profile` `taxRateBp` (7% is 700). Never ask about tax.

## Rules

A rule is what a quote's price or yes-or-no depends on. Save each with `save_rule`, using their wording as the text, and pick its kind:

- `pricing_modifier`: changes the price ("add $50 for rush jobs", "10% off for repeat customers")
- `exclusion`: what you don't do or don't quote ("we don't do weekends")
- `scope` or `process`: only when the member calls it a rule for quotes

How the business works, with no amount on it, is a business note, not a rule: "we always wipe the sills and don't charge for it", "always get a photo before quoting", warranty terms, a checklist. Save those with `save_note`, linked to nothing.

A pricing modifier gets a structured `effect` when it states an amount:

- a fixed dollar amount per job ("add $50") → `{ op: "add_fixed", amount: 5000, appliesTo: "any" }`
- dollars per unit ("$2 more per widget") → `{ op: "add_per_unit", amount: 200, appliesTo: [the matching itemIds] }`
- a percent ("10% more") → `{ op: "percent", amount: 1000, appliesTo: "any" }`, in basis points
- a discount is the same with a negative amount

Use `appliesTo: "any"` unless the rule names specific items, then list their ids. Leave `effect` out when there is no clear number ("charge more for difficult jobs"). The rule is still saved, and you ask for the amount the first time it matters on a quote. The condition stays in plain words. On each quote you decide whether it holds and pass that rule's id to the quote tool, and the code does the math.

To stop a rule, `retire_rule`. Old quotes keep it. When the owner accepts a crew suggestion, save it again with `save_rule` and retire the suggestion. When they turn it down, retire it.

## Listing them back

When asked what the prices or rules are, call `read_business` and answer in one message, prices on one line and rules on the next, like:

Widget service $12 each · Gadget fitting $2 each · Setup $40 an hour · Minimum $150
Rules: +$50 for rush jobs. Say "change" plus the item to update any of these.

Show only active rules there. Mention crew suggestions separately, if any are waiting on the owner.
