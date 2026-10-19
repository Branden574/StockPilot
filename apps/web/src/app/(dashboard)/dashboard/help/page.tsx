import type { Metadata } from 'next';
import {
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Gift,
  Keyboard,
  Mail,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import type * as React from 'react';

import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader } from '@/components/patterns/page-header';
import { touchTargetClass } from '@/components/patterns/touch-target';
import { getTourStateAction } from '@/lib/onboarding/actions';
import {
  AI_TOUR,
  DASHBOARD_TOUR,
  ITEM_DETAIL_TOUR,
  ITEMS_PAGE_TOUR,
  MAINTENANCE_REQUESTS_TOUR,
  NAV_SETTINGS_TOUR,
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
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Help & Learning' };

/** Exported for registry tests only (Task 23) — pins that a tour defined in
 *  lib/onboarding/tours.ts was actually wired into Help & Learning's replay
 *  list, not just left orphaned there. Next.js ignores non-reserved named
 *  exports from a page module, so this adds no route behavior. */
export const ALL_TOURS = [
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
  NAV_SETTINGS_TOUR,
  REPORTS_TOUR,
  AI_TOUR,
  MAINTENANCE_REQUESTS_TOUR,
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
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        title="Help & Learning"
        subline="Interactive tours, step-by-step guides, and support — learn any part of the app in minutes."
      />

      <DetailSection title={<SectionTitle icon={Sparkles}>Page tours</SectionTitle>} flush>
        <p className="text-muted-foreground border-border border-b px-[18px] py-3 text-[13px] leading-[19.5px]">
          Two-minute spotlight walkthroughs of each screen. Completed tours are checked — replay
          them any time.
        </p>
        <ul className="grid sm:grid-cols-2">
          {ALL_TOURS.map((t) => {
            const route = TOUR_ROUTES[t.id];
            const done = state.completed[t.id];
            return (
              <li
                key={t.id}
                data-tour-id={t.id}
                className="border-border flex min-h-[60px] items-center justify-between gap-3 border-b px-[18px] py-2.5 last:border-b-0 sm:[&:nth-child(odd)]:border-r sm:[&:nth-last-child(2):nth-child(odd)]:border-b-0"
              >
                <div className="min-w-0">
                  <p className="text-foreground flex items-center gap-1.5 text-[13.5px] font-medium leading-5">
                    {t.name}
                    {done && (
                      <CheckCircle2
                        className="text-accent size-3.5 shrink-0"
                        aria-label="Completed"
                      />
                    )}
                  </p>
                  <p className="text-muted-foreground text-[12px] leading-[18px]">
                    {t.steps.length} steps
                  </p>
                </div>
                {route ? (
                  <Link
                    href={`${route}?tour=${t.id}`}
                    className={cn(
                      'text-accent hover:text-foreground shrink-0 text-[12.5px] font-medium transition-colors',
                      touchTargetClass,
                    )}
                  >
                    Start →
                  </Link>
                ) : (
                  <span className="text-muted-foreground max-w-[45%] shrink-0 text-right text-[12px] leading-[18px]">
                    Via the Tour pill on any record
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </DetailSection>

      <DetailSection title={<SectionTitle icon={BookOpen}>Workflow guides</SectionTitle>} flush>
        <p className="text-muted-foreground border-border border-b px-[18px] py-3 text-[13px] leading-[19.5px]">
          Multi-page flows, end to end — each step links to the right screen.
        </p>
        <div>
          {WORKFLOW_GUIDES.map((g) => (
            <details key={g.id} className="border-border group border-b last:border-b-0">
              <summary className="hover:bg-muted focus-visible:ring-ring flex cursor-pointer list-none items-start gap-3 px-[18px] py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  aria-hidden
                  className="text-muted-foreground mt-0.5 size-4 shrink-0 transition-transform group-open:rotate-90"
                  strokeWidth={1.8}
                />
                <span className="min-w-0">
                  <span className="text-foreground block text-[13.5px] font-medium leading-5">
                    {g.name}
                  </span>
                  <span className="text-muted-foreground mt-0.5 block text-[12.5px] leading-[18.75px]">
                    {g.summary}
                  </span>
                </span>
              </summary>
              <ol className="border-border mb-4 ml-[45px] mr-[18px] mt-1 space-y-3 border-l pl-5">
                {g.steps.map((s, i) => (
                  <li key={i} className="relative">
                    <span className="bg-primary text-primary-foreground absolute -left-[30px] top-0.5 grid size-[18px] place-items-center rounded-full font-mono text-[10px] font-medium">
                      {i + 1}
                    </span>
                    <p className="text-foreground text-[13.5px] font-medium leading-5">{s.title}</p>
                    <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-[18.75px]">
                      {s.body}
                    </p>
                    {s.href && (
                      <Link
                        href={s.href}
                        className={cn(
                          'text-accent hover:text-foreground mt-1 inline-block text-[12.5px] font-medium transition-colors',
                          touchTargetClass,
                        )}
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
      </DetailSection>

      {/* What's new used to be listed here by mapping the raw registry, with NO
          audience filter, so copy about features a viewer could not reach was
          rendered to every role. The history page filters on the server. */}
      <DetailSection title={<SectionTitle icon={Gift}>What&apos;s new</SectionTitle>} flush>
        <Link
          href="/dashboard/whats-new"
          className="hover:bg-muted flex items-center justify-between gap-3 px-[18px] py-3 transition-colors focus-visible:ring-inset focus-visible:ring-offset-0"
        >
          <span className="min-w-0">
            <span className="text-foreground block text-[13.5px] font-medium leading-5">
              Release history
            </span>
            <span className="text-muted-foreground mt-0.5 block text-[12.5px] leading-[18.75px]">
              Every StockPilot release, what changed, and what it means for your work.
            </span>
          </span>
          <span className="text-accent shrink-0 text-[12.5px] font-medium">Open →</span>
        </Link>
      </DetailSection>

      <div className="grid gap-4 sm:grid-cols-2">
        <DetailSection title={<SectionTitle icon={Keyboard}>Keyboard shortcuts</SectionTitle>}>
          <p className="text-muted-foreground text-[13px] leading-[19.5px]">
            Press <Kbd>?</Kbd> anywhere to see every shortcut, <Kbd>⌘K</Kbd> to search, and{' '}
            <Kbd>g</Kbd> then a letter to jump between sections.
          </p>
        </DetailSection>
        <DetailSection title={<SectionTitle icon={Mail}>Still stuck?</SectionTitle>}>
          <p className="text-muted-foreground text-[13px] leading-[19.5px]">
            We answer fast.{' '}
            <a
              className="text-accent hover:text-foreground font-medium underline-offset-2 transition-colors hover:underline"
              href={`mailto:${SUPPORT_EMAIL}`}
            >
              {SUPPORT_EMAIL}
            </a>
          </p>
        </DetailSection>
      </div>
    </div>
  );
}

/** A card title with its 14 px icon (the icon is decoration; the words name the card). */
function SectionTitle({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden strokeWidth={1.8} />
      {children}
    </span>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="bg-sunk border-line-strong text-foreground rounded border px-1 font-mono text-[11.5px]">
      {children}
    </kbd>
  );
}
