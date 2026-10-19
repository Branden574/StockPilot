import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

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
    render(<CommentThread procedureId="p1" comments={[]} canModerate={false} />);
    expect(screen.getByText('No comments yet. Start the discussion.')).toBeInTheDocument();
  });

  it("someone else's comment: Reply only; own comment: Reply, Edit and Delete", () => {
    render(
      <CommentThread
        procedureId="p1"
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
    render(<CommentThread procedureId="p1" comments={[comment()]} canModerate />);
    const row = within(rowOf('Remember to photograph damaged cartons.'));
    expect(row.getByRole('button', { name: /Edit/ })).toBeInTheDocument();
    expect(row.getByRole('button', { name: /Delete/ })).toBeInTheDocument();
  });

  it('replies are one level deep: a reply has no Reply button', () => {
    render(
      <CommentThread
        procedureId="p1"
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
        comments={[comment({ edited_at: new Date().toISOString() })]}
        canModerate={false}
      />,
    );
    expect(screen.getByText('(edited)')).toBeInTheDocument();
  });

  it('Reply opens an inline composer with Cancel', async () => {
    const user = userEvent.setup();
    render(<CommentThread procedureId="p1" comments={[comment()]} canModerate={false} />);
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
