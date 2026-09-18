'use client';

import { ArrowRight, ChevronDown } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { RELEASE_CATEGORY_LABELS, type ClientReleaseEntry } from '@stockpilot/core';

import { cn } from '@/lib/utils';

import { TOUCH_TARGET } from './constants';

const LABEL = 'text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--ed-ink-3)]';

/** Text label always; the tint is decoration, never the only signal. */
const CATEGORY_TONE: Record<ClientReleaseEntry['category'], string> = {
  new: 'border-emerald-600/30 text-emerald-700 dark:text-emerald-400',
  improved: 'border-sky-600/30 text-sky-700 dark:text-sky-400',
  fixed: 'border-border text-[var(--ed-ink-3)]',
  action: 'border-amber-600/40 text-amber-700 dark:text-amber-400',
};

/**
 * One change, answering the four questions every entry must answer.
 *
 * "What changed" and "What you need to do" are always visible: the first is the
 * news, the second is the only part that can cost someone if they miss it. "Why
 * it matters" and "How this affects you" open on request, so nine entries do not
 * arrive as a wall of text. An entry that NEEDS action starts open.
 *
 * `linkDisabledReason` replaces the link with a sentence. A tab that is one
 * version behind may not contain the feature at all, and a release that was
 * withdrawn must not send anyone anywhere.
 */
export function ReleaseEntryCard({
  entry,
  linkDisabledReason,
  onLinkClick,
}: {
  entry: ClientReleaseEntry;
  linkDisabledReason?: string | null;
  onLinkClick?: (entry: ClientReleaseEntry) => void;
}) {
  const [open, setOpen] = React.useState(entry.category === 'action');
  const detailsId = React.useId();

  return (
    <article className="bg-card rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 text-[11px] font-medium',
            CATEGORY_TONE[entry.category],
          )}
        >
          {RELEASE_CATEGORY_LABELS[entry.category]}
        </span>
        {entry.area ? <span className={LABEL}>{entry.area}</span> : null}
      </div>

      <h3 className="mt-2 text-[15px] font-semibold leading-snug tracking-tight">{entry.title}</h3>

      <div className="mt-3 space-y-3">
        <div>
          <p className={LABEL}>What changed</p>
          <p className="mt-1 text-sm leading-relaxed">{entry.whatChanged}</p>
        </div>

        <div id={detailsId} hidden={!open} className="space-y-3">
          <div>
            <p className={LABEL}>Why it matters</p>
            <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
              {entry.whyItMatters}
            </p>
          </div>
          <div>
            <p className={LABEL}>How this affects you</p>
            <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
              {entry.howItAffectsYou}
            </p>
          </div>
        </div>

        <div>
          <p className={LABEL}>What you need to do</p>
          <p className="mt-1 text-sm leading-relaxed">{entry.whatToDo}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            TOUCH_TARGET,
            'text-muted-foreground hover:text-foreground focus-visible:ring-ring -ml-1 inline-flex items-center gap-1 rounded-md px-1 text-[13px] focus-visible:outline-none focus-visible:ring-2',
          )}
        >
          <ChevronDown
            className={cn('size-3.5 transition-transform', open && 'rotate-180')}
            aria-hidden
          />
          {open ? 'Show less' : 'Why it matters and how it affects you'}
        </button>

        {entry.link ? (
          linkDisabledReason ? (
            <p className="text-[12.5px] text-[var(--ed-ink-3)]">{linkDisabledReason}</p>
          ) : (
            <Link
              href={entry.link.href}
              onClick={() => onLinkClick?.(entry)}
              className={cn(
                TOUCH_TARGET,
                'text-primary focus-visible:ring-ring inline-flex items-center gap-1 rounded-md px-1 text-[13px] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2',
              )}
            >
              {entry.link.label} <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          )
        ) : null}
      </div>
    </article>
  );
}
