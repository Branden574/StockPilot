# StockPilot progress update — warehouse and inventory

*Learn4Life · Prepared August 17, 2026 · Covers August 11–17*

A plain-language summary of what DC4 staff and site requesters can now do that they could not a week ago, and what is coming next.

**At a glance:** StockPilot **1.3.0** is live on the App Store today · **50+** improvements shipped and verified this week, web and mobile · **0** open security findings after this week's audit sweep.

---

## Send a delivery request from a phone (live)

*For anyone who submits an order and needs DC4 to deliver it*

Until now, requesting a delivery meant going to a computer. Staff can now open an order on their phone and tap once to raise the delivery request. The message arrives already filled in — the destination site and address, the date it is needed, and the item list — and it opens in the Outlook app for the requester to review and send.

The warehouse copy goes to the DC4 intake and Andrew is copied automatically, exactly as it works from the website. We confirmed this end to end on real phones: the message opens, the copy arrives, and the ticket is created.

> **To try it** — open any delivery order you submitted, in the StockPilot app, and look for the Delivery Request section.

## Maintenance requests: photos any time, and the real Outlook app (live)

*For anyone reporting a facilities problem*

Two gaps closed. First, staff could only attach photos while filing a maintenance request; once it was filed, there was no way to add the photo they took five minutes later. Photos can now be added to an existing request from the phone at any point.

Second, tapping "Open in Outlook" on a phone used to open a browser tab. It now opens the actual Outlook app, with the ticket email pre-filled and the maintenance team's address and copy recipient already in place. Confirmed working on real devices — the maintenance team received the ticket.

## Long orders no longer lose their item list (live)

*For anyone requesting delivery of a larger order*

A staff member with an eleven-item order found the delivery email listed none of the items — the message had grown too long for the email link, and the system dropped every line rather than some. It now fits as many item rows as the email allows and says plainly how many are listed out of the total, so the warehouse always sees the items and knows when to check the full order.

On the phone this goes further: because the Outlook app allows a longer message than the web version, phone-sent requests carry more items — on a 25-item order, sixteen lines instead of seven.

## Book shelving is recorded the way the floor actually works (live)

*For DC4 staff placing and finding books*

A book crate sits on a rack — a "gray bin" on rack 43-B is not the same bin as the "gray bin" on rack 42-C. The system had been treating a rack and a crate as either/or, so placing a book into a crate could quietly erase its rack, and two identically named crates on different racks could be merged. That is corrected: a book records both its rack and its crate, moving a book asks for confirmation before it changes either label, and if the system cannot ask, it keeps the old label rather than wiping it. A stale label can be corrected; a wiped one cannot.

Related: when adding a new item to a rack, staff are now told if the stock could not actually be placed there, instead of the item silently saving with a label pointing at an empty shelf.

## Smaller fixes staff will notice (live)

- Lists inside phone pop-ups (adding items to an order, choosing a filter, moving stock) can now be scrolled straight away; previously they would not scroll until something else was tapped.
- Purchase order scans can be named before extraction, so imports stop being labelled "image.jpg", and books are now first-class, searchable line items on purchase orders.
- Photos on maintenance requests and items open full-screen with a tap.
- The order list can be exported as a PDF alongside the existing spreadsheet, and export layouts can now be saved and shared across the team.
- Delivery-request text can be copied with one tap on the phone when email is not an option.

## Behind the scenes (live)

Two items that are invisible day to day but worth knowing about.

**A security audit sweep** ran across the platform this week: access tokens are now stored only in protected form, staff who have enrolled in two-factor sign-in are held to it everywhere, and stock operations refuse to overdraw. Automated dependency scanning reports zero open findings.

**Email routing is now per-organization.** The warehouse and maintenance addresses that requests go to are configured for Learn4Life specifically rather than built into the software. Learn4Life's addresses are unchanged; this is groundwork that keeps other organizations' requests from ever reaching DC4's inbox by mistake.

## Coming next (in progress)

- **Returns shown on the order.** When an item is returned or swapped — a size S polo exchanged for a medium, for example — the original order page will show it, rather than only the separate returns record. Being built now.
- **Exchanges as a first-class step.** Today a swap is recorded as a return plus a note. A proper exchange, where the replacement appears on the order itself, is being designed and will come to you for a look before it is built.
- **Android.** The phone features above are on iPhone and iPad today. Android is ready to build and is waiting on the organization's Google Play account, which needs the business registration paperwork to complete.

## How we make sure it works

Every change this week went through automated testing on the code, an independent adversarial review that tries to break it before it ships, and, for anything staff touch on a phone, a check on real devices — including confirming that the delivery and maintenance emails actually arrive where they should, not just that a screen appeared. A new automated nightly check now exercises the phone app the way a person would, catching the class of problem that only shows up on a device.

---

*Prepared by Branden Vincent-Walker for the Learn4Life leadership team. Questions or requests for a walkthrough are welcome.*
