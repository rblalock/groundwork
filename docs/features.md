# How each feature works

The long version of what Groundwork does, feature by feature. The [README](../README.md) has the short one.

Groundwork is a field-service agent for landscaping crews. A crew member texts a messy job
description and a few yard photos over iMessage or the web chat, and Groundwork turns it into a
priced quote PDF, a priced photo with each quoted thing outlined and labeled, a link where the
customer approves and pays a deposit, a booked visit, and an invoice. The agent runs on Muse Wonder
through Meta's Model API, and SAM 3.1 outlines the quoted lines on the yard photo. Every object SAM
finds is kept with its outline, so a member can edit the photo on the quote page without another SAM
call, and outline by hand what SAM missed, from the quote page or the Edit links on the chat's quote
card and the customer's price guide. With no word typed, a box dragged on the photo asks SAM for the
one thing in it, and a tap off a wrong answer asks again. The model judges what the member means; code checks who they are
and does the math.

When a quote has a priced photo from before the job and one of the finished work, the two make a
before-and-after: side by side, with the quote's title and total under them (the PDF leaves the
total off when the business hides line prices). The photos are plain; on the quote page, "Show
outlines" draws each one's kept masks on it. It's drawn on demand from the two photos, with no SAM
call and nothing stored, and shows on the invoice and its PDF, the quote page, and the customer's
price guide.

The same pair makes a post the business can share: the two photos cropped to match, side by side on
a square or stacked on a story, with the business's name and logo and an optional line asking for
the next job by text or email. No outlines, prices, or address. On the quote page, Share shows it
with a caption to edit: download it, copy the caption, or send both through the phone's share
sheet. In chat, "make a post" sends the image and its caption to the member's thread.

A job done before is quoted again from its last quote. "Same as last time for Maria" proposes that
quote's lines in a numbered confirm at today's prices, with what changed since: a price that went
up, an item no longer in the price book (it stays unpriced for the owner), a total set by hand last
time (not repeated). Nothing is saved until the member says yes. "Quote it again" on the customer's
price guide and on a quote's page opens the chat with the request typed in.

Work from a quote gets a checklist, one item per line: its name, quantity, and unit, marked when the
priced photo outlines it, never with a price. The crew booked get it in their booking text with the
priced photo, drawn for them with quantities only. They tick items by text ("mulch is done"), or
anyone on the team ticks them on the work's page, and the schedule shows how many are done. The tick
that finishes the list marks the work's visit done when its day has come.

Every property and the business's yard (its address) are placed on the map when saved, through the
US Census geocoder. An address that can't be placed says so on its card and is never guessed. A
drive is the straight-line distance times a road factor at a town speed (1.3 and 28 mph unless the
owner changes them, by text or in Settings), rounded up to 5 minutes. Booking holds the drive in from
the crew's stop before, or the yard, and out to the next stop, or back; when a place is missing it
holds today's default and says so. The schedule shows each visit's drive, and the crew's booking text
says how far it is. `npm run places:backfill` places addresses saved before this.

Each crew member's day is a route, worked out from their visits every time and never saved: when they
leave the yard, each stop in booked order with the drive in, and when they're back, with the minutes
driving and on site against a day capacity the owner sets (95% unless changed). When another order
would drive 10 minutes less, the route says so; nothing is moved. Crew get their route as the morning
text, the schedule's Route view lists everyone's for owners and a crew member's own for crew, and the
assistant reads the same numbers from `read_schedule`.

Asked when a job fits, the assistant offers the slots that add the least driving to a crew's day
("Wed, Oct 21, 10:15 AM with Carlos (+5 min driving)"), ahead of an empty day across town, and marks a
slot that would take the day over its capacity. A price book item can list what the work needs
("trailer", "chipper") and a member what their truck carries, by text or on the price book and Team
pages; a job is only offered to crew who carry all of it, and booking someone who doesn't needs the
owner's say.

Crew run their day by text: "next" sends the next stop with a maps link, the drive, the visit's and
the site's notes, and the checklist; "here" starts it, "done" closes it and says what's next, and
"running 30 late" re-plans the rest of the day and says what shifts. Today's route re-plans from now
as the crew go. A stop 30 minutes past its finish, or a declared delay, is running long, and when the
return runs past the workday's end plus a 15-minute grace (both settings) the Route view marks the
day at risk. Nothing moves and no customer is texted.

A day at risk becomes a proposal: the code takes the crew's last stops not yet started off the end
until the return fits, keeping any stop within the 45-minute lead time, and places each with someone
else that day who carries what it needs, else with the same crew on their next day with room. The
owners get it as a numbered text ("Move 2 stops for Carlos? 1. 4 Elm Rd → Pat today 2 PM 2. 40 Pine
Ave → Carlos tomorrow 8:15 AM. Reply the numbers to keep, 'all', or 'no'.") and as a card on the
Schedule page. Applying it re-checks every stop in one transaction, moves the ones that still hold,
and texts the crew; the customer texts come back as drafts for the owner to forward.

The weather comes from api.weather.gov for the yard, by the hour. A price book item rain or heat calls
off is weather-sensitive (the landscaping pack marks mowing, sod, mulch, edging, and cleanup). The
evening before (15 hours before the workday starts, 5 PM for an 8 AM start), tomorrow's stops doing
that work are read against the owner's limits, 60% rain and 95°F unless changed by text or in
Settings, and those at risk become one proposal for the business: each to its own crew's next dry day
with room ("Rain likely tomorrow 10 AM–2 PM (70%) over 3 lawn mowing stops. Move 3 stops to a dry
day?"), decided like any other. `read_schedule` and the Route view show the day's forecast in one line.

Recurring work ("mow it every week") repeats from its first visit: each visit marked done books the
next, same crew and time, a day later when the crew are off, with no text to anyone. "Plan our mowing
days" (or Plan route days on the Schedule page) groups the recurring work by area from the yard, one
loop for each weekday the business works, and proposes moving each job whose day changes to its new
weekday next week, decided like any other proposal; a new recurring customer is offered the weekday
their neighbors are on ("Tue, Nov 10, 10 AM with Carlos (+5 min driving; your Tue loop)").

Above the Route view's lists, a map of the day (Leaflet over OpenStreetMap tiles, no key): the yard,
each placed stop numbered in its crew member's color, a straight line per crew member from the yard and
back, the shorter order dashed when there is one, and a late or at-risk stop ringed in the warning
color. A marker opens the visit like its row; crew see only their own day, and "Hide map" keeps it out
of the way for crew who only want the list.

