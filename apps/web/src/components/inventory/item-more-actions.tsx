'use client';

import { MoreHorizontal } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { liquidGlassRollout } from '@/components/theme/appearance-flag';

/** The button's accessible name, the board's own words (Item-Detail.dc.html .acts). */
export const ITEM_MORE_ACTIONS_NAME = 'More actions';

/**
 * The item page's "More actions" button, the way Liquid Glass draws the
 * page head (Item-Detail.dc.html .acts: Transfer, Adjust, Edit and a More
 * button). It is a DISCLOSURE, not a menu of its own: it holds no action. The
 * page's classic actions stay where they are, every one in the tour's
 * [data-tour="item-actions"] row, rendered once with its own gate and dialog;
 * glass shows the three the board names (Edit, Adjust stock, Transfer, each
 * carrying an inert data-glass-action hook) and hides the rest
 * (Duplicate, Label, Print label, Count this item, Report a problem) until
 * this button is pressed. Pressed, it shows them in the same row, in their
 * DOM order, so the keyboard order is the order on screen; pressed again, it
 * hides them. It never closes on its own, so a dialog opened from one of the
 * revealed actions returns focus to a trigger that is still on screen.
 * styles/liquid-glass/pages/item-detail.css reads its aria-expanded.
 *
 * Glass-only (tests/e2e/appearance/glass-only-allowlist.json, "disclosure of
 * classic actions (no action)"): hidden in Classic by visibility.css and not
 * rendered at all under the `off` rollout. In the page head it sits after the
 * title and actions row and before the tab strip, as a <span> among <div>s,
 * so no Classic element changes its place among its siblings.
 */
export function ItemMoreActions() {
  const [open, setOpen] = React.useState(false);
  if (liquidGlassRollout() === 'off') return null;
  return (
    <span data-glass-only="" data-glass="item-more">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={ITEM_MORE_ACTIONS_NAME}
        title={ITEM_MORE_ACTIONS_NAME}
        aria-expanded={open}
        data-glass-state={open ? 'open' : 'closed'}
        onClick={() => setOpen((was) => !was)}
      >
        <MoreHorizontal aria-hidden="true" />
      </Button>
    </span>
  );
}
