/**
 * The tour state is read once per browser session per user (2026-09-22).
 *
 * Every <PageTour> used to call getTourStateAction on mount, so every page
 * view paid a Server Action (3x get_request_context + auth/v1/user +
 * user_onboarding) just to decide whether to show a "take a tour?" card,
 * while calls from our servers to Supabase stall 1-8 s at its entry point on
 * 3-5% of weekday-daytime calls. These tests pin the cache's contract:
 * one read per user, updated locally only after the server confirms an
 * outcome, never shared across users, and never keeping a failed read.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TourStateRead, TourOutcomeResult } from '@/lib/onboarding/actions';
import type { TourDefinition } from '@/lib/onboarding/types';

const h = vi.hoisted(() => ({
  getTourState: vi.fn(),
  recordOutcome: vi.fn(),
}));

vi.mock('@/lib/onboarding/actions', () => ({
  getTourStateAction: () => h.getTourState(),
  recordTourOutcomeAction: (input: unknown) => h.recordOutcome(input),
}));

vi.mock('@/lib/analytics', () => ({ capture: vi.fn() }));

import { SessionUserProvider } from '@/components/dashboard/session-user';
import { forgetTourState } from '@/lib/onboarding/tour-state-cache';

import { PageTour } from './page-tour';

const TOUR: TourDefinition = {
  id: 'items-page',
  version: 2,
  name: 'Items',
  steps: [{ title: 'Welcome', body: 'Hello' }],
};

const OFFER = 'New here? Take a quick tour.';

function readFor(userId: string, over: Partial<TourStateRead> = {}): TourStateRead {
  return { ok: true, userId, completed: {}, dismissed: {}, ...over } as TourStateRead;
}

const FAILED: TourStateRead = { ok: false, userId: null, completed: {}, dismissed: {} };

/** Mounts one page view, lets the read settle, and reports whether it offered. */
async function pageView(userId: string | null): Promise<{ offered: boolean; unmount: () => void }> {
  const ui = <PageTour tour={TOUR} />;
  const view = render(userId ? <SessionUserProvider userId={userId}>{ui}</SessionUserProvider> : ui);
  await act(async () => {});
  return { offered: screen.queryByText(OFFER) !== null, unmount: view.unmount };
}

beforeEach(() => {
  forgetTourState();
  h.getTourState.mockReset();
  h.recordOutcome.mockReset();
  h.getTourState.mockImplementation(async () => readFor('user-a'));
  h.recordOutcome.mockImplementation(
    async (): Promise<TourOutcomeResult> => ({ ok: true, userId: 'user-a' }),
  );
});

describe('PageTour tour-state reads', () => {
  it('5 page views by the same person make ONE server read', async () => {
    for (let i = 0; i < 5; i++) {
      const view = await pageView('user-a');
      expect(view.offered).toBe(true);
      view.unmount();
    }
    expect(h.getTourState).toHaveBeenCalledTimes(1);
  });

  it('an outcome the server confirmed is seen by later page views without a re-read', async () => {
    const first = await pageView('user-a');
    expect(first.offered).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'No thanks' }));
    await act(async () => {});
    expect(h.recordOutcome).toHaveBeenCalledWith({
      tourId: 'items-page',
      version: 2,
      outcome: 'dismissed',
    });
    first.unmount();

    const later = await pageView('user-a');
    expect(later.offered).toBe(false);
    expect(h.getTourState).toHaveBeenCalledTimes(1);
  });

  it('an outcome the server did NOT record is not applied locally (the tour is offered again)', async () => {
    h.recordOutcome.mockImplementation(async (): Promise<TourOutcomeResult> => ({ ok: false }));
    const first = await pageView('user-a');
    fireEvent.click(screen.getByRole('button', { name: 'No thanks' }));
    await act(async () => {});
    first.unmount();

    const later = await pageView('user-a');
    expect(later.offered).toBe(true);
    expect(h.getTourState).toHaveBeenCalledTimes(1);
  });

  it('a different user reads their own state (never the previous person\'s)', async () => {
    h.getTourState.mockImplementationOnce(async () =>
      readFor('user-a', { dismissed: { 'items-page': { v: 2 } } }),
    );
    const a = await pageView('user-a');
    expect(a.offered).toBe(false);
    a.unmount();

    h.getTourState.mockImplementationOnce(async () => readFor('user-b'));
    const b = await pageView('user-b');
    expect(b.offered).toBe(true);
    b.unmount();

    expect(h.getTourState).toHaveBeenCalledTimes(2);
  });

  it('a read the server made for a DIFFERENT user than the key is not kept', async () => {
    // Someone signed in as user-b in another tab; this tab still renders
    // user-a. Nothing may be filed under user-a from that answer.
    h.getTourState.mockImplementationOnce(async () => readFor('user-b'));
    const first = await pageView('user-a');
    expect(first.offered).toBe(false);
    first.unmount();

    await pageView('user-a');
    expect(h.getTourState).toHaveBeenCalledTimes(2);
  });

  it('a failed read offers nothing, is not kept, and is retried on the next page view', async () => {
    h.getTourState.mockImplementationOnce(async () => FAILED);
    const first = await pageView('user-a');
    expect(first.offered).toBe(false);
    first.unmount();

    const second = await pageView('user-a');
    expect(second.offered).toBe(true);
    expect(h.getTourState).toHaveBeenCalledTimes(2);

    // Now that a read worked, it is kept.
    second.unmount();
    await pageView('user-a');
    expect(h.getTourState).toHaveBeenCalledTimes(2);
  });

  it('a REJECTED read (network, a tab one deployment behind) is observed, not kept, and retried', async () => {
    h.getTourState.mockImplementationOnce(async () => {
      throw new Error('Failed to find Server Action');
    });
    const first = await pageView('user-a');
    expect(first.offered).toBe(false);
    first.unmount();

    const second = await pageView('user-a');
    expect(second.offered).toBe(true);
    expect(h.getTourState).toHaveBeenCalledTimes(2);
  });

  it('sign-out (forgetTourState) makes the next page view read again', async () => {
    const first = await pageView('user-a');
    first.unmount();
    forgetTourState();
    await pageView('user-a');
    expect(h.getTourState).toHaveBeenCalledTimes(2);
  });

  it('outside the dashboard shell (no user to key by) nothing is cached', async () => {
    const first = await pageView(null);
    expect(first.offered).toBe(true);
    first.unmount();
    await pageView(null);
    expect(h.getTourState).toHaveBeenCalledTimes(2);
  });
});
