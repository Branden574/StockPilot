# StockPilot site rollout roadmap

*Learn4Life · Prepared August 18, 2026 · For Superintendent Gill*

How StockPilot goes from the Central Valley West pilot to every Learn4Life site, in what order, by when, and what has to be true before each step. Every number below is taken from the live system today.

**At a glance:** CVW has been live since May 6, 2026 (15 weeks) · rollout order **CVW → KVA → CVLYII → MLA → CVS** · one region at a time, four weeks per region, each opened only after the previous one passes a measurable gate · **all five regions live by February 26, 2027** (January 29 on the fast path, if CVW settles by September 11 and MLA goes live before the winter break).

---

## Where we are today: the CVW pilot

DC4, the central distribution center, has run on StockPilot since the first week of May. In those 15 weeks:

| | Since go-live | Last 30 days |
|---|---|---|
| Items under management | 395 active (113 books), 13,869 units | |
| Order requests from sites | 85 | 32 |
| Purchase orders received | 47 | 15 |
| Stock movements recorded | 1,030 | 260 |
| Cycle counts | 16 | |
| Staff accounts | 14 across CVW, CVS, KVA and the district office | |

What is live for CVW today, on the website and the iPhone/iPad app (App Store version 1.3.0):

- Site staff request items from the DC4 catalog and follow the order through approval, picking, packing and shipment.
- Delivery requests and maintenance requests open in Outlook pre-filled, from a computer or a phone; the warehouse copy and the maintenance team's copy have been confirmed arriving.
- Purchase orders are imported by scan, received against, staged and put away to the exact rack and crate; books keep both their rack and their crate.
- Cycle counts, returns and exchanges, stock adjustments and write-offs, with a full movement history per item.
- Exports (Excel, PDF, CSV) with pictures, saved layouts, and per-site catalog visibility.
- Two-factor sign-in, role-based permissions, and an audit trail on every change.

## What "solid" means: the gate to leave CVW

The instruction is to move to KVA once the CVW release is solid. "Solid" needs a definition that can be checked rather than felt, so the same test can be applied to every region afterwards. CVW is considered solid when all of the following hold at the same time, and the target is **Friday, September 25, 2026**:

