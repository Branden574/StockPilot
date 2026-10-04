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
    id: 'order-submit-once-2026-10',
    revision: 1,
    // Phone ordering PO-2 (migration 0391: one create path, place_order_request
    // and order_submissions). Held as a DRAFT until 0391 is pushed and
    // verified, the web deploy is READY and the production smoke test that
    // writes nothing has passed (phone-orders plan 10.1 step 8); the
    // follow-up that publishes it (plan PO-5) sets the real publishedAt and
    // re-reads these words against what shipped. A draft sits above the
    // newest published release: slice D's release and slice B's two are
    // published below it, and it is dated after them; the publishing
    // follow-up keeps the order newest first.
    //
    // What a person can see, on the web only (the phone storefront is PO-4,
    // with its own entry): the New order page's lost-answer panel (Check and
    // finish, Don't send it, See my orders) and the locked cart; refusals said
    // in place, naming the items from the cart; the needed-by read in the
    // organization's zone with the zone named; the corrected labels. The
    // words claim no number nobody measured and no detail of how the check
    // works. Who is told: anyone who can open the New order page (Orders on,
    // orders:request, which every role holds by default).
    status: 'draft',
    title: 'Submitting an order request twice no longer places two orders',
    summary:
      "If the New order page sends your order request but doesn't hear back, it now keeps your cart as it was and lets you check and finish, or choose not to send it, so the order is never placed twice. Refusals say what to fix, and the needed-by time is read in your organization's time zone.",
    publishedAt: '2026-10-11T17:10:00Z',
    audience: { anyPermission: ['orders:request'], modules: ['orders'] },
    entries: [
      {
        id: 'order-submit-once',
        category: 'fixed',
        area: 'Orders',
        title: "A lost answer can't place the same order twice",
        whatChanged:
          "If the New order page sends your order request and doesn't hear back (a slow connection, a closed tab), the review stays open with three choices: Check and finish, Don't send it and See my orders. Check and finish sends the same request again: if it was placed, you see it; if not, it is placed now, once. Don't send it makes sure it is never placed and unlocks your cart.",
        whyItMatters:
          'Pressing Submit again after a lost answer could place the same order twice, and the approver then had to find and cancel the copy.',
        howItAffectsYou:
          "Until you choose, your cart, the setup bar and the warehouse switch stay as they were sent, and items you start an order with from Items wait until then. If you reload the page or open it in another tab, it remembers and checks for you. The pending order request is kept only for your account and organization on that browser: someone else who signs in there never sees it or sends it, and if you switch to another organization, switch back to finish it.",
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/orders/new', label: 'Place an order' },
        audience: { anyPermission: ['orders:request'], modules: ['orders'] },
      },
      {
        id: 'order-refusals-in-place',
        category: 'improved',
        area: 'Orders',
        title: 'The review says why an order request was not placed',
        whatChanged:
          "When an order request can't be placed, the review now says why, in place: for example an item that was archived or is no longer available to you, a delivery site that is no longer active, or a needed-by date that has passed. Items that can't be ordered are marked in your cart by name.",
        whyItMatters:
          'The reason used to flash by in a corner of the screen, and some reasons read as a server error.',
        howItAffectsYou:
          'Fix what the review names, then submit again. Your cart stays as it was.',
        whatToDo: 'No action needed.',
      },
      {
        id: 'order-needed-by-org-time-zone',
        category: 'improved',
        area: 'Orders',
        title: "The needed-by time is read in your organization's time zone",
        whatChanged:
          "The needed-by date and time you pick on the New order page is now read in your organization's time zone, and the cart says which zone that is. The review shows the date and time before you submit.",
        whyItMatters:
          'It used to be read in the time zone of the computer you placed the order from, so the same choice could mean a different time for the warehouse.',
        howItAffectsYou:
          "If your computer is set to your organization's time zone, nothing changes for you.",
        whatToDo: 'No action needed.',
      },
      {
        id: 'order-page-clearer-labels',
        category: 'improved',
        area: 'Orders',
        title: 'Clearer labels on the New order page',
        whatChanged:
          'The cart\'s button now reads Review order, because it opens the review, and the review\'s button reads Submit order request. Frequently ordered now says it counts the orders placed at that warehouse in the last 30 days, and its sort is Most ordered here. The Featured sort is gone: the list starts in name order.',
        whyItMatters:
          'Some labels promised something the page did not do, such as a list based on your own orders.',
        howItAffectsYou: 'Nothing else about placing an order changes.',
        whatToDo: 'No action needed.',
      },
    ],
  },
  {
    id: 'approval-follows-permission-2026-10',
    revision: 1,
    // Security slice D (migration 0390, pushed 2026-10-04 05:32:44Z;
    // sec-orders plan section 5; owner decision O4, default yes; O3 default:
    // marking in transit needs orders:approve; #314, dcdb7ae8). Held as a
    // draft until 0390 was pushed and verified, the web deploy (web build
    // 3e9201bd1661, built 05:34:06Z: assignment and in transit through
    // assign_order_delivery and mark_order_in_transit, on-behalf ordering and
    // the cancel window by the permission), the phone update that shows the
    // order screen's actions by the permission (OTA group 5b19a88a, iOS update
    // 01a10569, published 05:36Z, launched on phones) and the Demo Co
    // production walk (SO-000018 approved, picked, packed, staged, given a
    // driver through assign_order_delivery, marked in transit through
    // mark_order_in_transit and cancelled; the published phone bundle showed
    // an admin Approve and Deny on a pending order) were done. Demo Co has no
    // staff member, so the granted, revoked and viewer cases were proven
    // locally. Published after them, the newest release, a minute after
    // slice B's timeline release; the PO-2 draft sits above it.
    //
    // Its words were re-read against what shipped. Old phone bundles still show
    // these actions by role (and confirm_physical_signature still admits a
    // manager by role), so what the mobile app offers is said "after the latest
    // update". The granted entry no longer says "as managers see them": Assign
    // delivery also needs orders:assign_delivery ("Assign deliveries", which
    // staff do not hold by default), and a paper signature a manager or the
    // driver. Every one of these actions asks write access to the order's
    // warehouse (requireWarehouseAccess), and since slice B so does handing the
    // order over below manager rank, the assigned driver excepted
    // (handOverAllowed: the web's Collect signature link, the warehouse slip,
    // the sign route's member path), so the granted entry says so; cancelling
    // asks no warehouse access. The removed entry adds ordering on someone
    // else's behalf (the New order page and createOrderRequestAction asked the
    // manager role until 0390), and its why says the web app itself let such a
    // manager assign a picker (core availableOrderActions offered
    // reassign_picker by role) and order on someone's behalf.
    //
    // The two whys, as the code before 0390 (9147755d) did it. The phone's
    // MANAGER ACTIONS section showed by role (hasPipelineActions: isManager),
    // while it already offered a granted staff member Hold available stock
    // (shouldOfferHoldStock, canApproveOrders), the needed-by Change
    // (canOfferNeededByChange) and claim and pick (viewerCanPick: items:update,
    // a staff default). A manager whose orders:approve was removed was refused
    // Approve, Deny, the slips, staging, reopen, resume and close by the
    // service (assertPermission orders:approve), but not Assign delivery
    // (assignDelivery asked only orders:assign_delivery, a manager default, and
    // the update policy admitted a manager by role) or Mark in transit
    // (markInTransit asked the driver or a manager by role), so the removed
    // entry's why names those two and never says the phone refused them all.
    //
    // Who is told: members of organizations with Orders on. The first entry
    // goes to staff who hold orders:approve, the people it describes (owners,
    // admins and managers hold it by default and gain nothing; it links to
    // the orders list, which reads that permission). Not viewers: the app
    // refuses every write for a viewer (assertWarehouseAccess), so neither
    // app offers a viewer approving or moving orders even with the
    // permission (the web panel's `approves`, the phone's orderManagerActions
    // isViewerRole); production had 0 viewers holding it on 2026-10-04. The
    // second entry goes to owners, admins and managers (a manager whose
    // orders:approve was removed no longer holds it, so the permission cannot
    // address them); the third to every member, since any member can be a
    // delivery's driver.
    //
    // What still goes by role after 0390, and the words say so: finishing or
    // releasing picking someone else claimed (complete_picking,
    // partial_pick_line, release_picking). confirm_physical_signature also
    // still admits a manager by role (or the assigned driver), but neither
    // the web app nor the updated phone offers a manager without
    // orders:approve a hand-over step unless they are the driver (the web
    // panel's `approves || isDriverHere`; the phone's section audience), so
    // the words promise no paper signature; the server side is follow-up 4
    // (sec-orders plan section 10). Cancel: the web app offers it on any open
    // order (CancelOrderButton); the mobile app only on a backordered order.
    // The removed manager's own-order cancel "while it waits for approval" is
    // the apps' rule (OrderRequestsService.cancel, M7); cancel_order_request
    // lets a requester cancel at any open status (review finding 3, recorded
    // as a follow-up).
    status: 'published',
    title: 'Approving orders follows the approve permission',
    summary:
      'Approving orders and moving them toward pickup or delivery now follow the "Approve / fulfill orders" permission on the web, in the mobile app after the latest update, and on the server. A staff member who was given it sees Approve, Deny and the next steps in the mobile app. A manager who had it removed can no longer approve, deny, cancel other people\'s orders or move an order toward pickup or delivery; finishing or releasing picking that someone else claimed still follows the manager role.',
    publishedAt: '2026-10-04T12:25:00Z',
    audience: { modules: ['orders'] },
    entries: [
      {
        id: 'approve-permission-granted',
        category: 'fixed',
        area: 'Orders',
        title: 'Given the approve permission, you can approve in the mobile app too',
        whatChanged:
          'If an admin gave you the "Approve / fulfill orders" permission, the order screen in the mobile app, after the latest update, shows Approve and Deny (and Approve partial when stock is short), the steps that move an order toward pickup or delivery, Reopen picking, and Resume, Close and Cancel for a backordered order. Assign delivery also needs the "Assign deliveries" permission. In the web app you can now also order on someone else\'s behalf, assign who picks an order, reopen picking, and cancel an order you placed yourself after it was approved.',
        whyItMatters:
          "The mobile app already let a staff member who was given the permission hold available stock, change an order's needed-by date, and claim and pick orders. But it showed Approve, Deny and the next steps only to owners, admins and managers. The web app also left out some of the steps above.",
        howItAffectsYou:
          'You can approve orders and move them along from either app, for orders in the warehouses you have access to. Collect signature and Print warehouse slip now follow the same rule, unless you are the order\'s driver. You can cancel other people\'s orders from the web app; the mobile app offers Cancel on a backordered order. What you can do follows the permission, so it changes if an admin changes it. Alerts about new orders waiting for approval still go to owners, admins and managers.',
        whatToDo:
          'No action needed in the web app. In the mobile app, close the app completely and open it again to load the latest update.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { roles: ['staff'], anyPermission: ['orders:approve'], modules: ['orders'] },
      },
      {
        id: 'approve-permission-removed',
        category: 'fixed',
        area: 'Orders',
        title: 'Removing the approve permission from a manager now applies on the server too',
        whatChanged:
          'A manager whose "Approve / fulfill orders" permission was removed can no longer approve or deny orders, order on someone else\'s behalf, cancel other people\'s orders, hold stock for an order, change its needed-by date, assign a picker or a driver, reopen picking, or move an order toward pickup or delivery, in either app or on the server. Neither the web app nor the mobile app, after the latest update, offers them Collect signature or Physical signature unless they are the order\'s driver. Finishing or releasing picking that someone else claimed still follows the manager role for now.',
        whyItMatters:
          "Before this change, the mobile app showed Approve, Deny and the next steps to every manager by role. A manager without the permission could still assign a driver or mark a delivery in transit there, and assign a picker or order on someone else's behalf in the web app, because the server let a manager through by role.",
        howItAffectsYou:
          'Nothing changes for a manager who keeps the permission, which managers have by default. A manager without it can still cancel an order they placed while it waits for approval.',
        whatToDo: 'No action needed.',
        audience: { roles: ['owner', 'admin', 'manager'], modules: ['orders'] },
      },
      {
        id: 'delivery-driver-actions',
        category: 'improved',
        area: 'Orders',
        title: 'Assigned drivers see their delivery steps in the mobile app',
        whatChanged:
          'If you are the assigned driver of a delivery, the order screen in the mobile app, after the latest update, shows Collect signature and Physical signature once the delivery is on its way, as the web app does. Marking a delivery in transit needs the "Approve / fulfill orders" permission, so a driver without it is not offered Mark in transit in either app.',
        whyItMatters:
          'The mobile app showed these steps only to owners, admins and managers. A driver without the approve permission could press Mark in transit in the web app and was told the order status had changed.',
        howItAffectsYou:
          'A driver who has the approve permission still marks their delivery in transit. A driver without it asks someone who has it.',
        whatToDo:
          'No action needed in the web app. In the mobile app, close the app completely and open it again to load the latest update.',
      },
    ],
  },
  {
    id: 'order-signature-timeline-2026-10',
    revision: 1,
    // Order secrets, slice B (migration 0389, pushed 2026-10-04 04:23:52Z;
    // #313, 9147755d). Held as a draft until 0389 was pushed and verified, the
    // web deploy (web build 98b64dc87a91, built 04:25:13Z), the phone's update
    // (OTA group f0a24abc, iOS update 01a1052b, published 04:27Z, launched on
    // phones) and the Demo Co production walk (69 checks passed: SO-000007's
    // packing slips minted through generate_order_packing_slips, its warehouse
    // slip's QR and the panel's link carried the raw token, a digest posted
    // with no session got the one 404, and it was cancelled unsigned; the
    // published phone bundle opened View signature on SO-000002 for an admin)
    // were done. Published after them, a minute before slice D's release and
    // a minute after the signature image release below it.
    //
    // What a person can see: every digital hand-over now writes
    // order.signature_collected, which the order timeline labels "Signature
    // collected" (order-timeline.tsx). Nothing was signed in production, so
    // the line was proven by the local E2E (B-NOTES: the link path and the
    // member path each put Signature collected on the timeline). The words
    // promise no collector's name: only the signed-in member path (the
    // phone's Collect signature) records one; the link path (the web panel, a
    // printed QR, the phone's scan tab) records none, which the timeline
    // shows as Public. No entry is added for an order signed before 0389.
    //
    // Who is told: the timeline reads audit_logs through the viewer's own
    // client, whose policy asks activity_logs:read ("View audit log"), so
    // anyone else sees "No events yet." The release was addressed to
    // orders:approve as a draft; a staff member granted it does not hold
    // activity_logs:read by default, so it now goes to the people who see the
    // timeline, where Orders is on. The phone's View signature change, which
    // every member can see, is its own release (order-signature-image-2026-10).
    status: 'published',
    title: "A digital signature now adds Signature collected to the order's timeline",
    summary:
      "On the web, the order's timeline now shows Signature collected when a customer signs for an order on the signature page or on the mobile app's signature pad.",
    publishedAt: '2026-10-04T12:24:00Z',
    audience: { anyPermission: ['activity_logs:read'], modules: ['orders'] },
    entries: [
      {
        id: 'order-timeline-signature-collected',
        category: 'improved',
        area: 'Orders',
        title: 'Signature collected is on the order timeline',
        whatChanged:
          "When a customer signs for an order on the signature page or on the mobile app's signature pad, the order's timeline on the web now shows Signature collected.",
        whyItMatters:
          'A paper signature left an entry on the timeline, but a digital one left none, so the timeline did not show when the order was handed over.',
        howItAffectsYou:
          'Nothing changes in how you collect a signature. Signatures collected before this change are not added to the timeline.',
        whatToDo: 'No action needed.',
      },
    ],
  },
  {
    id: 'order-signature-image-2026-10',
    revision: 1,
    // Shipped in slice B (#313, 9147755d); its phone part is the over-the-air
    // update (OTA group f0a24abc, published 2026-10-04 04:27Z). Published in
    // the same change as the timeline release and dated a minute before it,
    // so it sits directly below it. The order screen's View signature used to
    // select signature_data_url straight from order_requests, which every
    // member reads, so anyone who opened a signed order saw the image. It now
    // asks GET /api/v1/orders/<id>/signature (order-signature-image.ts), the
    // web panel's route, whose gate is isHandOverEntitled: the effective
    // orders:approve or the order's assigned driver. Anyone else gets 403 and
    // the dialog's empty state, the signer's name and time, as for a paper
    // signature (no image). On the web, View signature sits in the actions
    // panel, which a completed order shows to orders:approve holders only.
    // Old bundles still read the row (the column holds the image until slice
    // C), so the change is said "after the latest update". The production
    // walk opened View signature on the published bundle as an admin (image
    // shown, through the route); the refusal for anyone else is proven by
    // order-signature-image.test.ts and the route's tests.
    //
    // For every member where Orders is on: anyone can open a signed order in
    // the mobile app.
    status: 'published',
    title: 'Only approvers and the driver see a signature image in the mobile app',
    summary:
      'In the mobile app, after the latest update, View signature on an order shows the customer\'s signature image only to people with the "Approve / fulfill orders" permission and to the order\'s assigned driver. Anyone else sees who signed and when, without the image.',
    publishedAt: '2026-10-04T12:23:00Z',
    audience: { modules: ['orders'] },
    entries: [
      {
        id: 'order-signature-image-mobile',
        category: 'fixed',
        area: 'Orders',
        title: 'Only approvers and the driver see a signature image in the mobile app',
        whatChanged:
          'In the mobile app, after the latest update, View signature on an order shows the customer\'s signature image only to people with the "Approve / fulfill orders" permission and to the order\'s assigned driver. Anyone else sees who signed and when, without the image.',
        whyItMatters:
          "A customer's signature is personal information. In the mobile app, anyone who could open the order could see it, while the web app shows it only to people with that permission.",
        howItAffectsYou:
          "If you have that permission, or you are the order's assigned driver, nothing changes for you. Otherwise View signature shows the signer's name and the time, as it does for a paper signature.",
        whatToDo: 'No action needed.',
      },
    ],
  },
  {
    id: 'account-deletion-orders-2026-10',
    revision: 1,
    // Account deletion for people who placed orders (migration 0388, pushed
    // 2026-10-03 20:26:18Z; security slice A2, plan section 10 item 16; #312,
    // 562d1f0c). Held as a draft until 0388 was pushed and verified, the web
    // deploy (web build 399eedb47aa2, served since 20:27:55Z: the check before
    // the delete, and Deleted user on the orders list, the order page and its
    // print view, the pick page, the pick slip PDF and both Orders exports),
    // the phone update that names the requester Deleted user (OTA group
    // 4a060cce, iOS update 01a10414, published 23:24Z, launched on phones with
    // no failures) and the Demo Co production walk (the web and the phone
    // refused the RESTRICT-blocked demo account with the blocked sentence and
    // changed nothing) were done. Published after them, at the top of the
    // published releases; the slice B draft sits above it.
    //
    // Its words were re-read against what shipped. Orders no longer stop a
    // deletion (0388: the FK's SET NULL stamps requester_deleted_at, which
    // identity_chk accepts), but records the organization keeps (received
    // stock, imported POs, schedule entries, returns) still refuse it until
    // slice A3, so never "it now works" alone. (Five closed orders from May
    // that break the NOT VALID order_requests_delivery_target_chk still
    // refuse the two accounts they name, both already refused by those keys
    // with the same sentence; A3 handles them, plan F12.) The label is
    // inferred from the row (no requester id and no email, core
    // isDeletedRequester), so an order that recorded the person's name or
    // email (legacy and portal rows) keeps showing it, and nothing about the
    // person is copied onto any order. Open orders keep their status; a
    // manager can still approve or cancel them (pgTAP D15). Old phone bundles
    // say "External requester" until the update loads, with no prompt, when
    // the app is opened again. The refusal
    // itself (the plain sentence, nothing changed, and the phone no longer
    // saying "Account deleted" when it was not) is announced on its own
    // (account-deletion-refused-2026-10, below), because it needs no update.
    //
    // For everyone: anyone can delete their own account (Settings, on the
    // web and the phone), and no page is linked.
    status: 'published',
    title: 'Orders you placed no longer stop you deleting your account',
    summary:
      'Orders you placed no longer stop you deleting your account from Settings, on the web or in the mobile app. The orders stay with your organization. On the web, and in the mobile app after the latest update, they show “Deleted user” as the requester, unless an order recorded your name or email.',
    publishedAt: '2026-10-04T05:35:00Z',
    entries: [
      {
        id: 'account-deletion-orders',
        category: 'fixed',
        area: 'Account',
        title: 'Orders you placed no longer stop you deleting your account',
        whatChanged:
          'Deleting your account from Settings no longer fails because you placed orders. The orders stay with your organization. On the web, the orders list, the order page and its print view, the pick slip and the Orders export show “Deleted user” as the requester. In the mobile app, after the latest update, the orders list and the order screen show it too. An order that recorded your name or email keeps showing it.',
        whyItMatters:
          'Until now, an order you had placed could stop you deleting your account from Settings, because each order had to name who placed it.',
        howItAffectsYou:
          'Your name and email are not copied onto your orders when you delete your account. Open orders stay open, and your organization can still approve or cancel them. Other records your organization keeps, such as received stock, can still stop a deletion; the app then says so and changes nothing.',
        whatToDo:
          'No action needed on the web. In the mobile app, close the app completely and open it again to load the latest update.',
      },
    ],
  },
  {
    id: 'account-deletion-refused-2026-10',
    revision: 1,
    // Shipped in security slice A2 (#312, 562d1f0c), live with web build
    // 399eedb47aa2; published in the same change as the account deletion
    // release and dated a minute before it, so it sits directly below it. The
    // web self-delete and the phone's POST /api/v1/account/delete now ask
    // account_deletion_check (0388) first. An account linked to records the
    // organization keeps (an integrity refusal, SQLSTATE class 23) is told
    // ACCOUNT_DELETE_BLOCKED_COPY (server/lib/account-deletion.ts) and
    // nothing is written: no profile tombstone, no audit row, no session
    // revoke, and the person stays signed in. Before, both wrote the
    // tombstone and a user.deactivated row first; after the refused delete
    // the web answered "Your account could not be deleted right now. Please
    // try again." and the phone route answered 200, so the phone signed out
    // and said "Account deleted" while the account was still there. The phone
    // shows the route's message for any answer that is not a success and
    // stays signed in (settings.tsx performDelete, unchanged by A2), so every
    // installed phone gets this without an update. The Demo Co production
    // walk saw the sentence on the web (toast) and on the phone (alert, "Could
    // not delete account"), signed in after, with nothing changed.
    //
    // For everyone, with no link: anyone can try to delete their own account.
    status: 'published',
    title: "When your account can't be deleted, the app now says why",
    summary:
      "On the web and in the mobile app, if your account can't be deleted because it is linked to records your organization keeps, such as received stock, Delete my account now says so. Nothing is changed and you stay signed in. The mobile app no longer says an account was deleted when it was not.",
    publishedAt: '2026-10-04T05:34:00Z',
    entries: [
      {
        id: 'account-deletion-refused',
        category: 'fixed',
        area: 'Account',
        title: 'A refused account deletion says why and changes nothing',
        whatChanged:
          "If your account is linked to records your organization keeps, such as received stock, imported purchase orders or schedule entries, Delete my account now says it can't be deleted from the app, that nothing was changed, and to contact StockPilot support to have it removed. You stay signed in. The web and the mobile app say the same.",
        whyItMatters:
          'Before, the web said “Your account could not be deleted right now. Please try again.” Trying again failed the same way. The mobile app could say “Account deleted” and sign you out while the account was still there.',
        howItAffectsYou:
          'This happens only to an account linked to such records. The account, your access and those records stay as they were.',
        whatToDo: 'No action needed.',
      },
    ],
  },
  {
    id: 'exceptions-session-ended-2026-10',
    revision: 1,
    // Shipped in count differences R2 (#308, 77e5659f); published in the same
    // change as the count confirm's release and dated after it, so it sits
    // above it. On the web, fail() in server/actions/exceptions.ts now
    // rethrows framework control flow first (unstable_rethrow), so
    // withContext's redirect('/signin') for a signed-out session reaches the
    // browser, which goes to the sign-in page; it used to be caught and
    // answered "Something went wrong. Please try again." (live with web build
    // 0f540fe33eae). In the mobile app,
    // describeActError, which the Acknowledge, Add note and Confirm this count
    // sheets use, reads a 401 as core's VERIFICATION_SESSION_ENDED_COPY; the
    // sheets printed the route's bare code, "unauthenticated". That part is
    // the over-the-air update (OTA group a6a9c7e9, live), which loads when the
    // app is opened again, with no prompt; confirming itself never needed it.
    //
    // A lost permission is not announced: the phone's words for a 403 did not
    // change (describeActError already said EXCEPTION_ACT_REFUSED_COPY's
    // sentence), and on the web the app's own gate answers a lost permission
    // first, with its own words; only the database's refusal, behind it, now
    // shares the phone's sentence.
    //
    // Addressed as the Exceptions pages are reached (items:read); the entry
    // as the sheets and the web actions it names are offered (stock:adjust,
    // the gate of acknowledging, adding a note and confirming).
    status: 'published',
    title: 'Exceptions ask you to sign in again when your session has ended',
    summary:
      'On the web, an action on an exception after your session has ended now takes you to the sign-in page, instead of saying "Something went wrong. Please try again." In the mobile app, after the latest update, the Acknowledge, Add note and Confirm this count sheets say "Your session has ended. Sign in again."',
    publishedAt: '2026-10-03T19:08:00Z',
    audience: { anyPermission: ['items:read'] },
    entries: [
      {
        id: 'exceptions-session-ended',
        category: 'fixed',
        area: 'Inventory',
        title: 'An ended session leads to sign-in, not an error, on exceptions',
        whatChanged:
          'On the web, when your session has ended, an action on an exception, such as Acknowledge, Add note or Confirm this count, now takes you to the sign-in page. In the mobile app, after the latest update, the Acknowledge, Add note and Confirm this count sheets say "Your session has ended. Sign in again."',
        whyItMatters:
          'On the web, the action said "Something went wrong. Please try again." Trying again failed the same way. In the mobile app, the sheets showed only the word unauthenticated.',
        howItAffectsYou:
          'Nothing was saved when this happened. Sign in again, then open the exception and try again.',
        whatToDo:
          'No action needed on the web. In the mobile app, close the app completely and open it again to load the latest update.',
        link: { href: '/dashboard/exceptions', label: 'Open Exceptions' },
        audience: { anyPermission: ['stock:adjust'] },
      },
    ],
  },
  {
    id: 'count-confirm-2026-10',
    revision: 1,
    // Count differences, release 2 of 2 (migration 0386, pushed 2026-10-03
    // 13:23:33Z; owner decision 2026-09-29, "1 and 2"). Held as a draft until
    // 0386 was pushed and verified, the web deploy (web build 0f540fe33eae,
    // served since 13:24:30Z: the confirm dialog and the Resolved filter) and
    // the Demo Co production walk (119 checks passed: EX-000025 confirmed in
    // the mobile app as the counter, its recurrence EX-000026 confirmed on the
    // web after a linked recount was cancelled) were done. Confirming needs no
    // phone update: the Confirm sheet shipped in release 1 and the walk
    // confirmed on the bundle phones already ran. The R2 phone update (OTA
    // group a6a9c7e9, iOS update 01a10220) says a session ended instead of
    // printing "unauthenticated", and loads when the app is opened again, with
    // no prompt; it is announced on its own (exceptions-session-ended-2026-10,
    // above), so this release's What to do never suggests confirming needs
    // it. Published after them; no draft is left.
    //
    // Its words were re-read against what shipped. Who confirms: the person
    // who recorded the counted line, or a manager, admin or owner
    // (has_org_role manager), each through the act gate (stock:adjust and
    // access to the item's live warehouse), so never "a manager" alone.
    // Confirm is offered only while the stock on record equals the counted
    // number (a move that nets to zero still allows it), not "once it has
    // changed". Before this, a count difference cleared only when a later
    // count matched. The timeline line reads "Count confirmed by <name>, who
    // counted it, without a second count". The dialog's "If a later count
    // does not match the stock on record, a new exception opens." is read at
    // the moment of confirming; on its own here it says so after a confirm.
    //
    // Addressed as the page it links to is reached (Exceptions: items:read),
    // then as confirming is offered: stock:adjust, the floor the server
    // asserts before exception_confirm_count, where Cycle Counts is on
    // (count differences come only from posted counts; plan section 10 keeps
    // the module on purpose, though a manager can confirm with it off).
    status: 'published',
    title: 'Confirm a counted number to close a count difference',
    summary:
      "On the web and in the mobile app, if a count difference's counted number is right, the person who counted the item, or a manager, admin or owner, can now confirm it. Confirming closes the exception without a second count. Acknowledging still leaves it open.",
    publishedAt: '2026-10-03T18:40:00Z',
    audience: { anyPermission: ['items:read'] },
    entries: [
      {
        id: 'confirm-this-count',
        category: 'new',
        area: 'Cycle counts',
        title: 'Confirm this count closes a count difference',
        whatChanged:
          'On the web and in the mobile app, a Count did not match the stock on record exception now offers Confirm this count to the person who counted the item and to managers, admins and owners. It shows the counted number and the stock on record before the count and now, and closes the exception when you choose Confirm and close. The timeline records who confirmed it, whether they counted it, and that it closed without a second count. On the web, Closed without a second count on the Resolved tab lists only the exceptions closed this way.',
        whyItMatters:
          'Until now a count difference cleared only when a later count matched the stock on record, so it stayed open even when the counted number had already been checked on the floor. Acknowledging it did not close it.',
        howItAffectsYou:
          "Confirming closes the exception without a second count, so confirm only a number you are sure of. If you are not sure, have it counted again; a manager can start that with Recount. Confirm is offered only while the stock on record equals the counted number. It is also not offered while a recount linked to this exception is in progress, or while another count in progress has recorded a different number for the item. In these cases the page says why. Confirming needs permission to adjust stock and a connection. After you confirm, a later count that does not match opens a new exception.",
        whatToDo:
          'No action needed. To confirm, open an exception under Count did not match the stock on record, and if the counted number is right, choose Confirm this count.',
        link: { href: '/dashboard/exceptions', label: 'Open Exceptions' },
        audience: { anyPermission: ['stock:adjust'], modules: ['cycle_counts'] },
      },
    ],
  },
  {
    id: 'order-shortfall-po-2026-10',
    revision: 1,
    // F2-5 (migration 0385, pushed 2026-09-30 15:33Z). Held as a draft until
    // the web dialog (web build 8f228006cbc3), the phone's sheet (OTA group
    // 3b457841, iOS launches with no failures) and the Demo Co production walk
    // (SO-9: draft its shortfall, open the draft on the web and the phone,
    // cancel it; 66 checks passed) were done, as F2-1's to F2-4's were. The
    // phone's route was proven in production without a write (a refused
    // over-quantity answered shortfall_changed). Published after them, the
    // newest release; no draft is left.
    //
    // Its words were re-read against what shipped. The walk showed the
    // designed rule (core readiness.ts draftable, 0385
    // order_shortfall_draftable): supply that other approved orders already
    // need does not count as cover, so after a 180 draft SO-9 still offered 50
    // (SO-8, backordered, needs 50 of it). So the words never say a draft
    // covers an item for good. Drafting is for managers, admins and owners
    // with Manage purchase orders; drafts are not sent to suppliers or
    // emailed (integrations hear of each new PO, as for every draft). The
    // phone's PO screen shows a draft for review, with Back, and keeps
    // attachments, so it is not called read-only. The button shows only while
    // something is left to draft. The phone part is an over-the-air update
    // that loads when the app is opened again, with no prompt.
    //
    // Addressed as the page it links to is reached, then as drafting is
    // allowed. The release: the orders module and orders:approve (the Orders
    // list shows every order to approvers; anyone else sees only their own
    // requests, where a short order to buy for would not be found). The entry:
    // a manager holding purchase_orders:manage where Purchase orders is on,
    // the database's own floors (draft_order_shortfall_pos, 0385).
    status: 'published',
    title: 'Draft a PO for just what an order is short',
    summary:
      "On the web and in the mobile app, managers, admins and owners who can manage purchase orders can now draft purchase orders from an order for just what it is short: the part that the stock on record, open POs and drafts don't already cover, after what other approved orders need from them. One draft is made per supplier, plus one for items with no supplier, and drafts are not sent.",
    publishedAt: '2026-10-02T23:19:00Z',
    audience: { anyPermission: ['orders:approve'], modules: ['orders'] },
    entries: [
      {
        id: 'order-draft-po-for-shortfall',
        category: 'new',
        area: 'Orders',
        title: 'Draft a PO for just what an order is short',
        whatChanged:
          "When an order is short and something is left to draft, Draft PO for what is short on its readiness lists each short item: how much is short, how much open POs and drafts already cover, what other approved orders already need from them, and how much can still be drafted. Choose the items and quantities, and one draft purchase order is made per supplier, plus one for items with no supplier, each naming the order in its notes. Kits are not drafted; order their components. The mobile app's order screen offers the same; there a draft PO opens for review, with Back, and is ordered on the web.",
        whyItMatters:
          'Readiness showed what an order was short, but buying it meant working out what was still needed and copying it into a new purchase order by hand, one supplier at a time.',
        howItAffectsYou:
          "Drafting is for managers, admins and owners with the Manage purchase orders permission. Drafts are not sent to suppliers or emailed: check each draft's supplier, set its destination and order it on Purchase orders. An item that open POs or drafts already cover says so and is not drafted again. What other approved orders need from them does not count as cover, so after a draft an item can still have more to draft. If stock or POs change so that less can be drafted than you chose, nothing is drafted, and the most that can be drafted now is shown. Pressing Draft twice drafts once.",
        whatToDo:
          'No action needed on the web. In the mobile app, close the app completely and open it again to load the latest update. On a short order, choose Draft PO for what is short.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: {
          roles: ['owner', 'admin', 'manager'],
          anyPermission: ['purchase_orders:manage'],
          modules: ['purchase_orders'],
        },
      },
    ],
  },
  {
    id: 'order-needed-by-change-2026-10',
    revision: 1,
    // F2-4 (migration 0383). Held as a draft until the web order page's
    // Change dialog (web build a5666549db6b), the phone's sheet (OTA group
    // e301d35b) and the Demo Co production walk (SO-15 pending, SO-16 approved
    // then cancelled, a Schedule test event) were done, as F2-1's to F2-3's
    // were. Published once all three were live and the walk passed; its words
    // were re-read against what shipped: only the date sentence StockPilot
    // wrote in an entry's description changes (one rewritten by hand is kept),
    // only an entry that has not started is reminded again, and before this an
    // event moved after its day-ahead reminder still got its one-hour one.
    //
    // Addressed per entry. Changing the date is for orders:approve, the
    // permission the service asserts (a manager holds it by role), where
    // Orders is on; it links to the orders list. The Schedule fix is for
    // schedule:manage, the permission the Schedule edit page checks, where the
    // Schedule module is on; it links to the Schedule, which that permission
    // opens.
    status: 'published',
    title: "Change an order's needed-by date; the schedule follows",
    summary:
      "On the web and in the mobile app, an approver can now change an open order's needed-by date, with a reason, and the order's Schedule entry moves with it: the date StockPilot wrote in its description changes too, and if the entry hasn't started, its reminders are set again for the new time. On the web, moving an event on the Schedule page now sends its reminders again for the new time.",
    publishedAt: '2026-09-30T16:08:00Z',
    entries: [
      {
        id: 'order-needed-by-change',
        category: 'new',
        area: 'Orders',
        title: "Change an order's needed-by date, and its Schedule entry follows",
        whatChanged:
          "On an open order, Change beside its needed-by date lets you pick a new date and time and say why. The order's Schedule entry moves to the new time in the same step: the date StockPilot wrote in its description changes, anything your team added to the description stays, and if the entry hasn't started, its reminders are set again for the new time. Times are entered and shown in your organization's time zone, which the Change window names. The mobile app's order screen offers the same change.",
        whyItMatters:
          "A needed-by date could be set only before approval. After approval, changing the date meant moving the Schedule entry by hand, which left the order's date and the entry's description behind.",
        howItAffectsYou:
          "Changing the date needs permission to approve orders and access to the order's warehouse, and a reason, which the order's history records. If someone saved a different date while you were editing, nothing is changed and the order shows the date they saved. A completed or cancelled Schedule entry stays as it is. An approved order that had no needed-by date gets its Schedule entry when you set one. The change itself sends no email: the requester's delivery request email still opens only when they choose it, with the new date in it. Schedule reminders for the new time go out as usual.",
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { anyPermission: ['orders:approve'], modules: ['orders'] },
      },
      {
        id: 'schedule-move-rearms-reminders',
        category: 'fixed',
        area: 'Schedule',
        title: 'Moving an event on the Schedule sends its reminders again for the new time',
        whatChanged:
          "On the web, when you change an event's start on the Schedule page, its day-ahead and one-hour reminders are set again for the new time.",
        whyItMatters:
          'An event already reminded a day ahead of its old time got no day-ahead reminder for its new one, and an event moved after its one-hour reminder was not reminded again at all.',
        howItAffectsYou:
          'Editing an event without changing its start leaves its reminders as they were. Reminders go to the same people as before: the person assigned and your managers.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/schedule', label: 'Open Schedule' },
        audience: { anyPermission: ['schedule:manage'], modules: ['schedule'] },
      },
    ],
  },
  {
    id: 'book-order-totals-charters-dates-2026-10',
    revision: 1,
    // Book Order Totals by charter and exact dates (0382). Held as a draft
    // until 0382, the web deploy (and the calendar fix, #300, web
    // 73d4f0cb1eaa), the phone update (OTA group 37e7ada7) and the Demo Co
    // production checks on the web and the phone were done, and until the
    // phone update had reached phones (plan R8b): an older phone ignores a
    // charter in a link and shows every charter. Published after them; its
    // words were re-read against what shipped: the calendar opens from Custom
    // range or a date field, the phone's filter and calendar arrive with the
    // update, and the web address and Back to Book Order Totals are the web's.
    //
    // Addressed as the report is reached: Orders on (the release), then Books
    // on with reports:read, the permission the linked page checks (both
    // entries).
    status: 'published',
    title: 'Book Order Totals by charter and by exact dates',
    summary:
      'Book Order Totals on the web and in the mobile app can now show the books ordered for one charter, and orders placed between two dates you pick on a calendar. Today and This week are new date choices. The totals, the orders behind each book and the CSV and PDF files all follow the charter and dates you choose.',
    publishedAt: '2026-09-30T16:07:00Z',
    audience: { modules: ['orders'] },
    entries: [
      {
        id: 'book-order-totals-charter-filter',
        category: 'new',
        area: 'Reports',
        title: 'See the books ordered for one charter',
        whatChanged:
          "Book Order Totals has a Charter filter. Choose a charter to see only the copies requested on orders placed for it: the totals at the top, each book row, View orders and the files all change together. With All charters chosen, Books ordered by charter lists each charter's copies and orders, and choosing one applies it.",
        whyItMatters:
          'Answering how many copies of each book a charter asked for meant reading orders one by one.',
        howItAffectsYou:
          'The filter uses the charter each order was placed for, its delivery site, not the charter that owns the stock. Pickup orders have no charter and are listed under No charter. You can choose only charters you have access to. In the mobile app, close the app completely and open it again to load the latest update, which brings the Charter filter and the calendar, and opens links that choose a charter.',
        whatToDo: 'No action needed. Open Reports, then Book Order Totals, and choose a charter.',
        link: { href: '/dashboard/reports/book-order-totals', label: 'Book Order Totals' },
        audience: { anyPermission: ['reports:read'], modules: ['books'] },
      },
      {
        id: 'book-order-totals-exact-dates',
        category: 'improved',
        area: 'Reports',
        title: 'Pick exact dates on a calendar, and see what you are looking at',
        whatChanged:
          'Custom range under Orders placed now opens a calendar for the first and last day, and Today and This week (starting Sunday) are new date choices. Showing, above the totals, names the charter and dates in view, and the warehouse when the report covers only one. Each filter you set appears as a chip you can remove (in the mobile app, the search keeps its own box), and Clear filters resets them all.',
        whyItMatters:
          'Exact ranges such as September 1 through September 30 are quicker to set, and the figures always say which charter and dates they cover.',
        howItAffectsYou:
          "Dates are the day an order was placed, in your organization's time zone, and a range includes all of its last day. On the web, the page's address keeps the charter, dates, search and page, and when you open an order from View orders, Back to Book Order Totals on the order, or your browser's Back button, returns you to the same view.",
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/reports/book-order-totals', label: 'Book Order Totals' },
        audience: { anyPermission: ['reports:read'], modules: ['books'] },
      },
    ],
  },
  {
    id: 'count-difference-words-2026-10',
    revision: 1,
    // Count differences, release 1 of 2 (no migration; owner decision
    // 2026-09-29 after EX-000059 was acknowledged in the belief that it would
    // close). Held as a DRAFT until the web deploy, the phone update (OTA group
    // 749c0489, shared with the Sports fields) and the Demo Co walk were done.
    // Published after them; its words were re-read against what shipped: the
    // old sheets ran off the top with the keyboard open (the note field itself
    // was still partly in view), the sheets changed with the keyboard down too,
    // Acknowledge is no longer the filled button on a count difference, and a
    // phone update loads when the app is opened again, with no prompt.
    //
    // Words only, and where they sit: the row sentence, "What clears this" at
    // the top of the page, and the Acknowledge step's help. Nothing about
    // confirming a count: that is release 2's note (count-confirm-2026-10).
    // Addressed to readers of exceptions where Cycle Counts is on: count
    // differences come only from posted counts. Most of them cannot start a
    // recount (viewers, staff without cycle_counts:assign), so the entry says
    // a manager starts it, as the page itself does.
    status: 'published',
    title: 'Count differences say what clears them',
    summary:
      'When a posted count changes the stock on record, its exception now says plainly what clears it, and the Acknowledge step says that acknowledging does not. In the mobile app, the note you type on an exception stays in view above the keyboard.',
    publishedAt: '2026-09-30T16:06:00Z',
    entries: [
      {
        id: 'count-difference-what-clears-it',
        category: 'improved',
        area: 'Inventory',
        title: 'A count difference says what clears it',
        whatChanged:
          'Each count difference now reads, for example, CC-000035 found 2 where 100 was on record (-98), and its page says at the top what clears it: a later count that matches the stock on record, which a manager can start with Recount. The Acknowledge step says that acknowledging does not clear it.',
        whyItMatters:
          'The old wording read "on record 100" after the count had already changed the stock on record, and acknowledging looked like the way to close the exception.',
        howItAffectsYou:
          'Nothing changes in when these exceptions are raised or cleared. Only the words, where they sit on the page, and which button stands out are new: on a count difference, Acknowledge is no longer the filled button.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/exceptions', label: 'Open Exceptions' },
        audience: { anyPermission: ['items:read'], modules: ['cycle_counts'] },
      },
      // The R1 walk (iPhone 17, largest text size): the phone's note sheets
      // on every exception, and the photo sheets. For the people who can
      // acknowledge and add photos (the act gate, as exception-photos-add-remove).
      {
        id: 'phone-exception-note-keyboard',
        category: 'fixed',
        area: 'Mobile app',
        title: 'The note you type on an exception stays in view in the mobile app',
        whatChanged:
          "In the mobile app, when you type a note to acknowledge an exception, add a note to it, or add or remove a photo, the note field (the reason, when you remove a photo) now stays in view above the keyboard, at the largest text sizes too. Dragging the sheet's text, or tapping its title or its text, puts the keyboard away without sending anything. At the largest text sizes the photo sheets now fit above the keyboard, with their title and Close on screen.",
        whyItMatters:
          "At the largest text sizes, with the keyboard open, the note and photo sheets ran off the top of the screen, taking their title and Close with them, and only the sheet's own buttons put the keyboard away.",
        howItAffectsYou:
          "At the largest text sizes the note's text stops growing at the size of the app's other fields. What you type and save is unchanged.",
        whatToDo: 'Close the app completely and open it again to load the latest update.',
        link: { href: '/dashboard/exceptions', label: 'Open Exceptions' },
        audience: { anyPermission: ['stock:adjust'] },
      },
    ],
  },
  {
    id: 'sports-required-fields-2026-10',
    revision: 1,
    // fix/sports-required-attributes (no migration). Held as a draft until the
    // web deploy, the phone update (OTA group 749c0489, shared with the count
    // difference words) and the Demo Co production walk were done. Published
    // after them; its words were re-read against what shipped: the phone names
    // a missing detail in a message, not under the field, and a Sports
    // category with a size scale (Jerseys and Shoes in both organizations) takes
    // the per-size rows there; Create items on a PO import and New rental item
    // are web screens; a phone update loads when the app is opened again.
    //
    // No release-wide audience: the New item and PO import entries are for
    // Sports organizations (sports module) and the people who can create items
    // or manage purchase orders, the permissions those pages and actions
    // check. The rental entry is for every organization with Rentals on: its
    // size buttons were offered for any category with sizes, Sports or not.
    status: 'published',
    title: 'New item says which Sports details it needs, and New rental item always adds a rental item',
    summary:
      "On the web, New item now marks the details a Sports category needs, such as a size for Jerseys, and says what is missing under the field before anything is saved, instead of refusing the save afterwards. The mobile app checks the same details before it saves and names the missing one. On the web, a size typed on a PO import line now answers Missing attribute, and New rental item adds one rental item at a time, without size buttons.",
    publishedAt: '2026-09-30T16:05:00Z',
    entries: [
      {
        id: 'sports-new-item-required-fields',
        category: 'fixed',
        area: 'Inventory',
        title: 'New item says which Sports details are required',
        whatChanged:
          'On the web, when you pick a Sports category such as Jerseys or Shoes, the fields it needs no longer say (optional), and the Size box shows an example that fits it, such as M for Jerseys and 10.5 for Shoes. Leaving a required field empty shows what to enter under it, for example Enter a size, or pick sizes above to add one item per size, and nothing is saved. In the mobile app, New item checks the same details before it saves and names the missing one in a message, for example Size required on a category with no sizes to pick from.',
        whyItMatters:
          'Every Sports field was labelled optional, so the first sign that a Jersey needs a size was a refused save that said only A size is required for this product.',
        howItAffectsYou:
          "On the web, if a value is still refused, such as a size that is not on the category's size scale, the reason also shows under that field. Picking sizes with the size buttons still adds one item per size, with no single size needed. On Shoes whose size scale sets a size system, such as US Men's, a single item can now be saved without picking one: the scale's system is used. Other Sports categories, such as Balls, still need nothing. In the mobile app, a category with sizes still asks for a quantity on at least one size, and saving before its sizes have loaded says Sizes are still loading.",
        whatToDo:
          'No action needed on the web. In the mobile app, close the app completely and open it again to load the latest update.',
        audience: { anyPermission: ['items:create'], modules: ['sports'] },
      },
      {
        id: 'sports-po-import-typed-size',
        category: 'fixed',
        area: 'Purchase orders',
        title: 'A size typed on a PO import line answers Missing attribute',
        whatChanged:
          'On the web, in Create items on a PO import, a line with no size shows Missing attribute when you choose a Sports category that needs one. Typing the size on the line, and for Shoes picking the size system, now clears it and lets Confirm go ahead. The Size, Size system and Number boxes say (required) when the chosen category needs them, and the Size box shows an example that fits the category.',
        whyItMatters:
          'The line stayed marked Missing attribute however its Size box was filled, so the item could not be created from the import.',
        howItAffectsYou:
          "The line is checked again when you confirm. On Shoes, a line needs its size system even when the category's size scale sets one: pick it on the line.",
        whatToDo: 'No action needed.',
        audience: { anyPermission: ['purchase_orders:manage'], modules: ['sports'] },
      },
      {
        id: 'rental-new-item-one-at-a-time',
        category: 'fixed',
        area: 'Rentals',
        title: 'New rental item always adds a rental item',
        whatChanged:
          "On the web, New rental item no longer shows size buttons for a category with sizes. Each rental item is added on its own, and a Sports category's size is typed in the Size box, which says when it is required. A Sports rental item is not joined to a product group.",
        whyItMatters:
          'Picking sizes on New rental item added ordinary inventory items, not rental items, and then opened the inventory list.',
        howItAffectsYou:
          'To add the same rental item in several sizes, add each size on its own. Rental items you already have are unchanged.',
        whatToDo: 'No action needed.',
        audience: { anyPermission: ['items:create'], modules: ['rentals'] },
      },
    ],
  },
  {
    id: 'order-fix-holding-up-2026-10',
    revision: 1,
    // F2-3 (no migration). Held as a draft until the web order page's
    // put-away links and approve-partial preview (web build 97a6ea48f9ac),
    // the phone's (OTA group 83d6a10f), and the Demo Co production walk
    // (SO-17 put-away, SO-21 approve partial) were done, as F2-1's and F2-2's
    // were. Published once all three were live and the walk passed; its words
    // were re-read against what shipped (the walk's fixes: the order's own
    // warehouse, View items, the moved-on and order-changed sentences).
    //
    // Addressed where Orders is on. Put away is offered on the full readiness
    // panel (core readinessAudience: approvers, pickers with items:update,
    // buyers with purchase_orders:manage); its text names the Transfer stock
    // and View items permissions Put away needs, and the order says which is
    // missing to anyone without them. Approve partial and Resume fulfillment
    // are for orders:approve, the permission both actions assert.
    status: 'published',
    title: "Fix what's holding an order up",
    summary:
      "On the web and in the mobile app, an order's readiness now offers Put away, which opens the Staging list with just the items that must be put away before picking can take them. Approve partial and Resume fulfillment now show what they will hold before you confirm, and afterwards say what was held, including when stock changed in between.",
    publishedAt: '2026-09-29T15:42:00Z',
    audience: { modules: ['orders'] },
    entries: [
      {
        id: 'order-put-away-from-the-order',
        category: 'new',
        area: 'Orders',
        title: 'Put away what an order is waiting for, from the order',
        whatChanged:
          "When an order needs stock that is still in Staging, where picking cannot take it, the order's readiness offers Put away on each of those lines, and above the lines one button for all of them, such as Put away 3 items. It opens the Staging list showing only those items, marked Showing items from SO-000123, with Show all and Back to the order. The mobile app opens its Staging list the same way from the order.",
        whyItMatters:
          "Stock received into Staging stops a pick until it is placed on a rack, and finding an order's items in a long Staging list meant searching for each one.",
        howItAffectsYou:
          "Placing stock works as it always has and needs the Transfer stock permission, and opening the Staging list needs the View items permission; without them the order says which is missing instead of offering Put away. The list shows the stock at the order's own warehouse, where its pick comes from, and says when stock at other warehouses was left out. It also shows the items' Unplaced stock, which picking can already take. Back on the order, its readiness shows what you placed, and Check again reads it again at any time.",
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: {
          anyPermission: ['orders:approve', 'items:update', 'purchase_orders:manage'],
          modules: ['orders'],
        },
      },
      {
        id: 'order-partial-preview',
        category: 'improved',
        area: 'Orders',
        title: 'Approve partial and Resume fulfillment show what they will hold',
        whatChanged:
          'Approve partial, on an order waiting for approval, and Resume fulfillment, on a backordered order, now show before you confirm how many units of each item they will hold now, such as Holds 36 of 40, and how many ship when they arrive. An item on several lines of the order is shown once, with its lines combined. After you confirm, it says what was held, in the same window on the web and in a message in the mobile app, for example Approved. Holding 36 of 40 units.',
        whyItMatters:
          'Both hold only what is free at the moment you confirm, and nothing showed how much that was until the order had been approved or resumed.',
        howItAffectsYou:
          "What was held is read from the order after it is approved or resumed, never copied from the preview. If stock changed in between, it says so, for example Holding 34 of 40 units, 2 fewer than shown because stock changed after you looked. If the order's own lines changed in between, it says The order changed after you looked instead. If the order moved on first, such as when someone else approved or resumed it, the preview is cleared: Approve partial says This order is no longer waiting for approval, and Resume fulfillment says Only a backordered order can be resumed.",
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { anyPermission: ['orders:approve'], modules: ['orders'] },
      },
    ],
  },
  {
    id: 'small-fixes-2026-09',
    revision: 1,
    // Fixes from the 2026-09-28/29 walks (fix/small-walk-fixes, no migration).
    // Held as a draft until the phone update (OTA group 83d6a10f) carried the
    // phone fixes and they were walked on the simulator and in the Demo Co
    // production walk; the web fixes went live with build 08974b535640.
    // Published after F2-3's walk, just before F2-3's release. The keyboard
    // entry says a field can be scrolled into view above the keyboard, what
    // the iPad walk showed, not that the screen brings it there by itself.
    //
    // Addressed to everyone: the top bar, the greeting and the VoiceOver and
    // larger-target fixes are for every member. The pick and keyboard entries
    // link to Orders and are for whoever can pick (items:update,
    // orders:approve, where Orders is on): the digital pick's quantity is the
    // only field on an order's screen that takes typing, and only a picker is
    // offered it. The page titles entry is for every member; the unit count
    // entry for anyone who can open an order (every member, where Orders is on).
    status: 'published',
    title: "The top bar fits small screens, and the mobile app's buttons and fields are easier to use",
    summary:
      "On the web, the top bar now fits narrow screens, so your account button is never cut off, your account menu has Help & Learning, Support & feedback and the theme, and a page's title keeps its name or number on a narrow screen. In the mobile app, Home greets you by the time of day, the top-bar buttons and the Add items steppers work with VoiceOver and are easier to tap, and the digital pick's quantity shows every digit at the largest text sizes and can be scrolled above the keyboard.",
    publishedAt: '2026-09-29T15:41:00Z',
    entries: [
      {
        id: 'web-top-bar-fits',
        category: 'fixed',
        area: 'Web app',
        title: 'The top bar fits narrow screens, with your account button always in view',
        whatChanged:
          "On the web, the bar at the top of each page now fits its width. On a phone it shows the menu, the warehouse filter, notifications, What's new and your account button. With more room, such as beside the sidebar on a tablet, it adds search, then the breadcrumb, then Keyboard shortcuts, Help & Learning, Support & feedback and the theme switch. A long warehouse name is shortened to fit. Your account menu now also has Help & Learning, Support & feedback and the theme: Light, Dark or System, with the one in use marked. On Staging, the breadcrumb now reads Inventory / Staging.",
        whyItMatters:
          "On a phone the account button was cut off at the right edge, and beside the sidebar on a tablet it was off the screen entirely, with the other buttons squeezed to half their size. The breadcrumb called Staging and Labels an item's page (Items / Detail) and Recurring purchase orders a purchase order's page; each now has its own name.",
        howItAffectsYou:
          'Where the bar has room for everything, as on most laptop and desktop screens, it is unchanged. Search stays in the bar wherever it was before. Where the bar leaves the rest out, Help & Learning, Support & feedback and the theme are in your account menu, and the ? key still opens Keyboard shortcuts. On a phone held upright the breadcrumb is left out; it had no room there before either. On a short screen, such as a phone held sideways, the account menu scrolls.',
        whatToDo: 'No action needed.',
      },
      {
        id: 'web-titles-narrow-screens',
        category: 'fixed',
        area: 'Web app',
        title: "A page's title stays in view on a narrow screen",
        whatChanged:
          "On the web, the title of an order, a bundle, a maintenance request and a procedure now keeps its name or number on a phone, or beside the sidebar on a tablet. When the line is too narrow for the title and its buttons, the buttons, such as Cancel request and Report a problem on an order, move under the title.",
        whyItMatters:
          "The buttons kept their width and the title got what was left: on a phone an order's title read Or..., hiding its number, and a bundle's name did not show at all.",
        howItAffectsYou: 'On wider screens the titles and their buttons sit where they did.',
        whatToDo: 'No action needed.',
      },
      {
        id: 'phone-home-greeting',
        category: 'fixed',
        area: 'Mobile app',
        title: 'The mobile app greets you by the time of day',
        whatChanged:
          'Home in the mobile app now says Good morning before noon, Good afternoon until 5 PM and Good evening after that, by the clock on your phone. It said Good morning at every hour.',
        whyItMatters: 'The greeting was fixed text, so it was wrong for most of the day.',
        howItAffectsYou:
          'Only the greeting changed. It follows the time on your phone: it is checked again when you come back to Home or refresh it, and it changes by itself at noon, 5 PM and midnight while Home stays open.',
        whatToDo: 'Update the app when it offers the new version.',
      },
      {
        id: 'phone-buttons-voiceover-targets',
        category: 'fixed',
        area: 'Mobile app',
        title: 'Buttons in the mobile app work with VoiceOver and are easier to tap',
        whatChanged:
          "In the mobile app, the icon buttons at the top of each screen, such as Back, Open menu, Notifications, Refresh, New item and Edit item, now say what they do to VoiceOver and have a 44-point touch area around the same icon. So do Home's profile picture (Account settings), the Back links on a cycle count, the AI count review and Bundles, Refresh on Bundles, and Done and Cancel on the counting cameras. On an order's Add items sheet, the plus and minus buttons name their item, for example Increase quantity of Blue Pens, and have 44-point touch areas.",
        whyItMatters:
          "Most of these buttons had no name, so VoiceOver could not say what they did, and every item's plus and minus buttons were read the same way. Most were also smaller than the 44 points Apple recommends.",
        howItAffectsYou:
          "The buttons look the same and the icon buttons sit where they did; only the area you can tap is larger. On a cycle count, a bundle and the AI count review, the heading sits a few points lower to make room for the larger Back button. A help button that did nothing when tapped was removed from one screen, and the menu button beside it moved into its place.",
        whatToDo: 'Update the app when it offers the new version.',
      },
      {
        id: 'phone-more-voiceover-buttons',
        category: 'fixed',
        area: 'Mobile app',
        title: "More of the mobile app's controls work with VoiceOver",
        whatChanged:
          "In the mobile app, Maintenance's New, New item's Scan instead, the AI shelf scan's capture button (Capture photo) and the Staging list's All, Books and Items filters are now buttons to VoiceOver, with New read as New maintenance request and the filter in use read as selected, and the X that closes What's New and a screen tour has a 44-point touch area.",
        whyItMatters:
          'VoiceOver read these as plain text, or found no name at all for the capture button, nothing said which Staging filter was on, and the X could only be tapped within a small area around it.',
        howItAffectsYou: 'They look the same and sit where they did.',
        whatToDo: 'Update the app when it offers the new version.',
      },
      {
        id: 'phone-pick-quantity-large-text',
        category: 'fixed',
        area: 'Orders',
        title: "The digital pick's quantity shows every digit at the largest text sizes",
        whatChanged:
          "In the mobile app's digital pick, the quantity you type now stays inside its field at every text size. At the largest accessibility text sizes a typed 30 showed as 3. The field is also a 44-point touch area, and at those sizes Save moves under the field when the line is too narrow for both.",
        whyItMatters:
          'At the largest text sizes the number outgrew its field, so a quantity could not be checked before it was saved.',
        howItAffectsYou:
          'At the usual text sizes the field looks the same, a little taller. The quantity you enter and save is unchanged.',
        whatToDo: 'Update the app when it offers the new version.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { anyPermission: ['items:update', 'orders:approve'], modules: ['orders'] },
      },
      {
        id: 'phone-order-screen-keyboard',
        category: 'fixed',
        area: 'Orders',
        title: 'A field low on an order in the mobile app can be scrolled above the keyboard',
        whatChanged:
          'On an order in the mobile app, the screen now ends where the keyboard begins, so a field near the bottom, such as a pick quantity, can be scrolled into view above the keyboard while you type.',
        whyItMatters:
          'On an iPad with the keyboard docked, a pick quantity near the bottom of an order could sit under the keyboard while you typed in it, and could not be scrolled above it.',
        howItAffectsYou: 'Nothing changes until the keyboard opens.',
        whatToDo: 'Update the app when it offers the new version.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { anyPermission: ['items:update', 'orders:approve'], modules: ['orders'] },
      },
      {
        id: 'phone-order-one-unit',
        category: 'fixed',
        area: 'Orders',
        title: 'An order of one unit says 1 UNIT',
        whatChanged: 'In the mobile app, an order of one unit now says 1 UNIT above its items, not 1 UNITS.',
        whyItMatters: 'The count of units was always written in the plural.',
        howItAffectsYou: 'Only the word changed.',
        whatToDo: 'Update the app when it offers the new version.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { modules: ['orders'] },
      },
    ],
  },
  {
    id: 'reports-caller-scope-2026-09',
    revision: 1,
    // Web only (the phone's Reports has only Book Order Totals, which already
    // answered for the reader), so published with the web deploy of
    // fix/reports-scope, after migration 0380. Addressed by reports:read, the
    // permission every report page checks.
    status: 'published',
    title: 'Reports include only what you can see',
    summary:
      'On the web, Stock movements, Shrinkage, Aging & expiry, Recall / lot trace and Item cost history, on the page and in their files, now include only the items and warehouses you have access to, as the rest of StockPilot does. If you can see every warehouse and category, your figures are unchanged.',
    publishedAt: '2026-09-29T07:30:00Z',
    audience: { anyPermission: ['reports:read'] },
    entries: [
      {
        id: 'reports-caller-scope',
        category: 'fixed',
        area: 'Reports',
        title: 'Reports count only the items and warehouses you can see',
        whatChanged:
          'Stock movements, Shrinkage, Aging & expiry, Recall / lot trace and Item cost history now count and list only the items and warehouses you have access to, on the page and in their CSV and PDF files. Bundle activity shows component value and warehouse names for the warehouses you can see.',
        whyItMatters:
          'These reports used to include items and warehouses outside your access, so someone limited to some warehouses or categories could see names, SKUs and totals from the rest of the organization.',
        howItAffectsYou:
          'If you can see every warehouse and category, your figures are unchanged. If your access is limited, the totals are smaller and match what you can open elsewhere in StockPilot.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/reports', label: 'Reports' },
        audience: { anyPermission: ['reports:read'] },
      },
    ],
  },
  {
    id: 'book-order-totals-2026-09',
    revision: 1,
    // Held as a draft until the phone update (OTA group 46e8f566, the phone's
    // Book Order Totals screens) and the Demo Co production walk, as F1-3's,
    // F1-4's, F1-5's and F2-1's were. Published once 0379 was applied, the web
    // was live and the walk matched the figures SQL gave for Demo Co.
    //
    // Addressed as the report is reached: Orders on (the release), then Books
    // on with reports:read, the permission the linked page checks, for both
    // entries. The files entry is not addressed by reports:export: an
    // export-only override would be told about a page that redirects it. Its
    // text says the buttons need export access.
    status: 'published',
    title: 'See which books were ordered, with their covers',
    summary:
      'Reports has a new Book Order Totals report on the web and in the mobile app. It lists each book people asked for through Orders with its cover, the copies requested, how many orders asked for it and the latest order date, with the total across every matching book at the top. View orders shows the orders behind each total.',
    publishedAt: '2026-09-29T05:41:00Z',
    audience: { modules: ['orders'] },
    entries: [
      {
        id: 'book-order-totals-report',
        category: 'new',
        area: 'Reports',
        title: 'Book Order Totals: which books were ordered, and how many copies',
        whatChanged:
          'Reports has a Book Order Totals report. At the top are Total books ordered (copies requested through Orders), Distinct book entries and Orders containing books. Each book is listed with its cover, title, SKU and ISBN, the copies requested, the number of orders and the latest order date, 25 to a page, most copies first. View orders lists the orders behind a book. Filters narrow it by the date orders were placed, status, warehouse and category, and search finds a title, SKU or ISBN.',
        whyItMatters:
          'Finding how many copies of each book were requested meant adding up orders by hand. These totals come from the order lines themselves, so every page, search and file agrees with them.',
        howItAffectsYou:
          "The totals count copies requested, not copies purchased, handed over or in stock, from each order's saved lines and current status. By default they cover all time and every order awaiting approval, in progress, backordered or completed; denied and cancelled requests are left out unless you include them. You see only books and warehouses you have access to. How this is counted, on the report, says what the figures can and cannot show.",
        whatToDo: 'No action needed. Open Reports, then Book Order Totals.',
        link: { href: '/dashboard/reports/book-order-totals', label: 'Book Order Totals' },
        audience: { anyPermission: ['reports:read'], modules: ['books'] },
      },
      {
        id: 'book-order-totals-files',
        category: 'new',
        area: 'Reports',
        title: 'Download Book Order Totals as a CSV or PDF',
        whatChanged:
          'Book Order Totals downloads as a CSV file (data only, no covers) or as a PDF with or without covers. A file holds every book that matches the filters on screen, not only the page you are looking at, and carries its own generation time. The PDF shows covers for the first 500 books and says so; every row and total is still included.',
        whyItMatters:
          'A list of the books requested can be shared or kept without copying figures from the screen.',
        howItAffectsYou:
          'Only people who can export reports see the download buttons. When a report has more books than one file can hold, the button says so and asks you to narrow the filters; a file is never cut short. In the mobile app the files download on an iPhone; on an Android phone, export from the web for now.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/reports/book-order-totals', label: 'Book Order Totals' },
        audience: { anyPermission: ['reports:read'], modules: ['books'] },
      },
    ],
  },
  {
    id: 'order-readiness-draft-pos-2026-09',
    revision: 1,
    // The Why and the line sentence are core's words, shown by the web order
    // page and the phone's order screen alike, so this was held as a draft
    // until the phone update carried them (OTA group 46e8f566).
    //
    // Addressed as the full readiness panel is (core readinessAudience):
    // approvers, pickers (items:update) and buyers (purchase_orders:manage).
    status: 'published',
    title: 'An item on several draft POs says how many',
    summary:
      "On the web and in the mobile app, when an item on an order is on more than one draft purchase order, its readiness now says how many draft POs hold it beside their total, for example On 4 draft POs 100 (not ordered). It used to name only the first draft beside the total of all of them, so that one PO read as holding every unit.",
    publishedAt: '2026-09-29T05:40:00Z',
    audience: { modules: ['orders'] },
    entries: [
      {
        id: 'order-readiness-draft-pos-counted',
        category: 'fixed',
        area: 'Orders',
        title: 'Draft POs are counted, not named after the first',
        whatChanged:
          "When an item on an order is on several draft purchase orders, Why now says On 4 draft POs 100 (not ordered), and a short line says 4 draft POs cover 60 but have not been ordered. A single draft is still named with its own quantity, for example On draft PO-0043 25 (not ordered). Units on draft POs you can't open are shown as a quantity only, as they are for POs that have been ordered.",
        whyItMatters:
          'Why named the first draft beside the total of all the drafts, so a draft holding 25 read as holding 100.',
        howItAffectsYou: 'Only the wording changed. Drafts are still never counted as stock on order.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: {
          anyPermission: ['orders:approve', 'items:update', 'purchase_orders:manage'],
          modules: ['orders'],
        },
      },
    ],
  },
  {
    id: 'order-needed-by-org-zone-2026-09',
    revision: 1,
    // Web only: the Dates card and the approval panel's needed-by are on the
    // web order page, and the digital pick's field is the web's (the phone
    // already shows "of 60" beside a field holding the picked number). So it
    // is published with the web deploy. The phone's order screen shows no
    // needed-by time.
    //
    // Addressed where Orders is on: the order page is open to every member
    // (order_requests RLS); the digital pick entry to whoever can pick.
    status: 'published',
    title: "An order's needed-by time is shown in your organization's time zone",
    summary:
      "On the web, the needed-by time on an order's page is now shown in your organization's time zone. It was shown in UTC, hours off: an order due at 2:00 PM in a Los Angeles organization said 9:00 PM. In the digital pick, a line with nothing entered no longer shows the requested quantity in its field.",
    publishedAt: '2026-09-28T22:27:00Z',
    audience: { modules: ['orders'] },
    entries: [
      {
        id: 'order-needed-by-org-zone',
        category: 'fixed',
        area: 'Orders',
        title: "Needed-by times are in your organization's time zone",
        whatChanged:
          "On the web, the Needed by time in an order's Dates card is now shown in your organization's time zone, as is the one people who can approve orders see beside Approve on an order waiting for approval.",
        whyItMatters:
          'The Dates card showed the time in UTC, so an order in a Los Angeles organization due at 2:00 PM said 9:00 PM, and the time beside Approve could change after the page opened.',
        howItAffectsYou:
          "Only how the time is shown changed. The needed-by saved on each order is unchanged, and the other dates on the card still say how long ago each step happened.",
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { modules: ['orders'] },
      },
      {
        id: 'digital-pick-blank-quantity',
        category: 'fixed',
        area: 'Orders',
        title: 'A line with nothing entered in the digital pick looks empty',
        whatChanged:
          'On the web, in the digital pick, the quantity field of a line with nothing entered no longer shows the requested quantity in grey. The field says Qty, and the requested quantity is shown beside it, for example of 60.',
        whyItMatters:
          'The grey number looked like an entered quantity, so a line with nothing picked could look complete.',
        howItAffectsYou:
          'Only how the field looks changed. What you enter and save is the same, and completing a pick still stops first when a line is short.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { anyPermission: ['items:update', 'orders:approve'], modules: ['orders'] },
      },
    ],
  },
  {
    id: 'order-held-and-caught-2026-10',
    revision: 1,
    // F2-2 (0378). Held as a draft until the phone update (OTA group
    // ff9ac88c) and the Demo Co production walk, both done: a rolled-back hold
    // probe, one approve + add + cancel on SO-20, and the SO-7 completion
    // confirm (never completed).
    //
    // Addressed where Orders is on. The confirms are for whoever completes,
    // stages, sends out or signs for an order (items:update, orders:approve);
    // the line fixes are also on a requester's own order after picking
    // (orders:request). The holds entry is for approvers (who hold) and for
    // everyone who places orders (the storefront shows less available: the
    // behaviour change the plan says to state). Each sentence says who gets
    // what (review 2026-09-28): the fixes are for people who can change the
    // order's lines, the digital pick's Review goes to the count, and "Not
    // held" is what approvers see on the full readiness panel.
    status: 'published',
    title: 'Short lines are caught before an order leaves, and added items are held',
    summary:
      'On the web and in the mobile app, completing a pick, staging an order, sending it out for delivery and recording a signature now stop first when a line is short, and name it. When someone who can approve orders adds items to an approved order, or raises a line, the order is held straight away: the new units, and anything else on it not yet held, as far as there is free stock, so the storefront and other orders show fewer of those items available.',
    publishedAt: '2026-09-28T21:49:00Z',
    audience: { modules: ['orders'] },
    entries: [
      {
        id: 'order-short-lines-caught',
        category: 'new',
        area: 'Orders',
        title: 'Short lines are caught before an order leaves',
        whatChanged:
          "Completing a pick now stops first when a line will come up short and names it, for example: Not everything will be picked. L4L - Pen Black & Rose Gold: 0 of 60. It also says when picking can't finish until units in Staging are put away, and when stock couldn't be checked. Staging an order, marking it in transit and recording a signature, digital or on paper, from the order or from a packing slip scanned in the mobile app, also stop first when a line was not fully picked.",
        whyItMatters:
          'Mark picking complete could leave a line with nothing picked without saying so, and the order could be out for delivery minutes later with that line still missing.',
        howItAffectsYou:
          "In the digital pick, Review short lines puts you on the short line's count, to check what was entered. On the order, Review short lines and Fix the order take you to the first short line. If you can approve orders, a line that stock does not cover now, including one waiting on a PO, offers Lower to what stock covers or Remove line; after picking, a line not fully picked offers Lower to what was picked or Remove from order, if you can approve orders or it is your own order. Remove is offered only when nothing on the line was picked or handed over and it is not the order's only line.",
        whatToDo:
          "When a confirm names a short line, check the count, or lower or remove the line. You can still go ahead: what was not picked is owed at hand-over, as before. Once an order is out for delivery its lines can't be changed.",
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: {
          anyPermission: ['items:update', 'orders:approve', 'orders:request'],
          modules: ['orders'],
        },
      },
      {
        id: 'order-added-items-held',
        category: 'improved',
        area: 'Orders',
        title: 'Items added to an approved order are now held',
        whatChanged:
          "When someone who can approve orders adds items to an order that is approved or being picked, or raises a line's quantity, the new units are held for the order straight away, along with anything else on the order not yet held, as far as there is free stock, and you are told what was held and what could not be. On the order, Hold available stock holds what its lines still need, as far as stock is free: for lines added before this change, or by someone who can't approve orders.",
        whyItMatters:
          'Stock was held for an order only when it was approved, so items added afterwards were never held, and another order could take the same units first.',
        howItAffectsYou:
          "This changes what is shown as available: once they are held, the storefront and other orders show fewer of those items available. Holding never moves stock, never takes stock another order holds, and never stops an item being added. A line added or raised by someone who can't approve orders is not held until someone who can holds it: with Hold available stock, or by adding or raising a line on that order. On the order, people who can approve orders see such a line as Not held.",
        whatToDo:
          'If you can approve orders: on an approved order whose lines say Not held, or Held 20 of 40, choose Hold available stock. Otherwise, no action is needed.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { anyPermission: ['orders:approve', 'orders:request'], modules: ['orders'] },
      },
    ],
  },
  {
    id: 'maintenance-review-wording-2026-09',
    revision: 1,
    // Owner-approved wording (2026-09-28). The sentence is on the web's review
    // screen only (the phone's has no copy of it), so it is live with the web
    // deploy and published with it. The phone's back-arrow label, in the same
    // change, is not announced.
    //
    // Addressed as the review screen is reached: people who can submit a
    // maintenance request, where Maintenance requests is on.
    status: 'published',
    title: 'The maintenance review screen says when Outlook opens',
    summary:
      'On the web, the screen shown after you save a maintenance request now says that Outlook opens only when you choose Open in Outlook, and that nothing is sent until you send it. It used to read as if Outlook opened by itself.',
    publishedAt: '2026-09-28T17:45:00Z',
    audience: { anyPermission: ['maintenance_requests:submit'], modules: ['maintenance_requests'] },
    entries: [
      {
        id: 'maintenance-review-wording',
        category: 'improved',
        area: 'Maintenance',
        title: 'Outlook opens only when you choose it',
        whatChanged:
          'After you save a maintenance request on the web, the review screen now says: "Your request has been saved in StockPilot. When you choose Open in Outlook, it opens with the email details filled in; nothing is sent until you send it."',
        whyItMatters:
          'The sentence it replaces said Outlook would open with the email details filled in, which read as if Outlook opened by itself. It opens only when you choose Open in Outlook.',
        howItAffectsYou:
          'Only the wording changed. Saving a request does not open Outlook, and Open in Outlook works as before. Where your organization has not set up the maintenance email, the screen says only that your request has been saved, as before.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/maintenance/new', label: 'New maintenance request' },
        audience: { anyPermission: ['maintenance_requests:submit'], modules: ['maintenance_requests'] },
      },
    ],
  },
  {
    id: 'order-readiness-2026-09',
    revision: 1,
    // Held as a draft until the phone update (OTA group c138b401) and the
    // read-only Demo Co production walk, both done: every number on 15 orders
    // matched facts rebuilt from the raw records, on web and phone.
    //
    // Addressed where Orders is on. The full panel is for approvers, pickers
    // (items:update) and buyers (purchase_orders:manage), core
    // readinessAudience; the one sentence is for people who place orders
    // (orders:request); the gates and the note under Approve are for
    // approvers; the pick message for whoever completes picking.
    status: 'published',
    title: 'See whether an order is ready to pick',
    summary:
      "On the web and in the mobile app, an order that is still to be picked shows whether it is ready. Each line says whether its stock is ready to pick, still in Staging and waiting to be put away, waiting on a purchase order, short, or can't be confirmed, and the order says how many lines are in each state and when it was checked. People who placed an order see a short summary of its stock instead. If readiness can't be checked, the order says so rather than showing an answer.",
    publishedAt: '2026-09-28T16:50:00Z',
    audience: { modules: ['orders'] },
    entries: [
      {
        id: 'order-readiness-lines',
        category: 'new',
        area: 'Orders',
        title: 'Readiness on every line of an order',
        whatChanged:
          "An order that is waiting for approval, approved, being picked or backordered shows each line as Ready to pick, Needs put-away, Waiting on a PO, Short or Can't confirm, with a sentence such as \"6 on the shelf. 4 more are in Staging and must be put away before picking can take them.\" Why shows the numbers behind it: the stock on record, what is held for this order and for other orders, what is in Staging or in other warehouses, and what is on order. Above the lines, the order says how many lines are in each state and when it was checked.",
        whyItMatters:
          'Whether an order could be picked was only found out by checking each item or by trying to pick it, so a pick could stop because units were still in Staging.',
        howItAffectsYou:
          "Readiness is worked out each time the order is opened and is not stored, and stock can change after the time shown: choose Check again to read it again. Ready to pick is shown for the order only when every line still to be picked is ready and every number could be read; a backordered order's line that was handed over in full says Handed over. Stock in other warehouses is not counted. A purchase order's date is an expected date, not a promise, and units on a purchase order you can't open are counted without its number or date. Nothing on the order changes when readiness is shown.",
        whatToDo: 'No action needed. Open an order that is waiting for approval or being picked to see it.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: {
          anyPermission: ['orders:approve', 'items:update', 'purchase_orders:manage'],
          modules: ['orders'],
        },
      },
      {
        id: 'order-readiness-holds-and-records',
        category: 'new',
        area: 'Orders',
        title: "Holds, and records that don't match, on an order's lines",
        whatChanged:
          "On an approved order or one being picked, each line also says whether its stock is held for this order: Held for this order, Held 20 of 40, or Not held, when another order could take the stock. When the stock on record does not match what the item's locations hold, a line still to be picked says the numbers don't match and gives both.",
        whyItMatters:
          "A line that is not held can lose its stock to another order before it is picked, and when the records do not match, neither number can be relied on for picking.",
        howItAffectsYou:
          'On the web, a manager who can start counts can choose Count this item on a line whose records do not match. Showing a hold does not change it.',
        whatToDo: 'No action needed. Where the records do not match, a count settles them.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: {
          anyPermission: ['orders:approve', 'items:update', 'purchase_orders:manage'],
          modules: ['orders'],
        },
      },
      {
        id: 'order-readiness-requester',
        category: 'new',
        area: 'Orders',
        title: 'Your order says whether its items are in stock',
        whatChanged:
          "An order you placed that is still to be picked says one of: All items are in stock; Some items are waiting on stock; or We're checking stock for some items. It also says when stock was checked, with a Check again button. If stock can't be checked, it says Stock couldn't be checked just now.",
        whyItMatters: 'Whether the items on an order were available could only be learned by asking the warehouse.',
        howItAffectsYou:
          "The sentence gives no numbers and names no other orders. It is worked out when you open the order, and stock can change after that: choose Check again to read it again. It shows on orders placed from your own account, not on orders someone placed for you. If you can approve or pick orders, you see each line's readiness instead.",
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { anyPermission: ['orders:request'], modules: ['orders'] },
      },
      {
        id: 'order-stock-actions-say-why',
        category: 'improved',
        area: 'Orders',
        title: 'Approve partial and Resume fulfillment say why they are unavailable',
        whatChanged:
          "On an order waiting for approval, a note under Approve says how many lines ask for more than is available now, that Approve will be refused, and to use Approve partial or change the lines (only to change the lines when an item now belongs to another warehouse). If stock can't be checked, if an item on the order isn't visible to you, or if an item now belongs to another warehouse, Approve partial and Resume fulfillment are shown turned off with the reason. Where trying again can help, a Try again button reads the stock again.",
        whyItMatters:
          'Both actions depend on stock. On the web, a stock check that failed could stop the order page from opening. Both apps now decide these actions from the same stock check as the lines.',
        howItAffectsYou:
          'Approve still refuses an order that is short, and Approve partial and Resume fulfillment still check stock again when you use them.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { anyPermission: ['orders:approve'], modules: ['orders'] },
      },
      {
        id: 'order-pick-staging-message',
        category: 'fixed',
        area: 'Orders',
        title: 'A clearer message when picking cannot finish',
        whatChanged:
          "When Mark picking complete can't finish because the racks, crates, Sites and Unplaced hold less of an item than the pick needs, the message now says that picking never takes stock from Staging, and to put away any of it that is in Staging, or count the item if its locations don't match its stock on record, then try again. It names the order's lines with how many of each are still needed.",
        whyItMatters:
          'The old message said unplaced stock could stop a pick, but picking does take stock from Unplaced, so it sent people to move stock that was not the problem.',
        howItAffectsYou: 'Only the message changed. Picking takes stock from the same places as before.',
        whatToDo:
          "If you see this message, put the needed units away from Staging, or count the item if its locations don't match its stock on record, then choose Mark picking complete again.",
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { anyPermission: ['items:update', 'orders:approve'], modules: ['orders'] },
      },
      {
        id: 'order-line-hidden-item-name',
        category: 'fixed',
        area: 'Orders',
        title: "A line whose item you can't see says so",
        whatChanged:
          "On an order, a line whose item you don't have access to said Deleted item on the web and Unknown item in the mobile app. The web order page, its printed pick list and the mobile app's order screen now all say An item you can't see.",
        whyItMatters:
          "The item was not deleted, and items on an order can't be deleted. It is one your access doesn't include, for example an item in a warehouse you aren't assigned to, so its name isn't shown to you.",
        howItAffectsYou: 'Only the label changed. Which items you can see is unchanged.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/orders', label: 'View orders' },
        audience: { modules: ['orders'] },
      },
    ],
  },
  {
    id: 'exception-escalation-2026-09',
    revision: 1,
    // Held as a draft until the phone update (OTA group 1558a067) and the Demo
    // Co production walk (one escalation, then cancelled), both done. Every
    // sentence was checked on both platforms.
    //
    // Addressed where Maintenance requests is on, to readers of exceptions
    // (items:read, the Exceptions page's gate); the escalate entry adds
    // maintenance_requests:submit, the action's own gate.
    status: 'published',
    title: 'Escalate an exception to maintenance',
    summary:
      "On the web and in the mobile app, where your organization uses Maintenance requests, an open exception can be escalated. Escalate to maintenance opens the request form filled in from the exception, and saving it creates one maintenance request linked to the exception. Nothing is emailed when you save: the email to the maintenance team opens only if you choose it on the next screen. Escalating does not acknowledge or resolve the exception, which then shows the request's number.",
    publishedAt: '2026-09-28T08:15:00Z',
    audience: { anyPermission: ['items:read'], modules: ['maintenance_requests'] },
    entries: [
      {
        id: 'exception-escalate-to-maintenance',
        category: 'new',
        area: 'Inventory',
        title: 'Escalate an exception to maintenance',
        whatChanged:
          "An open exception has an Escalate to maintenance action. It opens the maintenance request form with a subject naming the item and its SKU, and a description saying what is wrong, where it is when the exception is at a location, and the exception's number, such as EX-000042. You can change any of it before you save. Saving creates one maintenance request linked to the exception, with the exception's item and, for a condition at a location, that location, and then shows the request.",
        whyItMatters:
          'When an exception needed the maintenance team, the request had to be written from scratch, and nothing on the exception showed that it had been passed on.',
        howItAffectsYou:
          'Nothing is emailed when you save: the email opens only if you choose it on the next screen, and you send it yourself. An exception has one request at a time. A new one can be made only if that one is cancelled, and if you can open that request, the exception links to it instead. Escalating needs a connection and is not saved to try later. It does not acknowledge or resolve the exception. Photos on the exception are not copied; you can add photos to the request after it is saved. The request notifies the same people as one made from the maintenance form.',
        whatToDo:
          'Open an exception that is still open, choose Escalate to maintenance, check the request and save it. Then, on the next screen, open the email if the maintenance team should be told.',
        link: { href: '/dashboard/exceptions', label: 'Open Exceptions' },
        audience: { anyPermission: ['maintenance_requests:submit'], modules: ['maintenance_requests'] },
      },
      {
        id: 'exception-escalated-badge',
        category: 'new',
        area: 'Inventory',
        title: 'An escalated exception shows its maintenance request',
        whatChanged:
          "An exception that was escalated shows Escalated with the request's number, such as MR-2026-000014, in the Exceptions list, on the exception, and on the open exceptions of its item's and location's pages, and its timeline records who escalated it. If the request is cancelled, everyone who can see the exception sees that, and it can be escalated again. If you can open the request, the number links to it, and the exception says whether an email draft has been opened from StockPilot for it.",
        whyItMatters:
          'Anyone looking at the exception can see that it was passed to the maintenance team, so it is not escalated twice.',
        howItAffectsYou:
          'StockPilot shows only what it records: the request, whether an email draft was opened from it, and whether it was cancelled. It does not know whether an email went out or what the maintenance team did.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/exceptions', label: 'Open Exceptions' },
        audience: { anyPermission: ['items:read'], modules: ['maintenance_requests'] },
      },
      {
        id: 'maintenance-request-related-location',
        category: 'improved',
        area: 'Maintenance',
        title: 'A request made from an exception names its location',
        whatChanged:
          'A maintenance request made from an exception at a location, such as a rack or Staging, shows that location and its warehouse on the request, and its email draft includes it as Related Location.',
        whyItMatters: 'Whoever handles the request can see where the problem is without looking up the exception.',
        howItAffectsYou:
          'When the email has to be shortened to fit, the location is the first line left out; copying the email details always includes it.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/maintenance', label: 'Open Maintenance' },
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
    id: 'maintenance-photo-details-2026-09',
    revision: 1,
    // Held as a draft until the web deploy that re-encodes maintenance photos
    // (#279) was live and a Demo Co production check showed stored photos
    // without EXIF or GPS (a phone-shaped upload was checked locally), both
    // done. Server-side only, so every app build is covered without a phone
    // update.
    status: 'published',
    title: 'Maintenance photos no longer keep location or camera details',
    summary:
      'On the web and in the mobile app, a photo added to a maintenance request is now saved without the details a phone or camera stores inside the photo file, such as where it was taken and which device took it. Photos added before this change are not changed.',
    publishedAt: '2026-09-28T08:14:00Z',
    entries: [
      {
        id: 'maintenance-photo-details',
        category: 'improved',
        area: 'Maintenance',
        title: 'Location and camera details are removed from maintenance photos',
        whatChanged:
          'When a photo is added to a maintenance request, StockPilot saves a copy without the details stored inside the photo file, such as where it was taken, which device took it and when. The small preview on the request is made from that copy.',
        whyItMatters:
          'A photo taken on a phone can record where it was taken. Anyone who could open the photo, including through a shared link to the request, could read that location.',
        howItAffectsYou:
          'This happens when the photo is saved, whichever app or browser sent it. Photos added before this change are not changed. A photo of more than 50 megapixels is now refused.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/maintenance', label: 'Open Maintenance' },
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
    id: 'exception-photos-2026-09',
    revision: 1,
    // Held as a draft until the phone update (OTA group 531e3cc0) and the Demo
    // Co production walk, both done. Every sentence was checked on both
    // platforms (the web sends no capture time, so photos added on the web
    // show only their upload time).
    status: 'published',
    title: 'Photos on exceptions',
    summary:
      'On the web and in the mobile app, an exception now has a Photos section. The people who can acknowledge an exception can add up to 8 photos to it while it is open, each with an optional note. They can remove their own photos, and managers among them can remove any. A removed photo is hidden, not deleted, and the timeline records who added or removed each photo. Location and camera details are removed from each photo when it is saved.',
    publishedAt: '2026-09-28T03:01:00Z',
    entries: [
      {
        id: 'exception-photos',
        category: 'new',
        area: 'Inventory',
        title: 'Photos on an exception',
        whatChanged:
          "An exception's page has a Photos section. Everyone who can open the exception sees its photos, each with its note, who added it and when it was uploaded, by StockPilot's clock. When the app that added a photo reports when it was taken, that time is shown too, labelled as the device's clock, because a device's clock can be wrong. The web does not report it, so a photo added on the web shows only its upload time. The timeline lists each photo added or removed, by whom, with its note or the reason it was removed.",
        whyItMatters:
          'What someone found at the shelf, such as a label naming another rack or an empty bin, could only be described in a note, so the next person looking at the exception could not see it.',
        howItAffectsYou:
          'Photos do not change stock, do not resolve an exception, and send no notifications. On a resolved exception the photos stay visible, but none can be added or removed. If the photos cannot be loaded, the section says so instead of showing none.',
        whatToDo: 'No action needed. Open an exception to see its photos.',
        link: { href: '/dashboard/exceptions', label: 'Open Exceptions' },
        audience: { anyPermission: ['items:read'] },
      },
      {
        id: 'exception-photos-add-remove',
        category: 'new',
        area: 'Inventory',
        title: 'Add and remove photos on an open exception',
        whatChanged:
          'The people who can acknowledge an exception and add notes to it, that is, those who can adjust stock in its warehouse, can add photos to it while it is open, with an optional note of up to 500 characters. An exception holds up to 8 photos, each a JPEG, PNG or WEBP of up to 10 MB. The person who added a photo, or a manager who can acknowledge the exception, can remove it, with an optional reason.',
        whyItMatters:
          'A photo shows the next person what was found, and removing one leaves a record of who removed it and why, so what an exception showed can always be traced.',
        howItAffectsYou:
          'Adding and removing photos needs a connection: photos are not saved offline to send later. Location and camera details are removed from each photo when it is saved. A removed photo no longer shows on the exception but is not deleted, and removing one makes room for another.',
        whatToDo:
          'Open an exception that is still open, type a note if you want one, and add the photo in its Photos section.',
        link: { href: '/dashboard/exceptions', label: 'Open Exceptions' },
        audience: { anyPermission: ['stock:adjust'] },
      },
    ],
  },
  {
    id: 'order-page-kits-2026-09-27',
    revision: 1,
    // Held as a draft (#275) until the web deploy and the Demo Co walk; the New
    // order page is web only. Addressed only where
    // Bundles is on: that is where kits exist. The removal of Add full kit is
    // its own release below, because the button was on every organization's
    // New order page, Bundles or not (review F7).
    //
    // Orders AND Bundles: inside one audience the modules are alternatives
    // (Orders OR Bundles), which told organizations without Bundles about
    // kits. The release names Orders and each entry names Bundles, and a
    // reader must pass both.
    status: 'published',
    title: 'Order a whole kit from the New order page in one step',
    summary:
      'When your organization uses Bundles, the New order page shows kits: bundles whose items you can all order at the chosen warehouse. Add kit puts every item of the kit into your cart as its own line, and the order is approved and picked like any other.',
    publishedAt: '2026-09-27T23:24:00Z',
    audience: { modules: ['orders'] },
    entries: [
      {
        id: 'order-page-kits',
        category: 'new',
        area: 'Orders',
        title: 'Kits on the New order page',
        whatChanged:
          'The New order page has a Kits row above Frequently ordered. It lists each active bundle whose items you can all order at the chosen warehouse, with the items it holds and how many kits are available. Add kit puts every item into your cart as its own line, and the minus and plus buttons take out or add one kit at a time. A kit also comes first when you open a category that holds one of its items, and it shows when you search for its name.',
        whyItMatters: 'Ordering a kit meant finding each of its items and adding them one at a time.',
        howItAffectsYou:
          'Kits are counted from the same available stock the item cards show. When an item of a kit is kept on more than one rack under the same SKU, the kit counts every one of those racks you can order from, except stock earmarked for a different site, so your cart can show that item on two lines, one per rack; Details on the card lists the racks. A kit goes into the cart whole or not at all: if one of its items runs out, Add kit is turned off and the card names that item.',
        whatToDo:
          'If Add kit is turned off, you can still add the kit\'s other items one by one. Kits come from Bundles, so the kits on offer change when someone who manages bundles edits them.',
        link: { href: '/dashboard/orders/new', label: 'Open New order' },
        audience: { anyPermission: ['orders:request'], modules: ['bundles'] },
      },
      {
        id: 'order-page-kit-lines',
        category: 'new',
        area: 'Orders',
        title: 'The items a kit adds are ordinary order lines',
        whatChanged:
          "Each item a kit puts in your cart is an ordinary line, and you can change or remove any of them. Adding a kit, or one kit more, never lowers or removes a line you changed; the kit may move its own units onto one rack. One kit less, or a lower count typed in, takes out one kit's worth of each item for every kit taken out, and never units you added by hand.",
        whyItMatters:
          'Approvers and pickers see the same item lines as on any order, so approval and picking work as they always have.',
        howItAffectsYou:
          "Items a bundle marks optional are not added by the kit. If you lower or remove one of a kit's lines, the card counts only the whole kits still in your cart, and adding a kit then adds only what that kit is missing. Taking a kit out then takes one kit's worth of each item, and anything left over stays in your cart as ordinary lines.",
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/orders/new', label: 'Open New order' },
        audience: { anyPermission: ['orders:request'], modules: ['bundles'] },
      },
    ],
  },
  {
    id: 'stock-on-record-wording-2026-09-27',
    revision: 1,
    // Held as a draft (#274) until the phone release, because the phone words
    // counts and exceptions with its own copy of core. Published after the web
    // deploy and the verified phone update.
    status: 'published',
    title: 'Counts and exceptions say stock on record instead of book',
    summary:
      'On the web and in the mobile app, cycle count results, the Physical count card on an item and count exceptions now say stock on record, not book, for the quantity StockPilot has recorded. For example, Book corrected from 50 to 0 (-50) now reads Stock on record corrected from 50 to 0 (-50). The Books section is unchanged.',
    publishedAt: '2026-09-27T23:23:00Z',
    entries: [
      {
        id: 'stock-on-record-wording',
        category: 'fixed',
        area: 'Inventory',
        title: 'Counts and exceptions say stock on record instead of book',
        whatChanged:
          'Cycle count results, the Physical count card on an item page, location pages and count exceptions now say stock on record where they said book. Book corrected from 50 to 0 (-50) reads Stock on record corrected from 50 to 0 (-50), Matched the book (10) reads Matched the stock on record (10), Book now: 0 reads On record now: 0, and the exception Count did not match the book is now Count did not match the stock on record. This applies on the web and in the mobile app.',
        whyItMatters:
          'Book was accounting shorthand for the quantity on record. In an organization that stocks books it read as the product, so a count result on an electronics item, such as a Chromebook, looked as if the item were a book.',
        howItAffectsYou:
          'Only the words change. The numbers, how counts are posted, and when exceptions open and clear are the same. The Books section, book racks and crates, and ISBN lookups are unchanged. In the web app, the warning shown before archiving items that still hold stock now says archiving keeps the stock on record.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/exceptions', label: 'Open Exceptions' },
        audience: { anyPermission: ['items:read'] },
      },
    ],
  },
  {
    id: 'order-page-add-full-kit-removed-2026-09-27',
    revision: 1,
    // Goes out with the kits release, after the same web deploy, to
    // everyone who can place orders, with or without Bundles: the button was
    // on the New order page of any organization with a category named like
    // "New Hire". Its words hold where Bundles is off (review F7).
    status: 'published',
    title: 'Add full kit is gone from the New order page',
    summary:
      'The Add full kit button on a category of the New order page is gone. It added one of every in-stock item in that category, whatever a kit actually held. Add the items you need one by one; where your organization uses Bundles, the New order page can also offer kits, which add exactly a bundle\'s items.',
    publishedAt: '2026-09-27T23:22:00Z',
    entries: [
      {
        id: 'order-page-add-full-kit-removed',
        category: 'improved',
        area: 'Orders',
        title: 'Add full kit is gone',
        whatChanged:
          'The Add full kit button on a category header of the New order page is gone. Adding items one at a time, from their cards or by search, works as before.',
        whyItMatters:
          'Add full kit added one of every in-stock item in the category, whatever the kit held, so an order could carry every size of an item and items nobody asked for.',
        howItAffectsYou:
          'If you used Add full kit, add the items you need one by one. Where your organization uses Bundles, the New order page can also offer kits: each adds exactly the items of one bundle.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/orders/new', label: 'Open New order' },
        audience: { anyPermission: ['orders:request'], modules: ['orders'] },
      },
    ],
  },
  {
    id: 'bundle-distribute-managers-2026-09-27',
    revision: 1,
    // Held as a draft until the web deploy and the phone update (the mobile
    // bundle screen changes too).
    status: 'published',
    title: 'Distribute on a bundle is shown only to managers and above',
    summary:
      'On the web and in the mobile app, Distribute on a bundle now appears only for managers, admins and owners who can distribute bundles. Staff were shown it, but StockPilot refuses a distribution from anyone below manager, so their attempt ended in Permission denied.',
    publishedAt: '2026-09-27T23:21:00Z',
    entries: [
      {
        id: 'bundle-distribute-managers',
        category: 'fixed',
        area: 'Bundles',
        title: 'Distribute appears only for people who can distribute',
        whatChanged:
          'The Distribute button on a bundle page on the web, and the Distribute section of a bundle in the mobile app, now appear only for managers, admins and owners who hold the permission to distribute bundles.',
        whyItMatters:
          'Staff hold that permission by default and were shown Distribute, but StockPilot refuses a distribution from anyone below manager, so a staff member who tried got Permission denied.',
        howItAffectsYou:
          'Managers, admins and owners see no change. Staff can still open a bundle and see its items and its distribution history. In the mobile app the section appears once the app has checked your role with StockPilot, which needs a connection: if the app was opened offline, it appears when you open the bundle again with a connection.',
        whatToDo: 'If you are staff and kits need to be handed out, ask a manager to distribute them.',
        link: { href: '/dashboard/bundles', label: 'Open Bundles' },
        audience: { anyPermission: ['bundles:read', 'bundles:distribute'], modules: ['bundles'] },
      },
    ],
  },
  {
    id: 'last-physical-count-and-location-pages-2026-09-27',
    revision: 1,
    // Published after the web deploy (#272), the phone update (OTA iOS
    // 01a0e41c-2dd1-7b0d-9922-98e564179015) and the Demo Co production walk.
    status: 'published',
    title: 'Item pages show the last physical count, and each location has a page',
    summary:
      'On the web and in the mobile app, an item now shows when it was last physically counted, what that count found, and how many recorded stock movements came after it, and an exception shows the same for its item. Each location in Locations now opens a page listing what is held there and when each item was last counted, with the open exceptions recorded there. When Cycle Counts is on, managers who can assign counts and adjust stock can recount the items at a location from its page.',
    publishedAt: '2026-09-27T18:48:00Z',
    entries: [
      {
        id: 'item-last-physical-count',
        category: 'new',
        area: 'Inventory',
        title: 'Last physical count on the item page',
        whatChanged:
          "The Overview tab of an item page has a Physical count card. It gives the date and number of the latest posted cycle count of the item, whether it matched the stock on record or corrected it (for example Stock on record corrected from 8 to 10 (+2)), who counted and who posted it, and whether one location was the item's only place outside Staging at the time (a rack or crate reads as its only shelf location) or the item total was counted. Below that: recorded stock movements since the count, the stock on record now, any open count holding the item, and its open exceptions.",
        whyItMatters:
          'Nothing on the item said when its stock was last counted or what had happened to it since, so finding out meant searching Cycle counts and reading the Movements tab.',
        howItAffectsYou:
          'The card describes what the count recorded at that moment; it does not say the shelf matches the stock on record now. An item that was never counted reads No physical count on record, and rental equipment and kits say they are not cycle counted. Rows written outside the stock ledger since the count are counted separately. If the card cannot load, it says so, and the rest of the page is unaffected. An exception page shows the same card for its item.',
        whatToDo:
          'No action needed. Open an item to see its last physical count, and select the movements line to see the movements since.',
        link: { href: '/dashboard/inventory', label: 'Open Items' },
        audience: { anyPermission: ['items:read'] },
      },
      {
        id: 'location-pages',
        category: 'new',
        area: 'Inventory',
        title: 'A page for each location',
        whatChanged:
          "Select a location's name on the Locations page, or the location of an exception, to open its page. It shows the location's kind and warehouse, the open exceptions recorded there, and each item held there with its units there and its last count: counted while this was its only shelf location (at Unplaced or a site, its only place outside Staging), the item total counted, or not counted. A line at the top totals every item held there, and the list shows 50 items per page.",
        whyItMatters:
          'Checking what a rack holds, and when it was last counted, meant opening each item on it one at a time.',
        howItAffectsYou:
          'Staff and viewers see stock and open exceptions at locations in their own warehouses; for a location in another warehouse the page says they are not listed. Items you cannot open are counted in the totals but not listed. When Cycle Counts is on, managers who can assign counts and adjust stock see Recount items here, which starts one cycle count of every item there that can be counted, up to 200 items. Like every count, it records each item total, wherever the item is stored.',
        whatToDo: "Open Locations and select a location's name.",
        link: { href: '/dashboard/locations', label: 'Open Locations' },
        audience: { anyPermission: ['items:read'] },
      },
    ],
  },
  {
    id: 'order-page-warehouse-switch-2026-09-26',
    revision: 1,
    status: 'published',
    title: 'The New order page places the order at the warehouse shown after a change',
    summary:
      'On the New order page, the cart stayed with the warehouse the page first opened with. After you changed warehouse, Submit was either refused with "Every line must be at the chosen warehouse" or, when every item in the cart came from the first warehouse, placed the order at that first warehouse while the page showed the other one. Each warehouse now has its own cart, and Submit places the order at the warehouse shown.',
    publishedAt: '2026-09-26T23:00:00Z',
    entries: [
      {
        id: 'order-page-warehouse-switch',
        category: 'fixed',
        area: 'Orders',
        title: "Changing warehouse on the New order page now changes the order's warehouse",
        whatChanged:
          'Changing the warehouse on the New order page now changes the cart with it. Items you add are saved with the warehouse shown, and Submit places the order at that warehouse.',
        whyItMatters:
          'The cart kept the warehouse the page first opened with, so a change of warehouse did not reach Submit. If the cart held an item from the warehouse shown, Submit was refused with "Every line must be at the chosen warehouse". If every item in the cart came from the first warehouse, Submit placed the order at that first warehouse while the page showed the other one. Items added after a change were also saved under the first warehouse, so they could appear in that warehouse\'s cart later.',
        howItAffectsYou:
          "Each warehouse keeps its own cart. Requesting for, Pickup or Delivery, the delivery site, Needed by and the notes belong to that cart, along with the items. When you change warehouse you see that warehouse's cart, or a new one that starts on Pickup with Requesting for set to Myself. Changing back brings back the first cart and its answers.",
        whatToDo:
          'If you ordered after changing warehouse, open the order and check its Warehouse. If it is wrong, cancel it while pending approval, or ask a manager, then order again. To redo a refused order, choose the warehouse you meant, add the items again and submit. If a cart opens with items you already ordered, remove them. Remove lines showing a long code, and choose the delivery site again if asked.',
        link: { href: '/dashboard/orders/new', label: 'Open New order' },
        audience: { anyPermission: ['orders:request'], modules: ['orders'] },
      },
    ],
  },
  {
    id: 'rentals-borrowers-and-emails-2026-09',
    revision: 1,
    status: 'published',
    title: 'Rental photos, borrowers outside StockPilot, and which emails a borrower gets',
    summary:
      'Each rental now shows which emails its borrower gets and whether the overdue reminder went out, and in the mobile app a rental opens its details in the app. People who check out rentals can rent to someone who is not in StockPilot by typing their name and, if they have one, their email; rental photos on the New rental page come with the page; and New rental in the mobile app can search team members.',
    publishedAt: '2026-09-25T21:00:00Z',
    entries: [
      {
        id: 'rental-photos-load-with-page',
        category: 'fixed',
        area: 'Rentals',
        title: 'Photos on the New rental page come with the page',
        whatChanged:
          'Rental item photos on the New rental page now come with the page instead of arriving after it. A photo added or replaced in the last few hours appears a moment after the page opens, once the page checks for changes.',
        whyItMatters:
          'To show a handful of rental items, the page fetched photos for every orderable item in the warehouse, up to 500, after the page had loaded.',
        howItAffectsYou: 'Nothing else about the page changes.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/rentals/new', label: 'Open New rental' },
        audience: { anyPermission: ['rentals:create'], modules: ['rentals'] },
      },
      {
        id: 'rent-to-non-members',
        category: 'improved',
        area: 'Rentals',
        title: 'Renting to someone who is not in StockPilot is easy to find',
        whatChanged:
          'On New rental, the borrower list opens with Someone not in StockPilot at the top, and Borrower email (optional) is always on screen unless you picked a team member. Type the person’s name and, if they have one, their email. A picked team member shows where their rental emails go, with a Rent to someone not in StockPilot button to switch. The list offers only members who have accepted their invitation.',
        whyItMatters:
          'The email field appeared only after a name was typed, under the open member list, so it looked as though only team members could borrow. The list also offered members who had not accepted, and checkout refused them.',
        howItAffectsYou:
          'A borrower with an email gets the checkout receipt, the return confirmation and, while Rentals is switched on in Settings, Modules, one reminder if the rental is overdue. A borrower with no email gets no emails. Emails to someone outside StockPilot carry no link into the app.',
        whatToDo:
          'Add an email when you check out to anyone who should get the receipt and reminders.',
        link: { href: '/dashboard/rentals/new', label: 'Open New rental' },
        audience: { anyPermission: ['rentals:create'], modules: ['rentals'] },
      },
      {
        id: 'rental-borrower-emails-shown',
        category: 'new',
        area: 'Rentals',
        title: 'Each rental shows which emails its borrower gets',
        whatChanged:
          'A rental’s page now has an Emails to the borrower card listing the checkout receipt, the return confirmation and the overdue reminder. For the reminder it shows when it was sent, when it will be sent, or why it will not be. The borrower section says Team member or Not linked to a StockPilot account, with the email on file. On the Rentals list, overdue rentals carry a short note such as Reminder sent, Reminder goes out, No email on file or Reminders off.',
        whyItMatters:
          'Nothing on screen said whether a borrower would hear from StockPilot, or whether an overdue reminder had gone out.',
        howItAffectsYou:
          'A reminder that fails to send is no longer shown as sent; the next daily run tries again while the rental is still out. There is still no reminder before the return date. The receipt and the return confirmation are not recorded, so the card describes when they go out rather than showing a sent time.',
        whatToDo:
          'No action needed. Overdue reminders go out only while Rentals is switched on in Settings, Modules.',
        link: { href: '/dashboard/rentals', label: 'Open Rentals' },
        audience: { anyPermission: ['rentals:read', 'rentals:create'], modules: ['rentals'] },
      },
      {
        id: 'phone-rental-detail',
        category: 'new',
        area: 'Mobile app',
        title: 'Rental details in the mobile app',
        whatChanged:
          'Tapping a rental in the mobile app now opens its details in the app: the borrower, the emails they get, the dates and the items. It used to open the web in a browser.',
        whyItMatters: 'The mobile app had no rental details screen.',
        howItAffectsYou:
          'Marking a rental returned and cancelling it are still done on the web; if you can do those, the details screen has a button that opens the rental there.',
        whatToDo: 'Update the app when it offers the new version.',
        link: { href: '/dashboard/rentals', label: 'Open Rentals' },
        audience: { anyPermission: ['rentals:read', 'rentals:create'], modules: ['rentals'] },
      },
      {
        id: 'phone-rental-member-search',
        category: 'new',
        area: 'Mobile app',
        title: 'Search team members when you check out a rental in the mobile app',
        whatChanged:
          'On New rental in the mobile app, typing a borrower’s name suggests matching team members. Picking one links the rental to their account and uses their account email. Anyone else is entered by name, with an optional email.',
        whyItMatters:
          'The mobile app could not link a rental to a team member, so every rental made on a phone was a typed name.',
        howItAffectsYou:
          'Team member search needs a connection. Without one, the screen says so, and you can still type a name and email.',
        whatToDo: 'Update the app when it offers the new version.',
        link: { href: '/dashboard/rentals/new', label: 'Open New rental' },
        audience: { anyPermission: ['rentals:create'], modules: ['rentals'] },
      },
    ],
  },
  {
    id: 'order-page-card-sizes-2026-09-25',
    revision: 1,
    status: 'published',
    title: 'Item cards on the New order page are the same size in every category',
    summary:
      'On the New order page, a category with only one, two or three items stretched its cards across the row, so one item could show a photo filling most of the screen. Every card is now the same size, whatever its category holds.',
    publishedAt: '2026-09-25T20:45:00Z',
    entries: [
      {
        id: 'order-page-card-sizes',
        category: 'fixed',
        area: 'Orders',
        title: 'No more oversized item photos on the New order page',
        whatChanged:
          'Item cards on the New order page are now the same width in every category, so a category with one, two or three items shows normal-size cards and photos.',
        whyItMatters:
          'Each category filled its row with the cards it had. A category with one item showed a single card as wide as the page, with a photo filling most of the screen, and two items each took half the row.',
        howItAffectsYou:
          'Nothing else changes. On a phone the cards are one per row, as before.',
        whatToDo: 'No action needed.',
        link: { href: '/dashboard/orders/new', label: 'Open New order' },
        audience: { anyPermission: ['orders:request'], modules: ['orders'] },
      },
    ],
  },
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
      'When a posted cycle count finds a different quantity than StockPilot had on record, Exceptions now lists it, with both numbers and the count reference. Managers can recount those items from Exceptions or an item page, on the web and in the mobile app, and the exception clears only when a later count matches the stock on record. Staff no longer see a Post button on counts they cannot post.',
    publishedAt: '2026-09-25T19:00:00Z',
    entries: [
      {
        id: 'count-variance-exceptions',
        category: 'new',
        area: 'Inventory',
        title: 'Count differences appear on Exceptions',
        whatChanged:
          'When a posted cycle count finds a different quantity than StockPilot had on record for an item, Exceptions lists it as Count did not match the stock on record, with the counted quantity, the stock on record and the count reference, for example found +1: counted 21, on record 20 (CC-000042). Only counts completed in the last 30 days open one. Rental equipment and kits are left out.',
        whyItMatters:
          'Posting a count changes the stock on record to the counted number, and nothing followed up to confirm that number before people relied on it.',
        howItAffectsYou:
          'Differences from counts posted in the last 30 days appear on the next check. An exception clears only when a later completed count of the item matches the stock on record exactly. A recount that finds another difference keeps it open with the new numbers.',
        whatToDo:
          'Open Exceptions and review the Count did not match the stock on record group.',
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
          'Pressing Recount twice starts one count, and an item already in an open count is linked to that count instead of getting a second one. Rental equipment and kits cannot be recounted this way. After the count is posted, the system checks the exception again: it resolves when the count matches the stock on record, and stays open with the new numbers when it does not.',
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
