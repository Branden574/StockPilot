import type { Role } from '@stockpilot/core';

/**
 * What's New registry (owner PRD §5). Append-only: add new releases to the
 * TOP. A user sees an announcement once (viewed_announcements, mig 0259);
 * dismiss-all marks everything seen. `roles` limits who is told (never
 * announce features the viewer cannot reach); omitted = everyone.
 */
export interface Announcement {
  /** Stable slug — stored in user_onboarding.viewed_announcements. */
  id: string;
  /** ISO date of release, shown as the badge. */
  date: string;
  title: string;
  body: string;
  cta?: { href: string; label: string };
  roles?: Role[];
}

export const ANNOUNCEMENTS: Announcement[] = [
  {
    id: 'support-feedback-2026-07',
    date: '2026-07-12',
    title: 'Support & feedback, right in the app',
    body: 'Hit a bug, want a feature, or have a billing question? Open Support & feedback (workspace sidebar or the life-ring in the top bar), attach a screenshot, and send it straight to the StockPilot team — then track the status of everything you’ve submitted on the same page.',
    cta: { href: '/dashboard/support', label: 'Open Support & feedback' },
  },
  {
    id: 'onboarding-tours-2026-07',
    date: '2026-07-11',
    title: 'Interactive tours + Help center',
    body: 'Every major page now has a “Tour” pill that walks you through what everything does, and the new Help & Learning center collects tours, step-by-step workflow guides, and shortcuts in one place.',
    cta: { href: '/dashboard/help', label: 'Open Help & Learning' },
  },
  {
    id: 'schedule-reminders-2026-07',
    date: '2026-07-10',
    title: 'Needed-by dates now schedule themselves',
    body: 'Give an order a needed-by date and, on approval, a team Schedule event is created automatically — with reminders the day before and an hour ahead. You can tune reminder emails and pushes per person in notification settings.',
    cta: { href: '/dashboard/schedule', label: 'See the Schedule' },
  },
  {
    id: 'order-numbers-2026-07',
    date: '2026-07-10',
    title: 'Order numbers, everywhere',
    body: 'Orders now carry short per-organization numbers like SO-000045 — on the list, pick slips, packing slips, emails, and the Schedule — so everyone can reference the same order unambiguously.',
    cta: { href: '/dashboard/orders', label: 'View orders' },
  },
  {
    id: 'backorders-2026-07',
    date: '2026-07-09',
    title: 'Partial fulfillment & backorders',
    body: 'Short on stock? Hand over what you have — the order records fulfilled vs owed quantities and moves to Backordered until you resume fulfillment or close it. No more cancelling half-servable orders.',
    cta: { href: '/dashboard/orders?status=backordered', label: 'Backordered tab' },
    roles: ['owner', 'admin', 'manager'],
  },
];
