import { afterEach, describe, expect, it, vi } from 'vitest';

import { findTarget } from './page-tour';

/**
 * A tour step's target (page-tour.tsx findTarget). Liquid Glass can hold two
 * twins of a target in the page with one hidden (the Reports hub: the
 * glass-only grouped tiles and Classic's list, data-classic-only), so the
 * step spotlights the match that is drawn. A hidden element has no client
 * rects; this DOM has no layout, so the test gives each element its rects.
 */

function drawn(el: Element, shown: boolean) {
  vi.spyOn(el, 'getClientRects').mockReturnValue(
    (shown ? [new DOMRect(0, 0, 10, 10)] : []) as unknown as DOMRectList,
  );
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('page tour target', () => {
  it('skips a hidden first match in the page for the drawn one after it', () => {
    document.body.innerHTML =
      '<main><a id="hidden" href="/dashboard/reports/a">A</a><a id="shown" href="/dashboard/reports/a">A</a></main>';
    drawn(document.getElementById('hidden')!, false);
    drawn(document.getElementById('shown')!, true);
    expect(findTarget('main a[href^="/dashboard/reports/"]')?.id).toBe('shown');
  });

  it('keeps the first match inside main before one outside it, both drawn', () => {
    document.body.innerHTML =
      '<nav><button id="shell" aria-label="Hide sidebar"></button></nav><main><button id="page" aria-label="Hide x"></button></main>';
    drawn(document.getElementById('shell')!, true);
    drawn(document.getElementById('page')!, true);
    expect(findTarget('button[aria-label^="Hide "]')?.id).toBe('page');
  });

  it('falls back to the first match, as before, when none is drawn', () => {
    document.body.innerHTML =
      '<nav><a id="outside" href="/x">x</a></nav><main><a id="inside" href="/x">x</a></main>';
    drawn(document.getElementById('outside')!, false);
    drawn(document.getElementById('inside')!, false);
    expect(findTarget('a[href="/x"]')?.id).toBe('inside');
  });

  it('finds nothing when nothing matches', () => {
    document.body.innerHTML = '<main></main>';
    expect(findTarget('a.none')).toBeNull();
  });
});
