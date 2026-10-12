// Ungroup D1 (b): restoring a version 1 restore point (taken before restore
// points carried record ids) after a record changed SKU can add that record
// again under its old SKU. The restore row says so, naming the records,
// BEFORE the typed RESTORE confirm.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/auth/step-up-modal', () => ({
  useStepUp: () => ({ ensure: vi.fn(async () => true), modal: null }),
}));

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
const h = vi.hoisted(() => ({
  changes: vi.fn(),
  restore: vi.fn(),
}));
vi.mock('@/server/actions/restore-points', () => ({
  restorePointSkuChangesAction: (...a: unknown[]) => h.changes(...a),
  restoreFromPointAction: (...a: unknown[]) => h.restore(...a),
}));

import { RestoreSnapshotButton } from './restore-snapshot-button';
import { RESTORE_SKU_COPY } from './restore-sku-warning-copy';

const ID = '33333333-3333-4333-8333-333333333333';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function answer(data: unknown): Result<unknown> {
  return { ok: true, data };
}

beforeEach(() => {
  vi.clearAllMocks();
});

async function open() {
  const user = userEvent.setup();
  render(<RestoreSnapshotButton id={ID} when="10/10/2026, 1:00:00 AM" />);
  await user.click(screen.getByRole('button', { name: 'Restore' }));
  return user;
}

describe('RestoreSnapshotButton: SKU changes since the point', () => {
  it('names each record that changed SKU, with its old and new SKU, above the typed confirm', async () => {
    h.changes.mockResolvedValue(
      answer({
        version: 1,
        changes: [
          {
            itemId: B,
            name: 'Black Mouse Pad',
            before: 'SP-PAIR',
            after: 'SP-NEW1',
            shared: false,
          },
          { itemId: C, name: null, before: 'SP-OLD', after: 'SP-LAST', shared: true },
        ],
        more: 2,
        truncated: false,
      }),
    );
    await open();
    expect(h.changes).toHaveBeenCalledWith({ id: ID });
    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent(RESTORE_SKU_COPY.heading);
    expect(warning).toHaveTextContent(RESTORE_SKU_COPY.body);
    expect(warning).toHaveTextContent('Black Mouse Pad: SP-PAIR to SP-NEW1');
    expect(warning).toHaveTextContent(
      'A record you cannot see: SP-OLD to SP-LAST, with the records that shared it',
    );
    expect(warning).toHaveTextContent('and 2 more');
    expect(warning).toHaveTextContent(RESTORE_SKU_COPY.advice);
    // Before the typed confirm, in reading order.
    const input = screen.getByPlaceholderText('RESTORE');
    expect(warning.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(h.restore).not.toHaveBeenCalled();
  });

  it('says the count is a floor when the check stopped at its limit', async () => {
    h.changes.mockResolvedValue(
      answer({
        version: 1,
        changes: [
          {
            itemId: B,
            name: 'Black Mouse Pad',
            before: 'SP-PAIR',
            after: 'SP-NEW1',
            shared: false,
          },
        ],
        more: 489,
        truncated: true,
      }),
    );
    await open();
    expect(await screen.findByRole('alert')).toHaveTextContent('and at least 489 more');
  });

  it('shows no warning for a point that matches records by id, or when no SKU changed', async () => {
    for (const data of [
      { version: 2, changes: [], more: 0, truncated: false },
      { version: 1, changes: [], more: 0, truncated: false },
    ]) {
      h.changes.mockResolvedValueOnce(answer(data));
      const { unmount } = render(<RestoreSnapshotButton id={ID} when="now" />);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Restore' }));
      await waitFor(() => expect(screen.queryByText(RESTORE_SKU_COPY.checking)).toBeNull());
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByPlaceholderText('RESTORE')).toBeInTheDocument();
      unmount();
    }
  });

  it('says plainly when the check failed, and still lets an owner confirm', async () => {
    h.changes.mockResolvedValue({ ok: false, error: { code: 'internal_error', message: 'boom' } });
    await open();
    expect(await screen.findByText(RESTORE_SKU_COPY.failed)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('RESTORE')).toBeInTheDocument();
  });

  // PR stage, DATA-1 (2): an admin whose audit-log view was revoked is told why
  // the check cannot run (never shown an empty list as an all-clear), and can
  // still confirm.
  it('tells an admin who cannot view the audit log that the check cannot run, and still lets them confirm', async () => {
    h.changes.mockResolvedValue({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Checking for SKU changes reads the audit log, which you cannot view.',
        details: { reason: 'audit_log_hidden' },
      },
    });
    const user = await open();
    await waitFor(() => expect(screen.queryByText(RESTORE_SKU_COPY.checking)).toBeNull());
    expect(document.body.textContent).toContain(
      'Could not check whether any record changed SKU since this restore point: that check reads the audit log, which you cannot view.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    await user.type(screen.getByPlaceholderText('RESTORE'), 'RESTORE');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  });

  it('says it is checking while the answer is on its way', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    h.changes.mockReturnValue(new Promise((r) => (resolve = r)));
    await open();
    expect(screen.getByText(RESTORE_SKU_COPY.checking)).toBeInTheDocument();
    resolve(answer({ version: 2, changes: [], more: 0, truncated: false }));
    await waitFor(() => expect(screen.queryByText(RESTORE_SKU_COPY.checking)).toBeNull());
  });

  // PR stage, data review DATA-1 (1): the warning is the only guard a version 1
  // point has, so RESTORE typed (or pasted) before the check answers must not
  // restore past it. Confirm stays off until the check is done or has failed.
  it('keeps Confirm off while the check is on its way, even with RESTORE typed, and turns it on once the check answers', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    h.changes.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = await open();
    await user.type(screen.getByPlaceholderText('RESTORE'), 'RESTORE');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(h.restore).not.toHaveBeenCalled();
    resolve(
      answer({
        version: 1,
        changes: [
          {
            itemId: B,
            name: 'Black Mouse Pad',
            before: 'SP-PAIR',
            after: 'SP-NEW1',
            shared: false,
          },
        ],
        more: 0,
        truncated: false,
      }),
    );
    // The warning is on screen before Confirm turns on.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Black Mouse Pad: SP-PAIR to SP-NEW1',
    );
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  });

  it('turns Confirm on after a failed check too, below the words that say it failed', async () => {
    h.changes.mockResolvedValue({ ok: false, error: { code: 'internal_error', message: 'x' } });
    const user = await open();
    expect(await screen.findByText(RESTORE_SKU_COPY.failed)).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('RESTORE'), 'RESTORE');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  });

  it('never says "book" for a recorded quantity, and never tells anyone to change a charter or rack', () => {
    const text = [
      RESTORE_SKU_COPY.checking,
      RESTORE_SKU_COPY.failed,
      RESTORE_SKU_COPY.heading,
      RESTORE_SKU_COPY.body,
      RESTORE_SKU_COPY.advice,
    ].join(' ');
    expect(text).not.toMatch(/\bbook\b/i);
    expect(text).not.toMatch(/change (the |a )?(charter|rack)/i);
  });
});
