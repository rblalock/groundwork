---
description: Use before booking, moving, cancelling, or finishing visits, before setting working hours or time off, and when a member asks what's on the schedule.
---

# The schedule

Work comes from a quote the customer said yes to, or is booked on its own. Each piece of work has visits: a day, a start and end time, and who goes. Everything is in the business's time zone, and the code does every date and time calculation. You pass what the member said.

## Booking

1. Find what's being booked. A quote: its quoteId from the context, `list_quotes`, or the last quote you worked on. If the customer just said yes, mark it won with `set_quote_outcome` first. More visits on work already booked: the jobId from `read_schedule` or `get_quote`'s work. New work with no quote: a title in the member's words, and the customer from `find_customer` when they name one.
2. Find who goes: memberIds from `read_business`, matched on first names. "With Carlos and Ana" is both. "Me" is the member texting.
3. Call `book_visit` with day as they said it ("tuesday", "tomorrow", "2026-11-03"), time as 24-hour HH:MM ("at 9" is 09:00, "at 2" is 14:00, "at 7:30 in the morning" is 07:30), and durationMinutes only when they gave a length ("two hours" is 120). It defaults to an hour, and the confirmation shows the end time, so they can correct it.
4. Reply with `confirmText` as it is. Don't add the crew's text, the customer, or a question.

"Pencil it in" or "tentatively" is `tentative: true`: it holds the time, and "confirm it" later is `change_visit_status` scheduled.

When the booking is refused:
- CREW_BUSY or CREW_OFF: say who has what then, in one line, and offer two or three other times from `find_availability` for the same crew and length.
- MISSING_EQUIPMENT: say who lacks what in one line and offer the crew who carry it (`find_availability` with the work and no memberIds). Book the same crew with `allowMissingEquipment` only when the owner or an admin says so ("Carlos will borrow the chipper").
- OUTSIDE_HOURS: say whose hours they are and ask if they want it booked anyway. Book with `allowOutsideHours` only after they say yes.
- VISIT_IN_PAST: ask for a time still to come.
- AMBIGUOUS_TIME: the clocks go back that night, so the time happens twice. Ask "the first or the second?", then pass the matching offsetMinutes (the first is the larger offset).
- QUOTE_NOT_AGREED: the quote isn't approved yet. Say so; an owner approves it first.

## Finding a time

"When can we fit in Oak St?" or "who's free Thursday for the mulch job?" is `find_availability` with the work (quoteId, jobId, or propertyId), and the crew only when they named one. Send two or three of its `lines` as they are: the code ranks them (slots that keep the day under capacity first, then the least driving added to the crew's day) and says the minutes. Never reorder them or add up drives yourself. A line ending "(day would be over capacity)" is still bookable; say it as it is. When it returns `missingEquipment`, the crew named don't carry what the work needs: say so in one line and offer the people in `carriedBy`.

## Moving and cancelling

`read_schedule` first, for the visitId, unless you just booked it. "Push Oak St to 2" is `reschedule_visit` with time 14:00 and nothing else. "Move it to Thursday" is day thursday. "Send Ana instead" is memberIds with Ana's id, which replaces the crew. Reply with `confirmText`. "Cancel Oak St on Tuesday" is `change_visit_status` cancelled; say in one line it's cancelled and the crew were told.

## Finishing

"Done at Oak St" from crew is `change_visit_status` completed on their visit today. When the result's openVisitsOnJob is 0, ask in one line whether the work is finished. "It's all done" or "Oak St is finished" is `close_service_job` completed. When it says VISITS_AHEAD, name them and ask whether to cancel them; pass cancelUpcomingVisits only after they say yes.

## Reading the schedule

"What's on today?" is `read_schedule` with day today. "This week" is day today with days 7. "What's Carlos doing Tuesday?" is day tuesday with his memberId. "When is Oak St?" is day today, days 42, query "Oak St". Send the visits' lines, one per line, and nothing when there are none but a short "Nothing on the schedule today." Crew only ever see their own visits. For owners, when toSchedule lists won quotes waiting for a visit, you may mention how many in one short line.

## Hours and time off

"We work 7 to 4 weekdays" from an owner is `set_work_hours` with days 1 to 5, 07:00 to 16:00, for the business. "Carlos works Saturdays 8 to noon too" is his own hours: the whole week, so read his current hours from `read_schedule`'s crew first and add the Saturday. "I'm off Friday" is `add_time_off` for the member texting; "closed on the 25th" from an owner is time off for the whole business. When HAS_VISITS refuses it, name the visits and ask the owner to move them first.
