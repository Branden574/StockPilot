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
 * so bad content fails the build. The six releases below the first one are the
 * legacy announcements, frozen to the character by
 * legacy-announcements.fixture.ts: their id, title, summary and link must not
 * change. docs/releases/PUBLISHING.md is the workflow.
 */
export const RELEASES: Release[] = [
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
