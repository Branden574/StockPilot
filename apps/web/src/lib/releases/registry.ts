import type { Release } from '@stockpilot/core';

/**
 * THE release registry: what the product tells people has changed.
 *
 * NEWEST FIRST, AND ORDER IS MEANINGFUL. The list is rendered as written and is
 * never re-sorted by date, so two releases on the same day keep the order chosen
 * here. Add a new release at the TOP.
 *
 * IDS ARE PERMANENT. A release id is the key of every user's read state, on web
 * and on mobile. Renaming one re-announces it to everybody, so an id is never
 * edited and never reused. Entry ids are permanent for the same reason.
 *
 * `revision` IS NOT A VERSION COUNTER. Fixing a typo does not bump it. Bump it
 * only to deliberately re-announce a release to people who already read it.
 *
 * `summary` must stand on its own: old mobile builds show only title + summary.
 *
 * Every entry with a link carries an `audience` naming the permission and the
 * module the linked page checks, so nobody is told about a page that would
 * bounce them. Pages open to every member are the listed exception in the test.
 *
 * Validated by registry.test.ts against @stockpilot/core's releaseRegistrySchema,
 * so bad content fails the build. The six oldest releases are the legacy
 * announcements, frozen to the character by
 * legacy-announcements.fixture.ts: their id, title, summary and link must not
 * change. docs/releases/PUBLISHING.md is the workflow.
 */
