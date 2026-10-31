import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/procedures', () => ({
  createProcedureCommentAction: vi.fn(async () => ({ ok: true, data: {} })),
  updateProcedureCommentAction: vi.fn(async () => ({ ok: true, data: {} })),
  deleteProcedureCommentAction: vi.fn(async () => ({ ok: true, data: undefined })),
}));

import { CommentComposer } from './comment-composer';
import { CommentThread, type CommentView } from './comment-thread';

function comment(overrides: Partial<CommentView> = {}): CommentView {
  return {
    id: 'c1',
    procedure_id: 'p1',
    body: 'Remember to photograph damaged cartons.',
    author: { id: 'u1', full_name: 'Dana Whitcombe', avatar_url: null },
    is_own: false,
    parent_id: null,
    created_at: new Date().toISOString(),
    edited_at: null,
    deleted_at: null,
    replies: [],
    ...overrides,
  };
}

function rowOf(text: string): HTMLElement {
  return screen.getByText(text).closest('[data-slot="procedure-comment"]') as HTMLElement;
}

describe('Procedure discussion', () => {
  it('says so when nobody has commented', () => {
    render(
      <CommentThread
        procedureId="p1"
        timeZone="America/Los_Angeles"
        comments={[]}
        canModerate={false}
      />,
    );
    expect(screen.getByText('No comments yet. Start the discussion.')).toBeInTheDocument();
  });

  it("someone else's comment: Reply only; own comment: Reply, Edit and Delete", () => {
    render(
      <CommentThread
        procedureId="p1"
        timeZone="America/Los_Angeles"
        comments={[comment(), comment({ id: 'c2', body: 'Mine', is_own: true })]}
        canModerate={false}
      />,
    );
    const theirs = within(rowOf('Remember to photograph damaged cartons.'));
    expect(theirs.getByRole('button', { name: /Reply/ })).toBeInTheDocument();
    expect(theirs.queryByRole('button', { name: /Edit/ })).toBeNull();
    expect(theirs.queryByRole('button', { name: /Delete/ })).toBeNull();
    const mine = within(rowOf('Mine'));
    expect(mine.getByRole('button', { name: /Edit/ })).toBeInTheDocument();
    expect(mine.getByRole('button', { name: /Delete/ })).toBeInTheDocument();
  });

  it('an admin may edit and delete anyone’s comment', () => {
    render(
      <CommentThread
        procedureId="p1"
        timeZone="America/Los_Angeles"
        comments={[comment()]}
        canModerate
      />,
    );
    const row = within(rowOf('Remember to photograph damaged cartons.'));
    expect(row.getByRole('button', { name: /Edit/ })).toBeInTheDocument();
    expect(row.getByRole('button', { name: /Delete/ })).toBeInTheDocument();
  });

  it('replies are one level deep: a reply has no Reply button', () => {
    render(
      <CommentThread
        procedureId="p1"
        timeZone="America/Los_Angeles"
        comments={[
          comment({ replies: [comment({ id: 'r1', body: 'Good point.', parent_id: 'c1' })] }),
        ]}
        canModerate={false}
      />,
    );
    expect(within(rowOf('Good point.')).queryByRole('button', { name: /Reply/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Reply/ })).toHaveLength(1);
  });

  it('a deleted comment reads "(deleted)" with no actions and keeps its replies', () => {
    render(
      <CommentThread
        procedureId="p1"
        timeZone="America/Los_Angeles"
        comments={[
          comment({
            deleted_at: new Date().toISOString(),
            is_own: true,
            edited_at: new Date().toISOString(),
            replies: [comment({ id: 'r1', body: 'Still here.', parent_id: 'c1' })],
          }),
        ]}
        canModerate
      />,
    );
    const row = within(rowOf('(deleted)'));
    expect(row.queryByText('(edited)')).toBeNull();
    expect(screen.queryByText('Remember to photograph damaged cartons.')).toBeNull();
    expect(screen.getByText('Still here.')).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /Reply/ })).toHaveLength(0);
  });

  it('shows "(edited)" on an edited comment', () => {
    render(
      <CommentThread
        procedureId="p1"
        timeZone="America/Los_Angeles"
        comments={[comment({ edited_at: new Date().toISOString() })]}
        canModerate={false}
      />,
    );
    expect(screen.getByText('(edited)')).toBeInTheDocument();
  });

  it('Reply opens an inline composer with Cancel', async () => {
    const user = userEvent.setup();
    render(
      <CommentThread
        procedureId="p1"
        timeZone="America/Los_Angeles"
        comments={[comment()]}
        canModerate={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Reply/ }));
    expect(screen.getByPlaceholderText('Reply to Dana Whitcombe…')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('Reply to Dana Whitcombe…')).toBeNull();
  });

  it('the composer posts nothing while empty', () => {
    render(<CommentComposer procedureId="p1" />);
    expect(screen.getByPlaceholderText('Add a comment…')).toHaveAttribute('maxlength', '5000');
    expect(screen.getByRole('button', { name: /Post/ })).toBeDisabled();
  });
});

/**
 * B9 review: a comment's time tooltip was new Date(at).toLocaleString(). The
 * procedure page renders the thread on the server first (UTC on Vercel), and
 * the <time> carries suppressHydrationWarning for its relative words, so React
 * kept the server's title without a word: a 6:30 PM Pacific comment read
 * "10/25/2026, 1:30:00 AM", the next day, with no zone named. It is now the
 * organization's time, the same on both sides.
 */
describe("Procedure discussion — a comment's time is the organization's", () => {
  // 6:30 PM Pacific on 24 Oct is 01:30 UTC on 25 Oct.
  const EVENING = '2026-10-25T01:30:00.000Z';
  const NOW = Date.parse('2026-10-26T17:00:00.000Z');

  function thread(timeZone: string) {
    return (
      <CommentThread
        procedureId="p1"
        timeZone={timeZone}
        comments={[
          comment({
            created_at: EVENING,
            replies: [
              comment({ id: 'r1', body: 'Good point.', parent_id: 'c1', created_at: EVENING }),
            ],
          }),
        ]}
        canModerate={false}
      />
    );
  }

  it('the server (UTC) and a Pacific browser print the same tooltip, on a comment and its reply', async () => {
    const run = await hydrateAcrossClockShift(() => thread('America/Los_Angeles'), {
      serverNow: NOW,
      browserNow: NOW + 60_000,
    });
    try {
      const times = Array.from(run.container.querySelectorAll('time'));
      expect(times).toHaveLength(2);
      for (const time of times) {
        expect(time).toHaveAttribute('title', 'Oct 24, 2026, 6:30 PM');
        expect(time).toHaveAttribute('dateTime', EVENING);
      }
      expect(run.errors).toEqual([]);
    } finally {
      run.unmount();
    }
  });

  it("follows the organization's zone, not the browser's", async () => {
    const run = await hydrateAcrossClockShift(() => thread('America/New_York'), {
      serverNow: NOW,
      browserNow: NOW + 60_000,
    });
    try {
      expect(run.container.querySelector('time')).toHaveAttribute('title', 'Oct 24, 2026, 9:30 PM');
    } finally {
      run.unmount();
    }
  });
});
