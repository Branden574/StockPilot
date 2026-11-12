import { Fragment } from 'react';

import { liquidGlassRollout } from '@/components/theme/appearance-flag';

/**
 * A return's progress as Liquid Glass draws it under the page head
 * (Return-Detail.dc.html, the "Return progress" steps: Requested, Approved,
 * Received, Processed). The steps before the return's status are done (a
 * check), its status is the current step (aria-current="step"), the rest are
 * to come; a closed return has every step done. A denied or cancelled return
 * has no rail: the board draws none for it, and its status badge says it.
 *
 * Words and marks only, from the return's own status, which the workbench
 * already has: no link, button or field, nothing read. Glass-only
 * (data-glass-only): hidden in Classic by styles/liquid-glass/visibility.css
 * and not rendered at all under the `off` rollout, so the Classic workbench is
 * today's (return-workbench.classic-dom.test.tsx). It goes between the page
 * head and the Next step card, where it changes no Classic element's place
 * among its siblings. Styled by styles/liquid-glass/pages/returns.css;
 * allowlisted in tests/e2e/appearance/glass-only-allowlist.json (summary
 * block, no action).
 */

const STEPS = ['Requested', 'Approved', 'Received', 'Processed'] as const;

/** The status each step stands for, in order (the board's own order). */
const STATUS_ORDER = ['requested', 'approved', 'received', 'closed'] as const;

export function ReturnProgressRail({ status }: { status: string }) {
  if (liquidGlassRollout() === 'off') return null;
  const at = (STATUS_ORDER as readonly string[]).indexOf(status);
  if (at < 0) return null;
  const closed = status === 'closed';
  return (
    <ol data-glass-only="" data-glass="return-rail" aria-label="Return progress">
      {STEPS.map((label, i) => {
        const state = closed || i < at ? 'done' : i === at ? 'now' : 'todo';
        return (
          <Fragment key={label}>
            {/* The board's line between two steps (.step-sep), a list item
                of its own so the list holds only items; hidden from
                assistive technology, so the list reads as its four steps. */}
            {i > 0 ? <li aria-hidden="true" data-glass="return-step-sep" /> : null}
            <li data-state={state} aria-current={state === 'now' ? 'step' : undefined}>
              <span aria-hidden="true" data-glass="return-step-mark">
                {state === 'done' ? '✓' : String(i + 1)}
              </span>
              {label}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
