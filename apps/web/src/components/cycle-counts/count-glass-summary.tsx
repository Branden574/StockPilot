import { StatStripItem } from '@/components/patterns/stat-strip';
import { liquidGlassRollout } from '@/components/theme/appearance-flag';
import { formatNumber } from '@/lib/utils';

/**
 * What Liquid Glass adds to a cycle count's figures (Cycle-Count-Detail.dc.html,
 * the "Count summary" card): the board's fifth figure, "Lines that differ",
 * and its one wide bar of lines counted under the figures. Both are drawn
 * from the whole-count summary the page already loads (the lines card head
 * prints the same two numbers as "x of y counted · n with variance"), so
 * they read nothing new; they hold no link, button or field.
 *
 * Glass-only (data-glass-only): hidden in Classic by
 * styles/liquid-glass/visibility.css and not rendered at all under the `off`
 * rollout, so the Classic count is today's (cycle-count-detail.classic-dom
 * .test.tsx). They go into the figures' grid BETWEEN Uncounted and Net
 * variance: a hidden element still counts for :first-child and :last-child,
 * and there it changes neither for a Classic figure. pages/counts.css draws
 * the bar last, across the card (order and grid-column), and hides Classic's
 * small bar under Counted, which it replaces. Allowlisted in
 * tests/e2e/appearance/glass-only-allowlist.json (summary block, no action).
 */

/** "Lines that differ": the count's lines whose count differs from expected. */
export function CountDifferFigure({ varianceCount }: { varianceCount: number }) {
  if (liquidGlassRollout() === 'off') return null;
  return (
    <StatStripItem
      data-glass-only=""
      data-glass="count-differ"
      size="detail"
      label="Lines that differ"
      value={formatNumber(varianceCount)}
    />
  );
}

/**
 * The board's .prog under the figures: lines counted out of the items in
 * scope, as a progress bar with its value (the board's role and name). None
 * for a count with no lines.
 */
export function CountWideProgress({ counted, total }: { counted: number; total: number }) {
  if (liquidGlassRollout() === 'off' || !(total > 0)) return null;
  const pct = Math.min(100, Math.max(0, (counted / total) * 100));
  return (
    <div
      data-glass-only=""
      data-glass="count-progress"
      role="progressbar"
      aria-label="Lines counted"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={Math.min(counted, total)}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
