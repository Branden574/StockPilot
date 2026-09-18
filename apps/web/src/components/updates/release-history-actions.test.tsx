import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const capture = vi.fn();
vi.mock('@/lib/analytics', () => ({ capture: (...a: unknown[]) => capture(...a) }));
const markReleaseRead = vi.fn(async () => true);
vi.mock('@/lib/updates/update-store', () => ({
  markReleaseRead: (...a: unknown[]) => markReleaseRead(...(a as [])),
  markAllRead: vi.fn(async () => true),
}));

import { MarkReleaseRead } from './release-history-actions';

beforeEach(() => {
  refresh.mockClear();
  capture.mockClear();
  markReleaseRead.mockClear();
});

const views = () => capture.mock.calls.filter((c) => c[0] === 'release_details_viewed');

describe('MarkReleaseRead', () => {
  it('counts ONE view for a first read, although the refresh it triggers re-runs the effect', async () => {
    const { rerender } = render(<MarkReleaseRead releaseId="sept" alreadyRead={false} />);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    // What router.refresh() does to this component: the same page, now read.
    rerender(<MarkReleaseRead releaseId="sept" alreadyRead />);
    expect(views()).toHaveLength(1);
    expect(markReleaseRead).toHaveBeenCalledTimes(1);
  });

  it('counts a view of an already-read release, and writes nothing', () => {
    render(<MarkReleaseRead releaseId="sept" alreadyRead />);
    expect(views()).toHaveLength(1);
    expect(markReleaseRead).not.toHaveBeenCalled();
  });

  it('counts a different release as its own view', () => {
    const { rerender } = render(<MarkReleaseRead releaseId="sept" alreadyRead />);
    rerender(<MarkReleaseRead releaseId="august" alreadyRead />);
    expect(views().map((c) => (c[1] as { releaseId: string }).releaseId)).toEqual([
      'sept',
      'august',
    ]);
  });
});
