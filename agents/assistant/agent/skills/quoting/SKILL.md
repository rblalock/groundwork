---
description: Use before quoting, revising, or approving a job, and when a member describes work to be priced.
---

# Quoting a job

The goal is a finished quote in about two exchanges: the member describes the job, you ask once for anything missing, they answer, and the quote comes back. Every number comes from the tools. You never add, multiply, or estimate a price yourself.

## The interview

1. Pull out the things to be priced, in the member's own words, with their quantities. "2 widget services and a gadget fitting, 3 hours of setup" gives three items: widget service x2, gadget fitting x1, setup x3 hours. Keep their names. Don't swap in trade terms of your own.
2. Look each item up in the pricebook from `read_business`. Match on meaning, not exact spelling: "widgets" is "widget service" if that's the only close item. Note the rules whose condition this job meets, and whether a minimum charge is saved.
3. If any price is missing, ask in one message with numbered questions, one per missing price. Propose the name and unit from their words, like "1) Widget service, per widget?" or "2) Setup, per hour?". Add a last question for the minimum charge per visit only when none is saved. Open with one short line such as "I don't have your prices yet, so tell me once and I'll remember." Ask nothing else unless the job can't be quoted without it. A quantity they didn't give is one of those: ask it in the same numbered message, proposing one from their words ("3) Screens: 28, one per window?"), never in a second round. When every price is known, quote right away, even with no minimum saved.
4. When they answer ("12, 2, 150 min"), save right away. An owner's or admin's prices go to `save_pricebook_items` in one call, and the minimum to `update_profile` as `minimumChargeCents`. If they skip a price, ask only for that. A skipped minimum is not asked again: quote without one.
5. Then quote, in the same turn as the save. Don't open a new question: a quantity you proposed and they didn't correct stands, and one you didn't ask about is the one their first message implies, which the summary shows so they can correct it.
6. Call `create_quote` with the title (the address or their phrase for the job), one line per item using the saved `itemId`, the quantities, and the ruleIds that apply. When they named the customer, `find_customer` first and pass the customerId, or, when nobody matches, `customer` with what they said. Then send `summaryText` as your reply. If you don't know the customer yet, end with one short "Who's the customer?".
7. When they name the customer, `find_customer` first, then `save_customer` with only what they said, then `revise_quote` with the customerId so the PDF carries the name.

A line you still have no price for goes in unpriced (a name and no unitCents). The quote then waits for the owner and its summary says what's missing. Never fill a gap with a guess.

Photos: describe what you see and propose counts in the same numbered message ("3) From the photos I count about 14. Is 28 right for the whole job?"). Price nothing until they confirm. Photos sent with a job attach to its quote and print on the PDF. A photo sent for a quote that already exists ("put this on the PDF") is added with `revise_quote` and just the quoteId, which makes a new revision; an approved quote then needs approving again. To leave a photo off ("take the second photo off"), find its id in `get_quote`'s attachments, which are oldest first, and pass it in `removePhotoIds`. When it isn't clear which photo they mean, ask in one line, naming them by what they show.

## Repeat quotes

When every item already has a saved price, don't ask any price questions. Create the quote straight away and send the summary, two messages at most. If one item is new, quote the rest and leave that line unpriced. The summary's last line already asks for that price, so send the summaryText as is and don't ask again. When they answer, save it and revise the quote. When no line would have a price, don't create the quote yet: ask for the prices first.

## Revisions

Each change is a `revise_quote` call that makes a new revision. Call `get_quote` first when you need the current lines, because `lines` replaces all of them.

- "make it 375" or "just call it 375": an override adjustment of 37500 with their words as the reason. Say in one line that it's a one-time price, not a pricebook change.
- "add 6 more widgets" or "add the setup, 2 hours": the full line list with the new or changed line.
- "remove the gadget fitting": the full line list without it.
- "the back is a rush job" or any new fact that changes which rules apply: pass the new ruleIds. You judge whether a rule's condition holds, and the code does the math.
- A new customer, address, or note: pass just that field.
- "put it in Spanish" or "she reads English": `customerLanguage` alone.

Whatever prints for the customer is in the quote's customer language (the customer's, unless the member chose another): write `customerNotes` in that language, even when the member told you them in another. Item names stay as saved.

After the revision, send its summaryText. A quote that was approved goes back to draft and needs approving again, so say so.

## Approval

Only an owner or admin approves, and only when they clearly say so in answer to this quote: "ok", "send it", "approved", "looks good", "sí", "se ve bien", a text that is only 👍, 👍🏽, ✅ or 👌, an SMS-style `Liked "…"` on the quote message, or a 👍 or ❤️ tapback on a message about the quote. The quoted text in a tapback identifies the message being answered, so a tapback whose quoted text is a quote's summary is answering that quote; when no context line names it, use `list_quotes` to find the quote whose title and total match and pass its quoteId. It answers this quote when the quote's summary was your last message to them, or the context names the quote as waiting on them. Call `approve_quote` with that quoteId, and the revision when the context gives one. It always needs the quoteId; find it with `list_quotes` when you only know the title. An "ok" after anything else, like a saved price, is just an acknowledgment and approves nothing. After approving, send the result's summaryText, which tells them to forward the PDF. A reminder is set automatically if nobody marks it won or lost. "Email it to Jane" or "send it to jane@example.com" calls `email_quote` instead: it approves a draft first and marks the quote sent. Pass `to` only when they typed an address; when the customer has none saved, ask for it. When `replyTo` is null, add that the business has no email for replies, which the owner can give you.

## Crew drafts

Crew can draft quotes, mark them sent, and email an approved one, nothing else. When crew describe a job, run the same interview, but a price they state is used only on that quote (unitCents on the line) and is not saved. For example, crew text "3 widget services at 15 each": the line is `{ itemId of widget service, quantity: 3, unitCents: 1500 }` (or a name and unitLabel if there is no such item), and nothing goes to the pricebook. The owner sees that price when approving. Ask crew for a price you don't have before drafting; when they don't know it, draft with that line unpriced and offer to send it to the owner, who fills it in. When the draft is ready, its summary offers to send it to the owner. When the crew member says ok or send it, call `request_owner_approval`, and tell them in one line where it stands: with the owners it `notified`, with the ones `queued` once quiet hours end, or, when both are empty, that no owner could be reached and they should tell the owner directly. The owner gets a message in their own thread, and you tell the crew member when the owner decides.
