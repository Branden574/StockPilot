import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updatePoStatusAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/server/actions/purchase-orders', () => ({
  updatePoStatusAction: (...args: unknown[]) => updatePoStatusAction(...args),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ capture: vi.fn() }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});

import { PoActions } from './po-actions';

/**
 * The status actions keep their rules (Edit and Mark as ordered on a draft,
 * Cancel PO until cancelled or received) and split for the page header: the
 * secondary part holds Edit and Cancel PO, the commit part Mark as ordered,
 * so the page's one ink-filled button can sit last.
 */

function names(): string[] {
  return [...screen.queryAllByRole('link'), ...screen.queryAllByRole('button')]
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map((el) => el.textContent?.trim() ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  updatePoStatusAction.mockResolvedValue({ ok: true, data: null });
});

describe('PoActions', () => {
  it('draws all three for a draft by default, in their old order', () => {
    render(<PoActions poId="po-1" status="draft" />);
    expect(names()).toEqual(['Edit', 'Mark as ordered', 'Cancel PO']);
    expect(screen.getByRole('link', { name: /edit/i })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders/po-1/edit',
    );
  });

  it('splits a draft into the secondary pair and the commit', () => {
    const secondary = render(<PoActions poId="po-1" status="draft" part="secondary" />);
    expect(names()).toEqual(['Edit', 'Cancel PO']);
    secondary.unmount();
    render(<PoActions poId="po-1" status="draft" part="commit" />);
    expect(names()).toEqual(['Mark as ordered']);
  });

  it('offers only Cancel PO once ordered, and nothing once received or cancelled', () => {
    const ordered = render(<PoActions poId="po-1" status="ordered" part="secondary" />);
    expect(names()).toEqual(['Cancel PO']);
    ordered.unmount();
    const commit = render(<PoActions poId="po-1" status="ordered" part="commit" />);
    expect(names()).toEqual([]);
    commit.unmount();
    for (const status of ['received', 'cancelled']) {
      const view = render(<PoActions poId="po-1" status={status} />);
      expect(names(), status).toEqual([]);
      view.unmount();
    }
    const partial = render(<PoActions poId="po-1" status="partially_received" />);
    expect(names()).toEqual(['Cancel PO']);
    partial.unmount();
  });

  it('Mark as ordered and Cancel PO still post the status and refresh', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<PoActions poId="po-1" status="draft" part="commit" />);
    await user.click(screen.getByRole('button', { name: /mark as ordered/i }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(updatePoStatusAction).toHaveBeenCalledWith('po-1', 'ordered');
    unmount();

    render(<PoActions poId="po-1" status="draft" part="secondary" />);
    await user.click(screen.getByRole('button', { name: /cancel po/i }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(updatePoStatusAction).toHaveBeenLastCalledWith('po-1', 'cancelled');
  });
});
