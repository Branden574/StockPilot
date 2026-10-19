'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The settings page body and panel (P-SET) for the requests and email, data
 * safety and connections pages (P4.G2).
 *
 * SAME LOOK AND PROPS AS P4.G1's `SettingsPage` / `SettingsPanel` in
 * `settings-nav.tsx`, which is not in this package's base: once both have
 * merged, these pages can import those instead and this file can go (the
 * classes and props match one for one).
 */

/**
 * A settings page's column: the dashboard gutters (16 px on phones, 32 px from
 * sm), 28 px above the header, 64 px below the last panel, panels 16 px apart.
 * `form` pages read at 880 px at most; `wide` (tables) at 1120 px.
 */
export function SettingsPage({
  width = 'form',
  className,
  children,
}: {
  width?: 'form' | 'wide';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-slot="settings-page"
      className={cn(
        'flex w-full min-w-0 flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7',
        width === 'form' ? 'max-w-[944px]' : 'max-w-[1184px]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface SettingsPanelProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right side of the header: a badge, a status, a small button. */
  aside?: React.ReactNode;
  /** `danger`: a destructive card (destructive edge and title). */
  tone?: 'default' | 'danger';
  /** Rows that bring their own padding (lists, tables). */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: React.ReactNode;
}

/**
 * One settings card: the elevated surface with a hairline and radius 8, a
 * 14 x 18 header (title as an h2 under the page's h1, the card's own
 * explanation under it) and an 18 px body. Each card keeps its own Save.
 */
export function SettingsPanel({
  title,
  description,
  aside,
  tone = 'default',
  flush = false,
  className,
  bodyClassName,
  children,
}: SettingsPanelProps) {
  const headingId = React.useId();
  return (
    <section
      data-slot="settings-panel"
      aria-labelledby={headingId}
      className={cn(
        'bg-card text-card-foreground min-w-0 rounded-lg border',
        tone === 'danger' && 'border-destructive/40',
        className,
      )}
    >
      <div className="border-border flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b px-[18px] py-3.5">
        <div className="min-w-0 flex-1">
          <h2
            id={headingId}
            className={cn(
              'text-[13.5px] font-medium leading-5',
              tone === 'danger' ? 'text-destructive' : 'text-foreground',
            )}
          >
            {title}
          </h2>
          {description != null ? (
            <div className="text-muted-foreground mt-0.5 text-[12.5px] leading-[18px]">
              {description}
            </div>
          ) : null}
        </div>
        {aside}
      </div>
      {children != null ? (
        <div className={cn(flush ? null : 'p-[18px]', bodyClassName)}>{children}</div>
      ) : null}
    </section>
  );
}
