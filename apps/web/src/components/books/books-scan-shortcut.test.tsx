import { act, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

/**
 * B40: the Books scan shortcut cleared its busy flag in finally but had no
 * catch, so a lookup that got no answer (offline, a server error, a deploy)
 * ended in silence: the scanner just sat there.
 */

const { push, lookup, toast } = vi.hoisted(() => ({
  push: vi.fn(),
  lookup: vi.fn(),
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/server/actions/books-lookup', () => ({ lookupBookByIsbnAction: lookup }));
// The camera scanner, reduced to a button that reports one ISBN.
vi.mock('@/components/inventory/isbn-scanner', () => ({
  IsbnScanner: ({ open, onDetected }: { open: boolean; onDetected: (isbn: string) => void }) =>
    open ? (
      <button type="button" onClick={() => onDetected('9780306406157')}>
        Scan
      </button>
    ) : null,
}));

import { BooksScanShortcut, type BooksScanShortcutHandle } from './books-scan-shortcut';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BooksScanShortcut when the lookup gets no answer', () => {
  it('says the book was not looked up and takes the next scan', async () => {
    lookup.mockRejectedValueOnce(offline());
    const ref = React.createRef<BooksScanShortcutHandle>();
    render(<BooksScanShortcut ref={ref} />);
    act(() => ref.current?.open());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    });
    expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'look up the book'));
    expect(push).not.toHaveBeenCalled();

    // Not stuck on "Still looking up the last scan": the next scan is looked up.
    lookup.mockResolvedValueOnce({ ok: true, data: { matches: [{ id: 'bk-1' }] } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    });
    expect(toast.info).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('/dashboard/books/bk-1');
  });
});
