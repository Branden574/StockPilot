import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pathnameRef = { value: '/dashboard/inventory' };
vi.mock('next/navigation', () => ({ usePathname: () => pathnameRef.value }));

import { NavProgressBar } from './nav-progress-bar';

const BAR = 'div[aria-hidden="true"].pointer-events-none.fixed';

function clickLinkTo(href: string) {
  const link = document.createElement('a');
  link.setAttribute('href', href);
  document.body.appendChild(link);
  fireEvent.click(link);
  link.remove();
}

describe('NavProgressBar leaves the page when the navigation is over', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pathnameRef.value = '/dashboard/inventory';
    window.history.replaceState(null, '', '/dashboard/inventory');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is not rendered before any click', () => {
    render(<NavProgressBar />);
    expect(document.querySelector(BAR)).toBeNull();
  });

  it('REGRESSION: unmounts 250 ms after the route changes, instead of staying in its faded state forever', () => {
    const view = render(<NavProgressBar />);
    clickLinkTo('/dashboard');
    expect(document.querySelector(BAR)).not.toBeNull();

    pathnameRef.value = '/dashboard';
    view.rerender(<NavProgressBar />);
    // Completing: still there, playing its 240 ms fade.
    expect(document.querySelector(`${BAR} > div`)?.className).toContain('nav-progress-complete');

    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(document.querySelector(BAR)).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    // Under prefers-reduced-motion the fade is disabled, so a bar that stays
    // mounted is a full-width loading bar that never goes away.
    expect(document.querySelector(BAR)).toBeNull();
  });

  it('can start again after it has gone', () => {
    const view = render(<NavProgressBar />);
    clickLinkTo('/dashboard');
    pathnameRef.value = '/dashboard';
    view.rerender(<NavProgressBar />);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector(BAR)).toBeNull();

    window.history.replaceState(null, '', '/dashboard');
    clickLinkTo('/dashboard/orders');
    expect(document.querySelector(`${BAR} > div`)?.className).toContain('nav-progress-climb');
  });

  it('still gives up after 8 s when the navigation never lands', () => {
    render(<NavProgressBar />);
    clickLinkTo('/dashboard');
    act(() => {
      vi.advanceTimersByTime(8001);
    });
    expect(document.querySelector(BAR)).toBeNull();
  });
});
