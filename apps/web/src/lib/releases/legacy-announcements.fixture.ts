/**
 * FROZEN 2026-09-18. The six announcements exactly as they shipped before the
 * release registry replaced lib/onboarding/announcements.ts as the source of
 * truth. registry.test.ts compares against this so that moving them could not
 * change a character. Their ids are the keys of every user's seen-state on web
 * AND mobile (user_onboarding.viewed_announcements): renaming one re-announces
 * it to everybody, and old mobile builds render title/body/cta verbatim.
 *
 * Do not edit. Do not add to it: new releases are not legacy.
 */
export const LEGACY_ANNOUNCEMENTS = [
  {
    "id": "maintenance-requests-2026-08",
    "date": "2026-08-06",
    "title": "Maintenance requests",
    "body": "Report facilities and equipment issues from StockPilot. Your request is saved with a request number, and StockPilot prepares the complete Outlook email for you to review and send.",
    "href": "/dashboard/maintenance",
    "label": "Report an issue"
  },
  {
    "id": "support-feedback-2026-07",
    "date": "2026-07-12",
    "title": "Support & feedback, right in the app",
    "body": "Hit a bug, want a feature, or have a billing question? Open Support & feedback (workspace sidebar or the life-ring in the top bar), attach a screenshot, and send it straight to the StockPilot team — then track the status of everything you’ve submitted on the same page.",
    "href": "/dashboard/support",
    "label": "Open Support & feedback"
  },
  {
    "id": "onboarding-tours-2026-07",
    "date": "2026-07-11",
    "title": "Interactive tours + Help center",
    "body": "Every major page now has a “Tour” pill that walks you through what everything does, and the new Help & Learning center collects tours, step-by-step workflow guides, and shortcuts in one place.",
    "href": "/dashboard/help",
    "label": "Open Help & Learning"
  },
  {
    "id": "schedule-reminders-2026-07",
    "date": "2026-07-10",
    "title": "Needed-by dates now schedule themselves",
    "body": "Give an order a needed-by date and, on approval, a team Schedule event is created automatically — with reminders the day before and an hour ahead. You can tune reminder emails and pushes per person in notification settings.",
    "href": "/dashboard/schedule",
    "label": "See the Schedule"
  },
  {
    "id": "order-numbers-2026-07",
    "date": "2026-07-10",
    "title": "Order numbers, everywhere",
    "body": "Orders now carry short per-organization numbers like SO-000045 — on the list, pick slips, packing slips, emails, and the Schedule — so everyone can reference the same order unambiguously.",
    "href": "/dashboard/orders",
    "label": "View orders"
  },
  {
    "id": "backorders-2026-07",
    "date": "2026-07-09",
    "title": "Partial fulfillment & backorders",
    "body": "Short on stock? Hand over what you have — the order records fulfilled vs owed quantities and moves to Backordered until you resume fulfillment or close it. No more cancelling half-servable orders.",
    "href": "/dashboard/orders?status=backordered",
    "label": "Backordered tab"
  }
] as const;
