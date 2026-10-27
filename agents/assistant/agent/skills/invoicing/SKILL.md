---
description: Use before making, sending, changing, or voiding an invoice, putting photos of the work on one, recording or removing a payment, or answering who owes money and what's overdue.
---

# Invoices and payments

An invoice bills a customer for work. It's a draft until it's sent; sending dates it today, sets its due date from the business's payment terms (0 days is due on receipt), and freezes its lines. Payments bring its balance down: partly paid, then paid. Everything here is for the owner and admins. The code computes every amount; you pass what the member said.

## Making one

1. Find what's being billed. Finished work: the serviceJobId from `close_service_job`, `read_schedule`, or `list_invoices`' readyToInvoice. A quote ("invoice the Oak St quote", "the Oak St job is done, invoice it"): its quoteId from `list_quotes`; its work is found from it. The quote must be agreed (approved, sent, or won).
2. Call `create_invoice` with that id. Pass no lines: the agreed quote's lines, extras, tax, and total are copied, so the invoice's total is the quote's. With send true it goes out now; leave send out when they only asked for a draft.
3. Work with no quote, or "invoice Jane $300 for the cleanup": ask what to bill if they didn't say, then pass lines with the prices they stated (one line with quantity 1 for a flat amount) and the customer from `find_customer`.
4. Reply with `summaryText`. When it was sent, add that the PDF is above to forward.

`created: false` means it already had an invoice; say which, from summaryText.

## Changing and sending

A draft changes with `update_invoice_lines` (the full list of lines). A sent invoice is frozen: if it's wrong and has no payments, `void_invoice` it and make a new one. "Send it" or "resend it" is `send_invoice`; a resend goes as it stands, with what's been paid and the balance.

## Photos of the work

Photos of the work don't go on an invoice unless the member asks. "Put the after photos on the invoice" or "add the photos to INV-0003": `get_invoice` lists its work's photos (`workPhotos`, oldest first, with what they were sent with), then `set_invoice_photos` with the ones they mean, all of them when they don't say which (up to 8). "Leave the photos off" is `set_invoice_photos` with []. They print after the invoice, on any invoice but a void one; one already sent goes out with them when it's sent again, so offer to resend it.

## Payments

"Jane paid $150 cash" is `record_payment` with customer "Jane", amountCents 15000, method cash. A check is check (its number as reference); a card they ran themselves is card. If it comes back with candidates, ask which invoice, naming them. OVERPAYMENT: say the balance and ask them to check. INVOICE_PAID: say it's already paid. Reply with paymentText and the balance.

"That was 150, not 200": `get_invoice` for the payment's id, `remove_payment`, then `record_payment` with the right amount.

## Who owes what

"Who owes me?" is `list_invoices` with no status; "what's overdue?" is status overdue; "what's left to invoice?" is its readyToInvoice. Send `owedText` as it is, one customer per line.

## Never

Never text or email a customer about money, and never promise a customer was told. Never compute or round an amount yourself. Never record a payment the member didn't state.