export const RELEASES: Release[] = [
  {
    id: 'order-page-every-item-2026-09-25',
    revision: 1,
    status: 'published',
    title: 'Every item can be found and ordered on the New order page',
    summary:
      'The New order page showed only the first 500 items in a warehouse, in alphabetical order, so items later in the alphabet, such as The Outsiders and The Hunger Games, could not be found or ordered. It now shows every orderable item.',
    publishedAt: '2026-09-25T20:15:00Z',
    entries: [
      {
        id: 'order-page-shows-every-item',
        category: 'fixed',
        area: 'Orders',
        title: 'Items missing from the New order page are back',
        whatChanged:
          'The New order page now lists every orderable item in the warehouse, and its search finds all of them.',
        whyItMatters:
          'The page loaded only the first 500 items by name. Once a warehouse held more than 500, the items after that point, such as The Distance Between Us, The Hunger Games and The Outsiders, did not appear and could not be found by searching.',
        howItAffectsYou:
          'Nothing else changes. The missing items appear in their usual category with their available stock.',
        whatToDo:
          'If an order was left unfinished because an item was missing, open New order and add it now.',
        link: { href: '/dashboard/orders/new', label: 'Open New order' },
        audience: { anyPermission: ['orders:request'], modules: ['orders'] },
      },
    ],
  },
  {
    id: 'phone-stock-adjustments-2026-09',
    revision: 1,
    status: 'published',
    title: 'Adjusting stock in the mobile app now matches the web, including offline',
    summary:
      'The +1, -1, +5, -5 and Adjust with reason buttons on an item in the mobile app now go through the same checks as the web app and appear in the audit log. A change made with no connection is saved on the phone and sent once you are back online. Sheets and dialogs in the mobile app also work properly with VoiceOver.',
    publishedAt: '2026-09-25T20:00:00Z',
    entries: [
      {
        id: 'phone-adjust-through-server',
        category: 'fixed',
        area: 'Mobile app',
        title: 'Stock adjustments on the phone use the same rules as the web',
        whatChanged:
          'The +1, -1, +5, -5 and Adjust with reason buttons on an item in the mobile app now go through the same checks as the web app, including permission to adjust stock, and each change is recorded in the audit log. A -1 on an item whose remaining units are only in Staging now works. A +1 goes onto the item\'s rack, or to Unplaced when it has none, instead of Staging.',
        whyItMatters:
          'These buttons used to change stock directly, skipping the permission check and leaving no audit record, and a -1 refused stock that was only in Staging.',
        howItAffectsYou:
          'If a change is refused, the phone says why and that nothing was changed. With no connection, the change is saved on the phone, shown as queued on the item, and sent once when you are back online; on hand updates after it is sent. Anything the server refuses is listed in Settings, Unsent work, with the reason.',
        whatToDo:
          'Update the app when it offers the new version. If Settings shows Unsent work, read the reason and enter the change again if it is still needed.',
        link: { href: '/dashboard/inventory', label: 'Open Items' },
        audience: { anyPermission: ['stock:adjust'] },
      },
      {
        id: 'phone-sheets-voiceover',
        category: 'fixed',
        area: 'Mobile app',
        title: 'Sheets and dialogs work with VoiceOver',
        whatChanged:
          'In the mobile app, the Adjust stock, note and serial sheets on an item, the Deny and Reopen picking dialogs and the signature view on an order, and the Face ID sign-in offer now let VoiceOver reach each field and button on its own, with a Close button to dismiss them.',
        whyItMatters:
          'VoiceOver read each of these as one block of text, so its fields and buttons could not be used with a screen reader.',
        howItAffectsYou: 'Nothing changes for people who do not use VoiceOver. Tapping outside a sheet still closes it.',
        whatToDo: 'No action needed.',
      },
    ],
  },
  {
    id: 'count-differences-and-recounts-2026-09',
    revision: 1,
    status: 'published',
    title: 'Exceptions list count differences, and managers can start a recount',
    summary:
      'When a posted cycle count finds a different quantity than the book, Exceptions now lists it, with both numbers and the count reference. Managers can recount those items from Exceptions or an item page, on the web and in the mobile app, and the exception clears only when a later count matches the book. Staff no longer see a Post button on counts they cannot post.',
    publishedAt: '2026-09-25T19:00:00Z',
    entries: [
      {
        id: 'count-variance-exceptions',
        category: 'new',
        area: 'Inventory',
        title: 'Count differences appear on Exceptions',
        whatChanged:
          'When a posted cycle count finds a different quantity than the book for an item, Exceptions lists it as Count did not match the book, with the counted and book quantities and the count reference, for example found +1: counted 21, book 20 (CC-000042). Only counts completed in the last 30 days open one. Rental equipment and kits are left out.',
        whyItMatters:
          'Posting a count changes the book to the counted number, and nothing followed up to confirm that number before people relied on it.',
        howItAffectsYou:
          'Differences from counts posted in the last 30 days appear on the next check. An exception clears only when a later completed count of the item matches the book exactly. A recount that finds another difference keeps it open with the new numbers.',
        whatToDo:
          'Open Exceptions and review the Count did not match the book group.',
        link: { href: '/dashboard/exceptions', label: 'Open Exceptions' },
        audience: { anyPermission: ['items:read'] },
      },
      {
        id: 'targeted-recount',
        category: 'new',
        area: 'Cycle counts',
        title: 'Start a recount from Exceptions or an item',
        whatChanged:
          'Managers can select exceptions and choose Recount selected, or use Count this item on an item page, on the web and in the mobile app. This starts a cycle count of just those items, which you can assign to someone who then gets a notification. The count page lists the exceptions it will recheck and where a difference would land.',
        whyItMatters:
          'Confirming a single item used to mean starting a count by hand and remembering which problem it was for.',
        howItAffectsYou:
          'Pressing Recount twice starts one count, and an item already in an open count is linked to that count instead of getting a second one. Rental equipment and kits cannot be recounted this way. After the count is posted, the system checks the exception again: it resolves when the count matches the book, and stays open with the new numbers when it does not.',
        whatToDo:
          'On Exceptions, choose the exceptions to confirm and start a recount, then post the count when it is done.',
        link: { href: '/dashboard/exceptions', label: 'Open Exceptions' },
        audience: { anyPermission: ['cycle_counts:assign'], modules: ['cycle_counts'] },
      },
      {
        id: 'staff-post-button',
        category: 'fixed',
        area: 'Cycle counts',
        title: 'Only people who can post a count see the Post button',
        whatChanged:
          'On a count page in the web app and on the count screen in the mobile app, the Post button (and Cancel on the web) now shows only for managers who can adjust stock. Everyone else sees A manager reviews and posts this count.',
        whyItMatters: 'Staff saw a Post button that could only fail.',
        howItAffectsYou: 'Staff still count as before. A manager reviews and posts the count.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/cycle-counts', label: 'Open Cycle counts' },
        audience: { anyPermission: ['cycle_counts:read', 'stock:adjust'], modules: ['cycle_counts'] },
      },
    ],
  },
  {
    id: 'bundles-sku-and-component-search-2026-09-25',
    revision: 1,
    status: 'published',
    title: 'Bundles: generate a SKU, and a better component search',
    summary:
      'When you create or edit a bundle in the web app, an Auto button next to SKU fills in a SKU for you, and a SKU another bundle already uses now says so. The Components search lists the closest matches first, lets you pick with the keyboard or a scanner, and says when a search fails.',
    publishedAt: '2026-09-25T17:30:00Z',
    entries: [
      {
        id: 'bundle-auto-sku',
        category: 'new',
        area: 'Bundles',
        title: 'Generate a bundle SKU with Auto',
        whatChanged:
          'On the New bundle page, and when you edit a bundle, an Auto button next to SKU fills in a SKU such as KIT-7CHLH-5ICJYWB, generated the same way as item SKUs. The SKU is still optional.',
        whyItMatters:
          'There was no way to get a bundle SKU without making one up, and a SKU another bundle already used failed with a general error.',
        howItAffectsYou:
          'Choose Auto for a new SKU, or type your own. If another bundle already uses the SKU you type, saving tells you so and suggests Auto, instead of showing "An internal error occurred".',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/bundles/new', label: 'New bundle' },
        audience: { anyPermission: ['bundles:manage'], modules: ['bundles'] },
      },
      {
        id: 'bundle-component-search',
        category: 'improved',
        area: 'Bundles',
        title: 'The Components search finds the right item first',
        whatChanged:
          'The Components search on the bundle page now searches items only, in one request, and shows up to 20 matches with the total count. An exact SKU or barcode comes first, then names and SKUs that start with what you typed. Use the arrow keys and Enter to add an item, or scan a barcode. Items already in the bundle are marked Added.',
        whyItMatters:
          'The search also looked through purchase orders, suppliers and warehouses, returned at most five items in no particular order, and could offer archived items, deleted items and kits. A search that failed looked the same as one with no matches.',
        howItAffectsYou:
          'Rental equipment, kits and archived items are not offered as components. If nothing matches, the list says so; if the search cannot reach the server, it says that and offers Try again. Pressing Enter in the search box no longer submits the bundle.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/bundles/new', label: 'New bundle' },
        audience: { anyPermission: ['bundles:manage'], modules: ['bundles'] },
      },
    ],
  },
  {
    // F1-1 (#260, 0370) and the holdings staff scope (#261, 0371) are LIVE:
    // web deployed 2026-09-25, phone half in OTA bbc7e0c8 the same day. #251
    // (crate labels) is live on web since 2026-09-24. PUBLISHED on the
    // owner's go of 2026-09-25: the production deployment that contains this
    // commit announces it. It sits ABOVE fixes-and-improvements-2026-09-25 on
    // purpose: it holds the newest changes, and the notice offers only the
    // top unread release, so its publishedAt must never be earlier than that
    // release's.
    id: 'exception-tracking-2026-09',
    revision: 1,
    status: 'published',
    title: 'Exceptions now keep a history, and are in the mobile app',
    summary:
      'Each problem on the Exceptions page now has its own number, a timeline with acknowledgements and notes, and the date it cleared. The system checks every 15 minutes and after each posted or cancelled count, and resolves an exception by itself once the problem is gone. Exceptions are also in the mobile app. Staff and viewers now see stock locations only in the warehouses they are assigned to, with stock elsewhere shown as one figure.',
    publishedAt: '2026-09-25T15:00:00Z',
    entries: [
      {
        id: 'exception-occurrences',
        category: 'improved',
        area: 'Inventory',
        title: 'Numbered exceptions with a history',
        whatChanged:
          'Each exception now has a number such as EX-000042 and a page of its own showing possible causes, what clears it, a timeline and any earlier times the same problem was found. An Open tab lists what is still wrong and a Resolved tab lists what cleared in the last 30 days. A problem that comes back opens under a new number, marked as recurred and linked to the earlier one.',
        whyItMatters:
          'Before this the page showed only what was wrong at the moment it loaded, so there was no record of when a problem was found, whether it had been looked at, or whether it keeps coming back.',
        howItAffectsYou:
          'The page shows the result of the latest check and the time it ran. Checks run every 15 minutes and after each posted or cancelled count, and managers can ask for one sooner with Check now. Problems that already existed when tracking began are marked that way. An exception cannot be marked resolved by hand: it resolves once a check no longer finds the problem.',
        whatToDo:
          'Open Exceptions and work through the Open tab. If you can adjust stock in the warehouse, acknowledge an exception you are looking into and add notes as you go.',
        link: { href: '/dashboard/exceptions', label: 'Open Exceptions' },
        audience: { anyPermission: ['items:read'] },
      },
      {
        id: 'exceptions-on-mobile',
        category: 'new',
        area: 'Inventory',
        title: 'Exceptions in the mobile app',
        whatChanged:
          'The mobile app has an Exceptions screen in the menu, with the same Open and Resolved lists, the same wording and the same detail as the web app. You can acknowledge an exception and add notes from your phone.',
        whyItMatters: 'Most of these problems are fixed at the rack, not at a desk.',
        howItAffectsYou:
          'Acknowledging and adding notes need a connection, and while offline those buttons are turned off with the reason. Offline, the screen shows the list as it was when it last loaded since you opened the app, with that time. If it has not loaded since then, it says it needs a connection.',
        whatToDo:
          'Open Exceptions from the menu in the mobile app. If it is not in the menu yet, close the app completely and open it again to load the latest update.',
        link: { href: '/dashboard/exceptions', label: 'Open Exceptions' },
        audience: { anyPermission: ['items:read'] },
      },
      {
        id: 'stock-in-other-warehouses',
        category: 'improved',
        area: 'Inventory',
        title: 'Staff and viewers see stock in their own warehouses, and the rest as one figure',
        whatChanged:
          'Staff and viewers now see rack, Staging and Unplaced holdings only in the warehouses they are assigned to. Where an item also has stock elsewhere, the item page, the Items, Books and Rentals item lists, the Transfer dialog, and the item, scan, Move stock and Remove from rack screens in the mobile app show it as one figure, such as 12 in other warehouses. Staff can transfer stock, or adjust it at a location, only in their own warehouses.',
        whyItMatters:
          'Before this, a viewer’s figures counted stock held in other warehouses, including stock waiting in Staging or Unplaced there, as placed on a rack, so the racks listed for an item did not add up to its placed figure. Staff and viewers now see their own warehouses in detail and the rest as one total, so the figures add up.',
        howItAffectsYou:
          'On hand is still the total for the whole organization. Transfer and Move stock offer only locations in your own warehouses, plus locations that belong to no warehouse, and stock going to or coming from another warehouse has to be moved by a manager. If the figure for other warehouses cannot be loaded, the screen says so instead of showing a partial total. Managers, admins and owners see and move stock in every warehouse, as before.',
        whatToDo:
          'No action needed. If you need to see or move stock in another warehouse, ask a manager, or ask an admin to change your warehouse access on the Team page.',
        link: { href: '/dashboard/inventory', label: 'Open Items' },
        audience: { anyPermission: ['items:read'] },
      },
      {
        id: 'label-check-crates-on-rack',
        category: 'fixed',
        area: 'Inventory',
        title: 'Stock in a crate on its labelled rack is no longer flagged as a label problem',
        whatChanged:
          'The Exceptions page no longer lists a “Label will not lead to the stock” problem when the label names a rack and the stock is in a crate on that rack, for example a label of 43-B · Gray #5 with the stock in Gray #5 on rack 43-B. It also accepts a rack written with spaces, such as 22 - B for 22-B.',
        whyItMatters:
          'Those labels were correct, so the page listed items that needed no attention, which made the real label problems harder to find.',
        howItAffectsYou:
          'Items are still listed when their stock is on a different rack from the label, or in a crate on a different rack. The Exceptions screen in the mobile app shows the same result.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/exceptions', label: 'Open Exceptions' },
        audience: { anyPermission: ['items:read'] },
      },
    ],
  },
  {
    // Everything user-visible merged from 2026-09-18 (after the
    // inventory-and-orders-2026-09 publish) to 2026-09-24, all live on web and,
    // for phone changes, in the OTAs published with them. F1-1 and #261 are in
    // exception-tracking-2026-09 above, and so is #248's staff transfer rule
    // (folded into stock-in-other-warehouses). Covers #208 #217 #218 #224
    // #225 #228 #229 #233 #235 #236 #238 #239 #241 #242 #244 #245 #246 #248
    // #249 #252 #253 #254 #255 #256 #257 #259. PUBLISHED with
    // exception-tracking-2026-09, on the same go; its publishedAt must never
    // be later than that release's.
    id: 'fixes-and-improvements-2026-09-25',
    revision: 1,
    status: 'published',
    title: 'Fixes to cycle counts, new items, offline work, orders and purchase orders',
    summary:
      'Changes since September 18. Cycle counts apply each correction once, measure offline counts at the time they were taken, and have references such as CC-000042. Stock added without a rack waits in Unplaced. The mobile app no longer loses work saved offline. Order approval checks the combined quantity of repeated items, reorder drafts skip items already on order, and the rental cart is kept apart from the Orders basket. What you see depends on your role and the features your organization uses.',
    publishedAt: '2026-09-25T15:00:00Z',
    entries: [
      {
        id: 'count-corrections-applied-once',
        category: 'fixed',
        area: 'Cycle counts',
        title: 'Cycle counts no longer apply a correction twice or report false differences',
        whatChanged:
          'Posting a count is now refused when another count has posted a correction for one of its items since your count recorded it, and the message names the items to clear and recount. A count entered in the mobile app while offline is now compared with the stock held when you counted, not when the phone reconnected. New counts, and the item pickers for them, leave out rental equipment and kits.',
        whyItMatters:
          'Before this, two counts that found the same difference both applied it: with 20 in the system and 22 on the shelf, the system ended at 24. Anything picked, received or moved between an offline count and its sync showed as a difference and was written into stock on posting. A rental unit out on loan could be counted as missing.',
        howItAffectsYou:
          'Overlapping counts are still allowed, and a line where the count matched the system never causes a refusal. A line that reaches StockPilot two minutes or more after it was counted shows Counted offline with the time of the count. If a selection included rental equipment or kits, the message after starting says how many items were left out. Counts that were already open keep their lines.',
        whatToDo:
          'No action needed. If a post is refused, clear the items the message names, count them again, then post.',
        link: { href: '/dashboard/cycle-counts', label: 'Open Cycle counts' },
        audience: {
          anyPermission: ['cycle_counts:read', 'stock:adjust'],
          modules: ['cycle_counts'],
        },
      },
      {
        id: 'new-item-stock-waits-in-unplaced',
        category: 'fixed',
        area: 'Inventory',
        title:
          'Stock added without a rack waits in Unplaced, and the phone asks before creating a rack',
        whatChanged:
          'When you add an item with a starting quantity but no rack, on the web or in the mobile app, its stock now goes to Unplaced in that warehouse to wait for put-away, and the primary location you chose is kept as a label. On the Items list, stock held at a site rather than on a rack reads No rack instead of the site name. In the mobile app, if the rack you type for a new item does not exist, Save asks before creating it and suggests the closest existing racks.',
        whyItMatters:
          'Stock added without a rack was recorded at the site itself, so it counted as put away, never appeared in Staging, and the Rack column showed the site name as if it were a rack. On the phone, a mistyped rack number created a new rack without asking and put all of the item’s stock on it.',
        howItAffectsYou:
          'Typing an existing rack still puts the stock straight on it, and imports and receiving against a purchase order work as before. On the phone you can go back and fix the rack, choose a suggested rack, or create the new one. The New Item form in the web app does not ask about new racks yet. Duplicating an item that is not a book now puts the copy’s stock on the rack you enter. Items added before this change can still show No rack.',
        whatToDo:
          'Check Staging for items added without a rack and put them away. If an item shows No rack on Items, select it and use Set rack.',
        link: { href: '/dashboard/inventory/staging', label: 'Open Staging' },
        audience: { anyPermission: ['items:read'] },
      },
      {
        id: 'large-item-lists-in-batches',
        category: 'fixed',
        area: 'Web and mobile apps',
        title: 'Reserved stock, exports and large counts work when a list covers hundreds of items',
        whatChanged:
          'Screens that work with many items at once no longer put every item into a single request, on the web and in the mobile app. This covers the new order page, exports and PDF reports, the Exceptions page, cycle counts, Set rack and Print labels for large selections, and the mobile app’s offline download.',
        whyItMatters:
          'When a request covered about 400 items or more, it was too long and was refused. The new order page then showed stock already reserved for other orders as available, and exports, reports, large counts and bulk actions could fail or come back incomplete.',
        howItAffectsYou:
          'Available quantities on the new order page leave out units reserved for other orders, however large the catalog. A read that fails is no longer treated as having found nothing.',
        whatToDo: 'No action needed. If an export or report failed for you before, try it again.',
      },
      {
        id: 'phone-offline-work-kept',
        category: 'fixed',
        area: 'Mobile app',
        title:
          'The mobile app keeps work saved offline and asks before signing out with unsent changes',
        whatChanged:
          'Changes the mobile app saves while offline, such as counts, stock adjustments and PO receipts, are now kept through app updates and sent under the workspace and account they were saved in, even if you switch workspace first. A count typed just before you tap Back is saved. Signing out with unsent changes now tries to send them, then lets you stay signed in, sign out and keep them on the phone, or sign out and discard them. Settings, Offline cache, Clear now clears the copy and downloads a fresh one.',
        whyItMatters:
          'A change could be lost without a message, or sent to the wrong workspace and refused there. Signing out deleted changes still waiting to be sent, and on a shared phone the next person could send the previous person’s counts under their own name. Clear said Cleared without removing anything.',
        howItAffectsYou:
          'Changes you keep at sign-out are sent the next time you sign in on that phone, and never under another account. Settings, Unsent work lists changes left by another account, with a Discard button for work whose owner is not coming back. Clearing the offline cache needs a connection and never removes unsent changes.',
        whatToDo:
          'No action needed. On a shared phone, let your changes sync before you sign out when you can.',
      },
      {
        id: 'items-list-current-stock',
        category: 'fixed',
        area: 'Inventory',
        title:
          'Items and Books refresh after more kinds of stock change, and explain an empty filtered view',
        whatChanged:
          'The Items and Books lists in the web app now refresh after stock changes they used to miss: counts posted from the phone, reopened picking, changes made with the AI assistant, and approved or cancelled PO imports. When Items is filtered to one warehouse and shows nothing, but your search matches items in your other warehouses, it now says how many match elsewhere and offers Search all warehouses.',
        whyItMatters:
          'Those changes left the lists showing earlier quantities for a while, which could send someone to a rack for stock that had already moved. The web app remembers its warehouse filter in each browser, so an item could appear on the phone and seem to be missing on the web with nothing on screen to explain why.',
        howItAffectsYou:
          'The filter works as before, and the message counts only items you are allowed to see. On the scan screen in the mobile app, an adjustment that was saved no longer reports Could not adjust.',
        whatToDo:
          'No action needed. If Items looks empty, read the message and choose Search all warehouses when you need to.',
        link: { href: '/dashboard/inventory', label: 'Open Items' },
        audience: { anyPermission: ['items:read'] },
      },
      {
        id: 'order-approval-stock-checks',
        category: 'fixed',
        area: 'Orders',
        title: 'Order approval and picking check stock more carefully',
        whatChanged:
          'When the same item is on more than one line of an order, approval now checks the combined quantity against stock, and a newly submitted order combines those lines into one. An order with no items can no longer be approved. Submitting an order now saves the order and its items together. Complete picking, on the web and in the mobile app, no longer takes units held for a rental that is out.',
        whyItMatters:
          'Two lines for the same item could each pass the stock check and together hold more than was on hand. A submit that failed partway could leave an empty order behind that managers were notified about and could approve. Picking could count units out with a borrower as available.',
        howItAffectsYou:
          'Approval is refused when the combined quantity is more than is available, as it is for a single line. Approving an order with no items asks you to add at least one first. If part of an order page cannot be loaded, the page shows an error instead of the order with its reservations missing.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { anyPermission: ['orders:request', 'orders:approve'], modules: ['orders'] },
      },
      {
        id: 'purchase-order-drafts-and-search',
        category: 'fixed',
        area: 'Purchase orders',
        title:
          'Reorder drafts skip items already on order, PO saves are all or nothing, and search finds POs again',
        whatChanged:
          'Draft PO from suggestions, on Reorder Planning and the Reorder forecast report, now leaves out items already on an open purchase order, and so do reorder drafts made by the AI assistant. Creating or editing a draft purchase order saves the supplier, totals and every line in one step, or nothing at all. The search box at the top of the web app, also opened with Command-K or Control-K, finds purchase orders by number again.',
        whyItMatters:
          'Each reorder run drafted every item below its reorder point again, including items already on order, so the same item could be ordered twice. A save that failed partway could leave an empty draft, or one whose total did not match its lines. Since May, search had returned no purchase orders.',
        howItAffectsYou:
          'Reorder Planning says how many items it skipped because they are already on order. Create draft POs on the Items list still drafts exactly the items you check, and says how many were already on an open PO. A line for a deleted item or for a kit’s pre-assembled stock is refused with the item named, and existing ones are labelled so you can remove them.',
        whatToDo:
          'No action needed. If a draft or a recurring template shows a line marked Deleted or Pre-assembled kit, remove that line.',
        link: { href: '/dashboard/purchase-orders', label: 'Open purchase orders' },
        audience: { anyPermission: ['purchase_orders:manage'], modules: ['purchase_orders'] },
      },
      {
        id: 'clear-messages-when-a-read-fails',
        category: 'fixed',
        area: 'Web and mobile apps',
        title:
          'A screen that cannot load something now says so, and an ended session goes to sign-in',
        whatChanged:
          'When a read fails for a moment, screens now say so instead of showing a wrong answer. An order that could not be loaded shows an error with Try again, not a page saying it does not exist. An item’s Movements or Activity tab says it could not load the history instead of showing none. In the mobile app, the Items, Books, Rentals and Team lists say when they could not load, instead of looking empty, and ask you to pull down to try again. If your session in a browser has ended, the next page opens sign-in with a message instead of an error page.',
        whyItMatters:
          'A brief connection problem was shown as a fact, such as a missing order, an empty history or no assigned warehouses, which could make an order look deleted or send people to an admin to fix access that was fine.',
        howItAffectsYou:
          'If you see one of these messages, nothing was changed. Reload the page, choose Try again, or pull down in the mobile app. If StockPilot cannot check your two-factor status for a moment, it asks you to reload or try again.',
        whatToDo:
          'No action needed. If the same message keeps appearing, tell us through Support and feedback.',
        link: { href: '/dashboard/support', label: 'Open Support & feedback' },
      },
      {
        id: 'rentals-list-and-cart',
        category: 'fixed',
        area: 'Rentals',
        title:
          'Every rental item is listed, and the rental cart is kept apart from the Orders basket',
        whatChanged:
          'Rentals, Items in the web app now lists every rental item, and the Rentals screen in the mobile app has an Items view with each item’s units on hand, out and available. The New rental page keeps its own cart, separate from the Orders basket, and choosing another warehouse there loads that warehouse’s rental items. Orders your team creates in the web app, and items added to an order on the web or in the mobile app, now refuse rental items. Mark returned and Cancel rental finish without an error when someone else closed the rental a moment before.',
        whyItMatters:
          'The web page looked for rentals only among the first 50 items, so some rental items were missing. Items left in the Orders basket were carried into the rental cart without being shown, which could make checkout fail, and finishing a rental emptied the Orders basket. Changing the warehouse left the first warehouse’s items on screen.',
        howItAffectsYou:
          'Renting no longer changes your Orders basket. If an item saved in a rental cart can no longer be rented there, the cart shows it with a remove button. When someone else is checking out or approving the same items at that moment, checkout says so and asks you to try again, instead of showing an error. Rental items are no longer on the Items tab in the mobile app; find them under Rentals.',
        whatToDo: 'No action needed. Open Rentals and choose Items to see your rental equipment.',
        link: { href: '/dashboard/rentals', label: 'Open Rentals' },
        audience: { anyPermission: ['rentals:read', 'rentals:create'], modules: ['rentals'] },
      },
      {
        id: 'cycle-count-references',
        category: 'improved',
        area: 'Cycle counts',
        title: 'Cycle counts have reference numbers and a searchable history',
        whatChanged:
          'Every cycle count now has a permanent reference such as CC-000042, including counts started before this change. The Cycle counts page in the web app and the Cycle counts screen in the mobile app have a search box that finds a count by its number, warehouse or notes, a filter for In progress, Completed and Canceled, and 25 counts per page. In the mobile app, Admin has a Count history link to the same list in place of Reconciliation.',
        whyItMatters:
          'The web list stopped at 200 counts and the mobile list at 50, so older counts could not be opened, and there was no short way to refer to one count. The mobile Reconciliation screen always said there were no posted counts.',
        howItAffectsYou:
          'The reference appears on the count’s page, on the count PDF, in the notification you get when a count is assigned to you, and in the activity feed. Search accepts CC-000042, CC-42 or 42. While offline, the mobile app searches only the counts already downloaded to the phone and says so.',
        whatToDo: 'No action needed. Quote the CC number when you talk about a count.',
        link: { href: '/dashboard/cycle-counts', label: 'Open Cycle counts' },
        audience: {
          anyPermission: ['cycle_counts:read', 'stock:adjust'],
          modules: ['cycle_counts'],
        },
      },
      {
        id: 'po-imports-upload-date-and-uploader',
        category: 'improved',
        area: 'Purchase orders',
        title: 'PO imports show the upload date and who uploaded each file',
        whatChanged:
          'The PO imports list in the web app now shows the date each file was uploaded, such as Sep 9, 2026, instead of a relative time such as 2 weeks ago, with the time when you hover over it. Each import also shows who uploaded it, on the list and on its own page, in the web app and in the mobile app.',
        whyItMatters:
          'A relative time is hard to match against a delivery or an invoice date, and StockPilot did not show who had uploaded a file.',
        howItAffectsYou:
          'In the web app, dates follow your organization’s time zone. The uploader is shown by name, or by email when no name is set, and someone who has left your organization is shown as Former member. In the mobile app, an imports list that fails to load now says so and asks you to pull down to try again, instead of saying No imports yet.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/purchase-orders/imports', label: 'Open PO imports' },
        audience: { anyPermission: ['purchase_orders:manage'], modules: ['po_imports'] },
      },
      {
        id: 'page-changes-without-placeholder',
        category: 'improved',
        area: 'Web app',
        title: 'Moving between pages no longer flashes a loading placeholder',
        whatChanged:
          'When you move to Overview, Items, Books, Orders, an item or an order in the web app, the page you are leaving stays in view under the progress bar until the new one is ready. A loading placeholder appears only if the new page takes longer than 400 milliseconds. On an item page, the tab you click is highlighted at once. On the new order page, the Frequently ordered row now arrives with the rest of the page instead of being fetched after it.',
        whyItMatters:
          'Pages that were ready quickly still flashed a placeholder first, and item tabs gave no sign that a click had registered, so people clicked again. Measured over 20 loads in a test organization, the median time for the first row of photos on the new order page to appear fell from 1.49 seconds to 0.69 seconds.',
        howItAffectsYou:
          'Back and Forward show the progress bar too, and with your device set to reduce motion, the bar no longer stays on screen after a page loads. StockPilot also does less background work: measured in a demonstration organization, opening the dashboard and then Items now leads to 73 to 76 database requests instead of about 200.',
        whatToDo: 'No action needed.',
      },
    ],
  },
  {
    id: 'inventory-and-orders-2026-09',
    revision: 1,
    status: 'published',
    title: 'Order from the Items list, a new Exceptions page, and sign-in email changes',
    summary:
      'You can now start an order from the Items list, and a new Exceptions page lists stock problems that need attention, such as stock left in Staging or a label that does not match where the stock is. Item pages show what is reserved and what is still available, Staging has search and filters, and order pages show their returns. You can also change your own sign-in email from your profile. What you see depends on your role and the features your organization uses.',
    publishedAt: '2026-09-18T17:00:00Z',
    entries: [
      {
        id: 'start-order-from-items',
        category: 'new',
        area: 'Inventory',
        title: 'Start an order from the Items list',
        whatChanged:
          'When you check one or more items on the Items list in the web app, the bar that appears now has a Start an order button. It opens a new order for one warehouse with the checked items already in the cart, each at a quantity of 1, for you to adjust and submit.',
        whyItMatters:
          'Before this, the only way to build an order was to open the order page and find each item again, even when you were already looking at the items you wanted.',
        howItAffectsYou:
          'An order is always for one warehouse. If your checked items span warehouses, StockPilot uses the warehouse you are filtered to, or the one holding most of your picks, and tells you how many items it left out. Items that cannot be ordered there, such as ones with no available stock, are skipped and counted in the message you see.',
        whatToDo:
          'On Items, check the items you want, choose Start an order, then set quantities and submit the order as usual.',
        link: { href: '/dashboard/inventory', label: 'Open Items' },
        audience: { anyPermission: ['orders:request'], modules: ['orders'] },
      },
      {
        id: 'exceptions-page',
        category: 'new',
        area: 'Inventory',
        title: 'An Exceptions page lists stock problems that need attention',
        whatChanged:
          'A new Exceptions page in the Inventory section of the web app lists five kinds of problem: stock held in an archived location, more units promised to open orders than are on hand, stock left in Staging for 7 days or more, stock on hand but on no rack for 30 days or more, and items whose location label names a place that does not hold their stock.',
        whyItMatters:
          'Nothing in StockPilot pointed these out before, so they could go unnoticed until someone went looking for them.',
        howItAffectsYou:
          'The page groups what it finds by kind, marks each group Critical or Warning, and says what to do about it. Each row opens the item so you can fix the cause. Nothing is stored: once the cause is fixed, the row is gone the next time the page loads. If nothing is wrong, the page says so.',
        whatToDo:
          'Open Exceptions from the sidebar and work through anything listed, starting with the Critical groups.',
        link: { href: '/dashboard/exceptions', label: 'Open Exceptions' },
        audience: { anyPermission: ['items:read'] },
      },
      {
        id: 'available-and-reserved',
        category: 'improved',
        area: 'Inventory',
        title: 'Item pages show what is reserved and what is available',
        whatChanged:
          'When some of the stock for an item is reserved for open orders, the item page in the web app now shows how many units are available and how many are reserved, under the on hand figure. If more is reserved than is on hand, it also shows how many units short the item is.',
        whyItMatters:
          'On hand alone overstates what you can promise, because part of it may already be set aside for open orders.',
        howItAffectsYou:
          'You can check what is free before promising stock to someone. Items with nothing reserved look the same as before, because the extra line only appears when something is reserved.',
        whatToDo: 'No action needed. Open an item that is on an open order to see the new line.',
        link: { href: '/dashboard/inventory', label: 'Open Items' },
        audience: { anyPermission: ['items:read'] },
      },
      {
        id: 'staging-search-filters',
        category: 'improved',
        area: 'Inventory',
        title: 'Search and filter the Staging list',
        whatChanged:
          'The Staging page in the web app now has a search box that matches item name, SKU, PO number, receipt number, barcode or ISBN, and model number. You can also filter by purchase order, by source (Staged or Unplaced), and by age (Recent, 7 days or less, or Stale, over 7 days). Clicking a PO number in a row filters the list to that PO.',
        whyItMatters:
          'A long Staging list was hard to work through when you only needed the items from one delivery, or the ones that had been waiting longest.',
        howItAffectsYou:
          'The list narrows as you type, shows how many items match, and shows each active filter as a chip you can remove. If you place stock from this page, select all and Place selected act only on the rows currently showing.',
        whatToDo:
          'No action needed. Try searching for a PO number the next time you put away a delivery.',
        link: { href: '/dashboard/inventory/staging', label: 'Open Staging' },
        audience: { anyPermission: ['items:read'] },
      },
      {
        id: 'transfer-to-unplaced',
        category: 'improved',
        area: 'Inventory',
        title: 'Move stock off a rack without writing it off',
        whatChanged:
          'The Transfer dialog on the item page now lists Unplaced as a destination, at the top of the list and marked as off the rack, stock kept. The Move stock sheet in the mobile app offers the same option. Staging is still not offered as a destination.',
        whyItMatters:
          'Before this, the only way to take stock off a rack without choosing another rack was Remove from rack, which writes the units off. Stock placed on the wrong rack by mistake could end up deducted from inventory.',
        howItAffectsYou:
          'Moving stock to Unplaced keeps it on hand, and you can put it away again later. If the move leaves an item with no stock on any rack or crate, StockPilot warns you that its crate label was left unchanged and may be wrong.',
        whatToDo:
          'No action needed. The next time stock has to come off a rack, choose Transfer and pick Unplaced instead of removing it.',
        link: { href: '/dashboard/inventory', label: 'Open Items' },
        audience: { anyPermission: ['stock:transfer'] },
      },
      {
        id: 'returns-on-order-page',
        category: 'improved',
        area: 'Orders',
        title: 'Order pages show their returns',
        whatChanged:
          'A completed order that has had a return now shows it. Each line shows the returned quantity beside the fulfilled quantity, a Returns summary gives the provided, returned and net figures, and a Returns section lists each return with its number, status, reason, returned lines and notes. The order screen in the mobile app shows the same.',
        whyItMatters:
          'Before this, an order with a return looked identical to one without, so anyone reading the order saw an incomplete record.',
        howItAffectsYou:
          'The fulfilled count on the order is unchanged: a return is shown beside it, not subtracted from it. Only returns that were received and closed count toward the net figure. A replacement handed over in person and recorded only in the return notes is not counted, so read the notes. Orders with no returns look the same as before.',
        whatToDo:
          'No action needed. Open a completed order that had a return to see the new section.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { anyPermission: ['orders:request', 'orders:approve'], modules: ['orders'] },
      },
      {
        id: 'orders-list-pdf-export',
        category: 'new',
        area: 'Orders',
        title: 'Export the orders list as a PDF',
        whatChanged:
          'The Export button on the Orders page in the web app is now a menu with two choices: CSV, as before, and PDF (print). The PDF contains the same orders and columns as the CSV for the status tab you are on, laid out on landscape Legal paper.',
        whyItMatters:
          'A CSV has to be opened and formatted in a spreadsheet before it can be printed or handed to someone. The PDF can be printed or attached as it is.',
        howItAffectsYou:
          'Both formats follow the status tab you have open, so the file matches the list on screen. If the tab has no orders, the PDF is a single page that says so.',
        whatToDo:
          'No action needed. On Orders, choose Export, then PDF (print) when you want a printable copy.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { anyPermission: ['orders:approve'], modules: ['orders'] },
      },
      {
        id: 'team-export-presets',
        category: 'new',
        area: 'Inventory',
        title: 'Share export setups with your team as presets',
        whatChanged:
          'The Export dialog on the Items list in the web app now has team presets. Choose Save as team preset to save the fields and layout options you have set up under a name. Everyone in your organization who can export items then finds it in the preset list under Team presets. A preset saved from the Books export appears in the Books export, and one saved from the Items export appears in the Items export.',
        whyItMatters:
          'Before this, a custom export could not be saved. Anyone who needed the same report again had to pick the same fields and options by hand each time.',
        howItAffectsYou:
          'Picking a team preset sets up the export in one step. A preset never widens what a person can export: an export that includes a field they are not allowed to export is still refused. A preset cannot be edited after it is saved. The person who saved it, or an admin or owner, can delete it and save a new one under the same name.',
        whatToDo:
          'On Items, choose Export, set up the export your team uses most, and choose Save as team preset. Names must be unique within your organization.',
        link: { href: '/dashboard/inventory', label: 'Open Items' },
        audience: { anyPermission: ['items:export'] },
      },
      {
        id: 'change-sign-in-email',
        category: 'new',
        area: 'Account',
        title: 'Change your own sign-in email',
        whatChanged:
          'Your profile page now has an Email section with a Change email button. Enter the new address and your current password, and a confirmation link goes to the new address while an approval link goes to your current one. If you use an authenticator app, you are asked for a code as well. The same option is in the mobile app under Settings, Email.',
        whyItMatters:
          'Before this, the email on your profile was read-only, so a new work address or a typo could not be corrected from inside StockPilot.',
        howItAffectsYou:
          'Nothing changes until both links have been opened. Until then you keep signing in with your current email, and account emails keep going to it. Once both are confirmed, you sign in with the new address and account emails go there. While a change is pending you can resend the links or cancel it from the same section.',
        whatToDo:
          'No action needed. If your email address changes, open your profile, choose Change email, and open the link that arrives at each address.',
        link: { href: '/dashboard/settings/profile', label: 'Open your profile' },
      },
    ],
  },

  // ── Legacy announcements ───────────────────────────────────────────────────
  // Moved from lib/onboarding/announcements.ts. id, title, summary and link are
  // frozen by legacy-announcements.fixture.ts; do not edit them.
  {
    id: 'maintenance-requests-2026-08',
    revision: 1,
    status: 'published',
    title: 'Maintenance requests',
    summary:
      'Report facilities and equipment issues from StockPilot. Your request is saved with a request number, and StockPilot prepares the complete Outlook email for you to review and send.',
    publishedAt: '2026-08-06T17:00:00Z',
    entries: [
      {
        id: 'maintenance-requests',
        category: 'new',
        area: 'Maintenance',
        title: 'Report facilities and equipment issues',
        whatChanged:
          'A Maintenance page lets you report a facilities or equipment issue from StockPilot. The request is saved with a request number, and StockPilot prepares the complete Outlook email for you to review and send.',
        whyItMatters:
          'You no longer have to write the email from scratch, and every request you make is kept in StockPilot under its own number so you can find it again.',
        howItAffectsYou:
          'StockPilot does not send the email for you. Outlook opens with the details filled in, and nothing goes out until you review it and press send. Replies and updates happen in that email conversation and do not appear in StockPilot.',
        whatToDo:
          'Open Maintenance, choose New maintenance request, fill in the form, then review the prepared email in Outlook and send it yourself.',
        link: { href: '/dashboard/maintenance', label: 'Report an issue' },
        audience: {
          anyPermission: [
            'maintenance_requests:submit',
            'maintenance_requests:read_all',
            'maintenance_requests:manage',
          ],
          modules: ['maintenance_requests'],
        },
      },
    ],
  },
  {
    id: 'support-feedback-2026-07',
    revision: 1,
    status: 'published',
    title: 'Support & feedback, right in the app',
    summary:
      'Hit a bug, want a feature, or have a billing question? Open Support & feedback (workspace sidebar or the life-ring in the top bar), attach a screenshot, and send it straight to the StockPilot team — then track the status of everything you’ve submitted on the same page.',
    publishedAt: '2026-07-12T17:00:00Z',
    entries: [
      {
        id: 'support-and-feedback',
        category: 'new',
        area: 'Help',
        title: 'Contact the StockPilot team from inside the app',
        whatChanged:
          'A Support & feedback page lets you report a problem, ask for a feature or raise a billing question, attach a screenshot, and send it to the StockPilot team. Open it from the workspace sidebar or the life-ring in the top bar.',
        whyItMatters:
          'You do not have to leave StockPilot or write a separate email to reach the team, and what you have sent stays listed in one place.',
        howItAffectsYou:
          'Everything you have sent is listed on the same page with its current status, so you can check progress without asking.',
        whatToDo:
          'No action needed. Open Support & feedback whenever you have a problem, an idea or a billing question.',
        link: { href: '/dashboard/support', label: 'Open Support & feedback' },
      },
    ],
  },
  {
    id: 'onboarding-tours-2026-07',
    revision: 1,
    status: 'published',
    title: 'Interactive tours + Help center',
    summary:
      'Every major page now has a “Tour” pill that walks you through what everything does, and the new Help & Learning center collects tours, step-by-step workflow guides, and shortcuts in one place.',
    publishedAt: '2026-07-11T17:00:00Z',
    entries: [
      {
        id: 'tours-and-help-center',
        category: 'new',
        area: 'Help',
        title: 'Page tours and a Help & Learning center',
        whatChanged:
          'Major pages now have a Tour button that walks you through what each part of the page does. A new Help & Learning page collects every tour, step-by-step workflow guides and keyboard shortcuts in one place.',
        whyItMatters:
          'You can learn a page while you are on it, and there is one place to go when you want to see how a whole workflow fits together.',
        howItAffectsYou:
          'A tour is offered the first time you open a page, and the Tour button stays so you can replay it whenever you like. Help & Learning shows which tours you have completed.',
        whatToDo:
          'No action needed. Choose Tour on any major page, or open Help & Learning to browse everything.',
        link: { href: '/dashboard/help', label: 'Open Help & Learning' },
      },
    ],
  },
  {
    id: 'schedule-reminders-2026-07',
    revision: 1,
    status: 'published',
    title: 'Needed-by dates now schedule themselves',
    summary:
      'Give an order a needed-by date and, on approval, a team Schedule event is created automatically — with reminders the day before and an hour ahead. You can tune reminder emails and pushes per person in notification settings.',
    publishedAt: '2026-07-10T17:00:00Z',
    entries: [
      {
        id: 'needed-by-schedule-events',
        category: 'new',
        area: 'Schedule',
        title: 'Approved orders with a needed-by date appear on the Schedule',
        whatChanged:
          'When an order that has a needed-by date is approved, StockPilot adds an event for it to the team Schedule automatically, with reminders the day before and an hour ahead.',
        whyItMatters:
          'Nobody has to copy the date into the calendar by hand after approving an order.',
        howItAffectsYou:
          'Orders with a needed-by date show up on the Schedule once they are approved. Reminders are for the events you are assigned to, and managers get them for every event. Each person chooses whether to be reminded by email, by push notification, or both.',
        whatToDo:
          'No action needed. To change how you are reminded, open Settings, then Notifications, and adjust Schedule reminders.',
        link: { href: '/dashboard/schedule', label: 'See the Schedule' },
        audience: { anyPermission: ['schedule:read', 'schedule:manage'], modules: ['schedule'] },
      },
    ],
  },
  {
    id: 'order-numbers-2026-07',
    revision: 1,
    status: 'published',
    title: 'Order numbers, everywhere',
    summary:
      'Orders now carry short per-organization numbers like SO-000045 — on the list, pick slips, packing slips, emails, and the Schedule — so everyone can reference the same order unambiguously.',
    publishedAt: '2026-07-10T17:00:00Z',
    entries: [
      {
        id: 'order-numbers',
        category: 'improved',
        area: 'Orders',
        title: 'Orders carry short order numbers',
        whatChanged:
          'Orders now carry a short number such as SO-000045, numbered separately for each organization. It appears on the orders list, pick slips, packing slips, emails and the Schedule.',
        whyItMatters:
          'A short number gives everyone the same way to refer to an order, so there is no confusion about which one is meant.',
        howItAffectsYou:
          'You can quote the number when talking to a requester, a picker or a driver, and they see the same number on their screen and paperwork.',
        whatToDo: 'No action needed. Order numbers are assigned automatically.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { anyPermission: ['orders:request', 'orders:approve'], modules: ['orders'] },
      },
    ],
  },
  {
    id: 'backorders-2026-07',
    revision: 1,
    status: 'published',
    title: 'Partial fulfillment & backorders',
    summary:
      'Short on stock? Hand over what you have — the order records fulfilled vs owed quantities and moves to Backordered until you resume fulfillment or close it. No more cancelling half-servable orders.',
    publishedAt: '2026-07-09T17:00:00Z',
    entries: [
      {
        id: 'partial-fulfillment-and-backorders',
        category: 'new',
        area: 'Orders',
        title: 'Fulfill part of an order and backorder the rest',
        whatChanged:
          'When stock is short, you can approve an order for what you have. The order records the quantity fulfilled and the quantity still owed, and moves to a Backordered status with its own tab on the Orders page.',
        whyItMatters: 'Before this, an order you could only partly fill had to be cancelled.',
        howItAffectsYou:
          'A backordered order stays open. When the owed items are back in stock you can choose Resume fulfillment, or you can close the order and keep the record of what was delivered. A closed order cannot be reopened.',
        whatToDo: 'No action needed. Check the Backordered tab on Orders for anything still owed.',
        link: { href: '/dashboard/orders?status=backordered', label: 'Backordered tab' },
        audience: {
          roles: ['owner', 'admin', 'manager'],
          anyPermission: ['orders:approve'],
          modules: ['orders'],
        },
      },
    ],
  },
];
