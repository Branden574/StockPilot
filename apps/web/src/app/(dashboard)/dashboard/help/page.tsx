import type { Metadata } from 'next';
import { BookOpen, CheckCircle2, Keyboard, Mail, Sparkles } from 'lucide-react';
import Link from 'next/link';

import { getTourStateAction } from '@/lib/onboarding/actions';
import {
  AI_TOUR,
  DASHBOARD_TOUR,
  ITEM_DETAIL_TOUR,
  ITEMS_PAGE_TOUR,
  NEW_ITEM_TOUR,
  ORDER_CREATE_TOUR,
  ORDER_DETAIL_TOUR,
  ORDERS_TOUR,
  PO_IMPORTS_TOUR,
  REPORTS_TOUR,
  SETTINGS_TOUR,
  STAGING_TOUR,
} from '@/lib/onboarding/tours';
import { TOUR_ROUTES, WORKFLOW_GUIDES } from '@/lib/onboarding/workflows';
import { SUPPORT_EMAIL } from '@/lib/site';

export const metadata: Metadata = { title: 'Help & Learning' };

const ALL_TOURS = [
  DASHBOARD_TOUR,
  ITEMS_PAGE_TOUR,
  NEW_ITEM_TOUR,
  ITEM_DETAIL_TOUR,
  STAGING_TOUR,
  ORDERS_TOUR,
  ORDER_CREATE_TOUR,
  ORDER_DETAIL_TOUR,
  PO_IMPORTS_TOUR,
  SETTINGS_TOUR,
  REPORTS_TOUR,
  AI_TOUR,
];

/**
 * Help & Learning Center (owner PRD §10): replay any tour, follow the
 * multi-page workflow guides, find shortcuts and support. Tour links carry
 * ?tour=<id> so the destination page starts its tour on arrival; tours that
 * live on per-record pages (order/item detail) are replayed from the Tour
 * pill on any record instead.
 */
export default async function HelpPage() {
  const state = await getTourStateAction();

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Help &amp; Learning</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Interactive tours, step-by-step guides, and support — learn any part of the app in
        minutes.
      </p>

      <section className="mt-8">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
          <Sparkles className="text-primary size-4" /> Page tours
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Two-minute spotlight walkthroughs of each screen. Completed tours are checked — replay
          them any time.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {ALL_TOURS.map((t) => {
            const route = TOUR_ROUTES[t.id];
            const done = state.completed[t.id];
            return (
              <div
                key={t.id}
                className="bg-card flex items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    {t.name}
                    {done && (
                      <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" aria-label="Completed" />
                    )}
                  </p>
                  <p className="text-muted-foreground text-xs">{t.steps.length} steps</p>
                </div>
                {route ? (
                  <Link
                    href={`${route}?tour=${t.id}`}
                    className="text-primary shrink-0 text-xs font-medium hover:underline"
                  >
                    Start →
                  </Link>
                ) : (
                  <span className="text-muted-foreground shrink-0 text-xs">
                    Via the Tour pill on any record
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
          <BookOpen className="text-primary size-4" /> Workflow guides
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Multi-page flows, end to end — each step links to the right screen.
        </p>
        <div className="mt-4 space-y-4">
          {WORKFLOW_GUIDES.map((g) => (
            <details key={g.id} className="bg-card group rounded-xl border p-4">
              <summary className="cursor-pointer list-none">
                <span className="text-sm font-semibold">{g.name}</span>
                <p className="text-muted-foreground mt-0.5 text-xs">{g.summary}</p>
              </summary>
              <ol className="mt-4 space-y-3 border-l pl-4">
                {g.steps.map((s, i) => (
                  <li key={i} className="relative">
                    <span className="bg-primary text-primary-foreground absolute -left-[25px] top-0.5 grid size-4 place-items-center rounded-full text-[10px] font-semibold">
                      {i + 1}
                    </span>
                    <p className="text-sm font-medium">{s.title}</p>
                    <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{s.body}</p>
                    {s.href && (
                      <Link
                        href={s.href}
                        className="text-primary mt-1 inline-block text-xs font-medium hover:underline"
                      >
                        {s.linkText ?? 'Open'} →
                      </Link>
                    )}
                  </li>
                ))}
              </ol>
            </details>
          ))}
        </div>
      </section>

      <section className="mt-10 grid gap-4 sm:grid-cols-2">
        <div className="bg-card rounded-xl border p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Keyboard className="text-primary size-4" /> Keyboard shortcuts
          </h2>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            Press <kbd className="bg-muted rounded border px-1">?</kbd> anywhere to see every
            shortcut, <kbd className="bg-muted rounded border px-1">⌘K</kbd> to search, and{' '}
            <kbd className="bg-muted rounded border px-1">g</kbd> then a letter to jump between
            sections.
          </p>
        </div>
        <div className="bg-card rounded-xl border p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Mail className="text-primary size-4" /> Still stuck?
          </h2>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            We answer fast.{' '}
            <a className="text-primary font-medium hover:underline" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>
          </p>
        </div>
      </section>
    </div>
  );
}