1. **Four consecutive weeks with no severity-1 defect.** A severity-1 defect is anything that loses or misstates stock, blocks an order from moving, or sends a request to the wrong place. (This week's two: a full write-off that failed when a unit sat in Staging, and blank pictures in an Excel export. Both fixed and verified in production; the clock restarts from August 18.)
2. **Orders go through the system.** At least 90 percent of CVW site orders in the trailing 30 days are placed in StockPilot rather than by email or phone. Baseline today: 32 in the last 30 days.
3. **Requests reach people.** Delivery and maintenance requests confirmed arriving (done) and used by at least three different CVW requesters.
4. **Stock is trustworthy.** Cycle-count variance at or under 2 percent of counted units on two consecutive counts, and hand-typed stock adjustments falling week over week in favour of counts. (Today hand adjustments outnumber count corrections roughly nine to one; that ratio is the single best indicator of whether the numbers on the screen match the shelf.)
5. **People are on board.** Every CVW staff member who places orders has an account, has been trained, and has signed in within the last 30 days; everyone on the phone app is on 1.3.0 or newer.
6. **Support is quiet.** Fewer than two open help requests older than seven days.

Each item is a number pulled from the system, so the weekly status can show green, amber or red against it without argument.

## The rollout playbook: four weeks per region

Each region gets the same four-week sequence. Nothing new is invented per region; the only thing that changes is who is in the room.

| Week | Step | What happens | Who |
|---|---|---|---|
| 0 | **Ready** | Accounts created for every requester and approver at the region's campuses; delivery addresses and site contacts entered; each campus mapped to its charter for billing; catalog visibility set; delivery cadence agreed with DC4; phones checked (iPhone/iPad today, Android when the Play account is live). | DC4 lead, site champion, StockPilot |
| 1 | **Train** | Two 30-minute sessions for requesters (place an order, request a delivery, report a facilities issue, track it), one 45-minute session for the site champion and approvers, printed one-page guides, and a practice space that mirrors the live system. | StockPilot with the site champion |
| 2 | **Go-live** | The region's first orders are placed for real. DC4 shadows each one end to end. A ten-minute daily check-in between the site champion and DC4 catches confusion the same day. | Site champion, DC4 |
| 3–4 | **Hypercare and exit** | Daily monitoring of orders, deliveries and defects; a written exit review against the same six criteria used for CVW, scaled to the region. The next region opens only when this review is green. | DC4 lead, StockPilot |

Roles: **DC4 lead** — Andrew Rosas; **warehouse operations** — Peter Mathis and the DC4 team; **site champion** — one named person per region, chosen by the region; **StockPilot** — Branden Vincent-Walker (training, configuration, fixes, weekly status).

## Timeline

One region at a time, because DC4 is one team and shadowing two regions' first orders at once is where mistakes come from.

| Wave | Region | Campuses (as configured today) | Dates | Notes |
|---|---|---|---|---|
| 0 | **CVW** — stabilise | Clovis, Manchester, Sunnyside, Mendota | Aug 18 – Sep 25, 2026 | Gate defined above |
| 1 | **KVA** | Hanford, Tulare | Sep 28 – Oct 23, 2026 | Closest to the CVW model; one KVA account already exists |
| 2 | **CVLYII** | Visalia | Oct 26 – Nov 20, 2026 | Single campus; ends before Thanksgiving week |
| — | MLA readiness only | Sacramento | Nov 30 – Dec 18, 2026 | Distance changes the delivery model; readiness work only, no go-live over the winter break |
| 3 | **MLA** | Sacramento | Jan 4 – Jan 29, 2027 | Go-live after the break, when staff are back and DC4 has capacity |
| 4 | **CVS** | CVS General, CVSII Madera, CVSII West Shaw, AMB Sanchez | Feb 1 – Feb 26, 2027 | Largest region; DC4 warehouse staff from CVS already use the system daily, so training weight is on site requesters |
| — | Steady state | All | From Mar 1, 2027 | Monthly status, quarterly review |

Two rules govern the dates. If a region misses its exit gate, every following region shifts by the same amount rather than overlapping. And if CVW clears its gate early, the plan moves up: **fast path** — CVW gate by September 11 puts KVA at September 14 – October 9 and CVLYII at October 12 – November 6, which leaves a choice. Either keep MLA's go-live at January 4 and spend the three weeks gained as buffer before the break (finish still February 26), or go live at MLA November 30 – December 18 with hypercare running across the break and CVS at January 4 – 29, finishing four weeks early on **January 29, 2027**. The second option asks more of DC4 in December; it is a leadership call and is not assumed.

## What each region gets on day one

- Order requests against the DC4 catalog, with approval where the region wants it, and status visible to the requester throughout.
- Delivery requests and maintenance requests that open pre-filled in Outlook, from a computer or the phone app.
- Order tracking, returns and exchanges, and a history of everything requested by that campus.
- The phone app on iPhone and iPad; Android as soon as the organization's Google Play account is in place.
- Printed pick slips, packing slips and labels at DC4 for that region's orders, and exports of anything on screen.

## Risks and how they are handled

| Risk | Handling |
|---|---|
| DC4 capacity during a wave | One region at a time; go-live weeks never overlap; hypercare check-ins are ten minutes, not meetings. |
| Android phones at a site | iPhone/iPad today. The Android build is ready and is waiting on the Google Play account, which needs the business registration paperwork. Until then Android users use the website, which does everything the app does except camera scanning. |
| Holidays and testing windows | Thanksgiving week and the winter break are kept clear of go-lives; MLA deliberately lands after the break. |
| Distance (MLA) | Sacramento is not a same-day run from DC4. December is set aside to agree the delivery cadence and whether MLA holds any stock on site before anyone is trained. |
| Stock numbers drifting from the shelf | Counts over hand adjustments; the ratio is watched weekly and is part of every exit gate. |
| A site champion leaves | Two people trained at the champion session in every region, not one. |
| Scope creep ("can our site keep its own stockroom in the system?") | The system supports it, but it is a separate decision per site with its own short plan; it does not ride inside a rollout wave. |

## Decisions needed from leadership

1. Confirm the campus list and the sequence above, and name a site champion (and a backup) for KVA now, so their accounts and training can be scheduled for the week of September 28.
2. Device policy for site staff: iPhone/iPad only for now, or push the Google Play account paperwork so Android is available by the MLA wave.
3. MLA delivery model: scheduled runs from DC4, carrier, or a small stock held on site.
4. Preferred training format and times per region (two 30-minute sessions in the first week of each wave, on site or over video).
5. Approval rules per region: who approves site orders, and above what value.

## How progress will be reported

A one-page status every Monday during a wave and monthly otherwise: orders placed and fulfilled, requester adoption, delivery and maintenance requests sent, defects open and closed, stock accuracy, and each of the six gate criteria marked green, amber or red. The same page is used for every region so they can be compared side by side.
