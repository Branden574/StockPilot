import Link from 'next/link';

import {
  describeReadinessHold,
  describeReadinessLine,
  describeReadinessWhy,
  READINESS_STATES,
  readinessLineAccessibilityLabel,
  type ReadinessItemAssessment,
  type ReadinessLineAssessment,
} from '@stockpilot/core';

import { CountThisItemButton } from '@/components/exceptions/count-this-item-button';
import { cn } from '@/lib/utils';

import { READINESS_TONE_STYLES, ReadinessIcon } from './readiness-view';

/** Where the item page's Physical count card (F1-3) is. */
export function itemPhysicalCountHref(itemId: string): string {
  return `/dashboard/inventory/${itemId}#physical-count`;
}

/**
 * One line's readiness on the order page (F2-1): a chip (words and an icon,
 * never colour alone), one sentence, the hold annotation at hold statuses, and
 * an expandable "Why" with the numbers behind it.
 *
 * A server component: every word comes from core readiness-copy (the phone
 * shows the same), and "Why" is a native <details>, so opening it needs no
 * script. `line` is null when the line was added after readiness was read: it
 * is not checked, and says so.
 *
 * `canCountItem` is the item page's "Count this item" rule for this viewer and
 * item (a manager who can start a count, an item a count can include); the
 * button shows only where on record and the locations disagree, the one state
 * a count settles.
 */
export function ReadinessLineCell({
  line,
  item,
  timeZone,
  canCountItem,
}: {
  line: ReadinessLineAssessment | null;
  item: ReadinessItemAssessment | null;
  timeZone: string;
  canCountItem: boolean;
}) {
  if (!line) {
    return (
      <p className="text-muted-foreground text-[11px]" data-testid="readiness-line-unchecked">
        Not checked. Check again to see this line.
      </p>
    );
  }
  const meta = READINESS_STATES[line.state];
  const tone = READINESS_TONE_STYLES[meta.tone];
  const sentence = describeReadinessLine(line, item, { timeZone });
  const hold = describeReadinessHold(line.hold);
  const visible = Boolean(item?.visible && item.facts);
  const why = visible && item ? describeReadinessWhy(item, { timeZone }) : null;
  const linkItem = visible && item?.blocked !== 'item_deleted';
  const showCount = canCountItem && line.reasons.includes('records_disagree');

  return (
    <div className="space-y-1" data-testid="readiness-line" data-state={line.state}>
      <span className="sr-only">{readinessLineAccessibilityLabel(line)}.</span>
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium',
          tone.chip,
        )}
        aria-hidden
        data-testid="readiness-chip"
      >
        <ReadinessIcon icon={meta.icon} className="size-3 shrink-0" />
        {meta.label}
      </span>
      <p
        className="text-muted-foreground text-[11px] leading-snug"
        data-testid="readiness-sentence"
      >
        {sentence}
      </p>
      {hold && (
        <p
          className={cn(
            'text-[10.5px] leading-snug',
            line.hold?.state === 'held'
              ? 'text-muted-foreground'
              : READINESS_TONE_STYLES.warning.text,
          )}
          data-testid="readiness-hold"
        >
          {hold}
        </p>
      )}
      {showCount && item && (
        <div data-testid="readiness-count-this-item">
          <CountThisItemButton itemId={item.itemId} timeZone={timeZone} />
        </div>
      )}
      {why && (
        <details className="group text-[10.5px]" data-testid="readiness-why">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer select-none underline-offset-2 hover:underline">
            Why
          </summary>
          <ul className="text-muted-foreground mt-1 space-y-0.5 tabular-nums">
            {why.parts.map((part, i) => (
              <li key={i}>{part}</li>
            ))}
          </ul>
          {linkItem && item && (
            <Link
              href={itemPhysicalCountHref(item.itemId)}
              className="mt-1 inline-block font-medium underline-offset-2 hover:underline"
              data-testid="readiness-last-count"
            >
              Last physical count
            </Link>
          )}
        </details>
      )}
    </div>
  );
}
