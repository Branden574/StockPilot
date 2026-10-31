import * as React from 'react';

/**
 * What the keyboard can already reach inside the scroller. While any of these
 * is in it, Tab moves through them and the browser scrolls each one into view,
 * so the scroller itself stays out of the Tab order (Chrome's own rule for
 * keyboard-focusable scrollers). The selector only finds candidates;
 * `canReach` then drops the ones the keyboard cannot get to.
 */
const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type=hidden])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'details > summary:first-of-type',
  'audio[controls]',
  'video[controls]',
  'iframe',
  '[tabindex]',
  '[contenteditable]:not([contenteditable="false"])',
].join(', ');

/**
 * Whether Tab can land on a candidate: no negative tabindex, nothing inert
 * around it, not inside a closed <details> (only its summary shows), and
 * rendered and visible, so a control in a `hidden sm:table-cell` column on a
 * phone, or under [hidden], does not count. aria-hidden is not checked: Tab
 * still reaches a control under it, and the browser scrolls it into view.
 */
function canReach(el: Element): boolean {
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number.parseInt(tabindex, 10) < 0) return false;
  if (el.closest('[inert]')) return false;
  for (
    let details = el.closest('details:not([open])');
    details;
    details = details.parentElement?.closest('details:not([open])') ?? null
  ) {
    const summary = details.querySelector(':scope > summary');
    if (!summary?.contains(el)) return false;
  }
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ visibilityProperty: true });
  }
  return el.getClientRects().length > 0;
}

/** Whether the scroller holds a control the keyboard can reach. */
function hasReachableControl(el: HTMLElement): boolean {
  return Array.from(el.querySelectorAll(TABBABLE)).some(canReach);
}

/**
 * Keyboard access to a box that scrolls sideways (WCAG 2.1.1; axe
 * scrollable-region-focusable), the rule the shared Table's wrapper follows
 * (TableScroll) and the label sheet's preview with it.
 *
 * `overflows` is true while the element's content is wider than the element.
 * `stop` is true while it overflows and holds nothing the keyboard can reach
 * (no link, enabled button or field, or other tab stop that is shown and not
 * inert; a control hidden at this width does not count): the element should
 * then join the Tab order (tabIndex 0) so the arrow keys can scroll it. A
 * scroller with controls is scrolled by tabbing to them, so it needs no extra,
 * unnamed stop.
 *
 * Both are measured after mount, so the server HTML and the first client
 * render match, and again whenever the element or its first child resizes and
 * whenever that child's contents, links, disabled states or tab stops change.
 * The element must be rendered when the calling component mounts.
 */
export function useScrollStop(ref: React.RefObject<HTMLElement | null>): {
  overflows: boolean;
  stop: boolean;
} {
  const [overflows, setOverflows] = React.useState(false);
  const [hasTabbable, setHasTabbable] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      const over = el.scrollWidth > el.clientWidth;
      setOverflows(over);
      // Only an overflowing element can need the stop, so one that fits
      // skips the walk over its controls.
      setHasTabbable(over && hasReachableControl(el));
    };
    check();
    const cleanups: Array<() => void> = [];
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', check);
      cleanups.push(() => window.removeEventListener('resize', check));
    } else {
      // The element resizes with the page; its content (a table, a sheet of
      // labels) resizes when its rows or columns change. Either can start or
      // stop the sideways scroll.
      const ro = new ResizeObserver(check);
      ro.observe(el);
      if (el.firstElementChild) ro.observe(el.firstElementChild);
      cleanups.push(() => ro.disconnect());
    }
    // Rows that arrive later, or a button that turns enabled, can add or
    // remove the last control, and with it the need for the stop. A column
    // hidden at a breakpoint changes the element's width, which the resize
    // watch above already measures again.
    const content = el.firstElementChild;
    if (content && typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(check);
      mo.observe(content, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'disabled',
          'href',
          'tabindex',
          'type',
          'contenteditable',
          'controls',
          'hidden',
          'inert',
          'open',
        ],
      });
      cleanups.push(() => mo.disconnect());
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [ref]);

  return { overflows, stop: overflows && !hasTabbable };
}
