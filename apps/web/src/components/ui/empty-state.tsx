import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';

import { StatePanel } from '@/components/patterns/state-panel';
import { Button } from '@/components/ui/button';

export interface EmptyStateProps {
  /**
   * Lucide icon shown in a soft circular badge at the top of the empty
   * state. Required — every empty state should have one to ground the
   * page visually instead of rendering a flat block of text.
   */
  icon: LucideIcon;
  /** Short headline. 3-6 words. */
  title: string;
  /** One sentence: why is this empty + what to do next. */
  description: string;
  /**
   * Primary call to action. Rendered as a real `<Link>` (via
   * `<Button asChild>`) so it's a navigable href, not a JS handler.
   * Omit for filter-empty states where there's nothing to "do" except
   * clear filters.
   */
  cta?: {
    label: string;
    href: string;
  };
  /**
   * An action that is NOT a navigation — a button that runs something and stays
   * on the page. Used where the way out of an empty state is clearing a stored
   * preference rather than going somewhere. Rendered instead of `cta`.
   */
  action?: React.ReactNode;
  /**
   * `sm` is for empty states tucked inside a smaller card (~200px tall),
   * `md` is for a list's or a page's empty state (~320px tall). Defaults to `md`.
   */
  size?: 'sm' | 'md';
  /** Optional extra classes if a caller needs to tweak spacing. */
  className?: string;
}

/**
 * The words that say a list is filtered: a title or sentence about what did
 * not match ("No items match your search", "No matches", "Nothing matched"),
 * or one that names the filter ("This view is filtered to North", "Clear the
 * filter to see all books", "Nothing found for the current filters"). A
 * passing mention ("reports, filters, and dashboards") is not one.
 */
const NO_MATCH_WORDS =
  /\bmatch(?:es|ed|ing)?\b|\bfiltered\b|\b(?:clear(?:ing)?(?: the)?|current|these) filters?\b/i;

/**
 * Every call site's own empty state, drawn as P2.6's StatePanel (the one look
 * for an empty or no-match list, PLAN P2.2 "One look per pattern").
 *
 * The props, the words, the h3 title, the description paragraph, the CTA
 * link and the `action` slot are unchanged, so no call site changes. The
 * panel's kind is `no-match` only where the call site's own title or
 * description says the list is filtered, and `empty` everywhere else; the
 * call site's icon is always the one shown, so the kind is the
 * `data-state-kind` hook and never adds or changes a word.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  cta,
  size = 'md',
  className,
}: EmptyStateProps) {
  const isSm = size === 'sm';
  return (
    <StatePanel
      kind={NO_MATCH_WORDS.test(`${title}\n${description}`) ? 'no-match' : 'empty'}
      icon={icon}
      headingLevel={3}
      size={size}
      title={title}
      description={<p>{description}</p>}
      action={
        action ? (
          action
        ) : cta ? (
          // The flat accent primary (the `gradient` variant's name is kept).
          <Button asChild variant="gradient" size={isSm ? 'sm' : 'default'}>
            <Link href={cta.href}>{cta.label}</Link>
          </Button>
        ) : null
      }
      className={className}
    />
  );
}
