---
description: Use when a member sends a photo, screenshot, PDF, or spreadsheet of prices (a price list, rate card, old invoice or quote, competitor flyer) or of customers, a document to keep (a warranty, a permit), or any document that isn't photos of a job.
---

# Price sheets and other documents

A member can send you what they already have instead of typing it. You read it, show them what you read in their words, ask only about what you can't read or what could mean two things, and save it when they say ok. Every number comes from the document or from them. Never fill a gap with a guess, and never round or "fix" a price.

## First

1. Call `set_aside_document`, so the file never attaches to a quote or prints on a customer's PDF. Skip it for photos of a job.
2. Call `read_business` for the saved prices, rules, and minimum, so you can tell what's new and what changes.
3. Check who sent it: the context block, or `you` in `read_business`. Only the owner and admins save prices, rules, and the minimum. A crew member (role member) never gets a list to approve: see "From crew" below.

A note like "(file prices.xlsx was not read: …)" means you couldn't open that file. Say why in one line, in the member's language, and what to send instead, like a screenshot, a PDF, or a CSV. When a CSV's text says it was cut off, say how far you got.

## Reading a price list

Each priced line becomes a proposed item, as `save_pricebook_items` takes it: the name in the document's words, lightly tidied (never renamed into trade jargon), the unit from how it's priced, and the price. "Each" is not a unit label: name the thing counted, from the item ("Widget service $12 each" is unitLabel "widget"). A line with no unit gets the unit its wording suggests ("Setup $40" is flat), which the member can correct. Leave out anything that isn't a price the business charges: totals, tax lines, payment terms, a customer's name and address on an old invoice.

Some lines are rules, not items:

- a minimum charge ("$150 minimum", "minimum visit $150") → `update_profile` `minimumChargeCents`
- a charge added to every job ("trip charge $25", "$25 service fee on all jobs") → `save_rule` `pricing_modifier` with `{ op: "add_fixed", amount: 2500, appliesTo: "any" }`
- a percent up or down ("10% off for repeat customers", "15% more after hours") → `save_rule` `pricing_modifier` with `{ op: "percent", amount: -1000, appliesTo: "any" }`, the condition in their words
- work the business never does or won't quote → `save_rule` `exclusion`
- how the business works, with no amount ("sills wiped at no charge", payment or warranty terms) → a business note with `save_note`, proposed and saved on the same ok

A competitor's flyer or someone else's invoice is not the business's prices. Say what you read and ask whether they want to use those prices before proposing to save anything.

## Proposing

Send one message: a short opening line, then the items numbered, in the document's order and grouped as it groups them, each as name, price, unit. Then the rules and the minimum, numbered on. Then the questions:

- A price you can't read, or can read two ways: keep its number and ask, like "4) Doohickey polish: I can't read the price, what is it?". Never propose a price for it.
- An item that's already saved at another price: show old → new, like "2) Gadget fitting $3 → $2 each", and it changes only when they say ok. One saved at the same price: leave it out, or say "already saved" in the summary.
- A name close to a saved one ("Widget svc" and saved "Widget service"): propose it under the saved name, so it updates rather than doubles.

End with one line asking them to say ok, or to send corrections by number ("say ok, or fix any by number").

When there are more than about 15 items, don't list them all. Send the count and the groups, any price changes, the rules, and every question, then offer the full list: "I read 62 prices in 4 groups: Widgets 20, Gadgets 18, Setup 14, Other 10. 3 change a saved price: … 2 I can't read: … Say ok to save them, or 'show all' for the full list." The Price book page in the web app shows them all once saved.

## Saving

When they say ok, or answer the questions:

1. Apply their corrections and answers. Something they skipped stays out, and you say so in your reply.
2. Save every item in one `save_pricebook_items` call, with the answered prices. Save the minimum with `update_profile`, and each rule with `save_rule`.
3. Reply in one line with the counts from the tools, like "Saved 12 prices (2 updated) and the $150 minimum." Don't repeat the list.

## From crew

When a crew member sends a price list, nothing goes to the price book and you don't offer to save it. Reply in one or two lines: you can read it, but the owner or an admin adds prices, so they should send it to them. Don't list the items or ask about unreadable ones. A rule on it that the crew member asks you to keep is saved with `save_rule`, which makes it a suggestion for the owner. Prices from the sheet can still go on that crew member's own quote, as prices they stated.

## Other documents

- A customer list, or an old invoice with a customer on it: offer to save the customers. List each with only what's legible (name, phone, email, address), and when they say ok, `find_customer` first for each, then `save_customer` with only those facts. Ask about any you can't read; never guess a digit.
- Photos of a job: that's a quote, so follow the `quoting` skill instead, and don't call `set_aside_document`.
- A document to keep, like a warranty, a permit, a contract, or a site plan: when they ask you to keep it (or say what it is and it's plainly for keeping), `save_note` with `keepTextedFile` true, a short title, the customer, property, or quote it belongs to when they say or it names one you can find, and in text what they said it is plus what you read in it that they'd look for later (who, what, dates, terms), only as written. Reply in one line with what you saved and where. Crew can keep one on a customer or quote they work on.
- Anything else: say in one line what you see and what you can do with it, like quoting a job, saving prices or customers, or keeping it as a document.
