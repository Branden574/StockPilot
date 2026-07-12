'use client';

import { HelpCircle } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * Contextual help icon (owner PRD §6): a small "?" next to a confusing
 * label. Opens on hover AND click/tap (hover alone fails touch devices;
 * click alone hides it from mouse users), Enter/Space via the native
 * button, Esc closes via Radix. Body copy should be 1-3 sentences; use
 * `learnMoreHref` to link long-form docs or a tour
 * (`?tour=<id>` auto-offers that page's tour on arrival).
 */
export function HelpTip({
  label,
  children,
  learnMoreHref,
  learnMoreText = 'Learn more',
}: {
  /** What the tip explains — used for the accessible name. */
  label: string;
  children: React.ReactNode;
  learnMoreHref?: string;
  learnMoreText?: string;
}) {
  const [open, setOpen] = React.useState(false);
  // Hover-open must not fight tap/click-toggle: a click while hover-opened
  // would immediately re-close. Track why we opened.
  const hoverOpened = React.useRef(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`What is ${label}?`}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex shrink-0 rounded-full align-middle transition-colors focus-visible:outline-none focus-visible:ring-2"
          onMouseEnter={() => {
            if (!open) {
              hoverOpened.current = true;
              setOpen(true);
            }
          }}
          onMouseLeave={() => {
            if (hoverOpened.current) {
              hoverOpened.current = false;
              setOpen(false);
            }
          }}
          onClick={() => {
            // A click "pins" a hover-opened tip instead of toggling it shut.
            hoverOpened.current = false;
          }}
        >
          <HelpCircle className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="w-72 p-3"
        onOpenAutoFocus={(e) => {
          // Keep focus on the trigger for hover-opens; screen readers still
          // get the content announced via the popover's live region role.
          if (hoverOpened.current) e.preventDefault();
        }}
      >
        <p className="text-sm font-medium">{label}</p>
        <div className="text-muted-foreground mt-1 text-xs leading-relaxed">{children}</div>
        {learnMoreHref && (
          <Link
            href={learnMoreHref}
            className="text-primary mt-2 inline-block text-xs font-medium hover:underline"
          >
            {learnMoreText} →
          </Link>
        )}
      </PopoverContent>
    </Popover>
  );
}
