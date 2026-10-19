import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ReturnWorkbenchLoading from './loading';

/**
 * The RMA workbench's loading skeleton (redesign P4.B3) is drawn in the
 * workbench's own shape: the header, the next-step bar, one RETURNING card
 * and the history card.
 */
describe('RMA workbench loading skeleton', () => {
  it('draws grey bars only: no words or numbers to misread as data', () => {
    const { container } = render(<ReturnWorkbenchLoading />);
    expect(container.textContent).toBe('');
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('draws the header, the next-step bar, a returning card and the history, in that order', () => {
    const { container } = render(<ReturnWorkbenchLoading />);
    const parts = Array.from(container.querySelectorAll('[data-slot^="workbench-loading-"]')).map(
      (el) => el.getAttribute('data-slot'),
    );
    expect(parts).toEqual([
      'workbench-loading-header',
      'workbench-loading-next-step',
      'workbench-loading-returning',
      'workbench-loading-history',
    ]);
  });
});
