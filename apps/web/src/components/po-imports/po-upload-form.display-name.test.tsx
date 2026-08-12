import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/server/actions/po-imports', () => ({
  presignPoUploadAction: vi.fn(),
  recordPoUploadAction: vi.fn(),
  parsePoImportAction: vi.fn(),
}));

// sonner's real toast blows the stack under happy-dom (same stub the repo uses
// in procedure-form.test.tsx). Nothing here asserts on toasts.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import {
  parsePoImportAction,
  presignPoUploadAction,
  recordPoUploadAction,
} from '@/server/actions/po-imports';

import { PoUploadForm } from './po-upload-form';

/**
 * The CSV/PDF upload form's "PO name" field (mig 0332).
 *
 * Two properties matter and both are easy to break: the field must be
 * PREFILLED from the picked file (so naming costs nothing in the common case),
 * and the REAL filename must still be what `fileName` carries to the server —
 * the point of a separate column is that the uploaded file is not renamed.
 */

function csv(name: string): File {
  return new File(['sku,qty\nA,1\n'], name, { type: 'text/csv' });
}

/** The single argument recordPoUploadAction was called with. */
function recordArg(): Record<string, unknown> {
  return vi.mocked(recordPoUploadAction).mock.calls[0]![0] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(presignPoUploadAction).mockResolvedValue({
    ok: true,
    data: { uploadUrl: 'https://storage.test/put', storagePath: 'org-1/po-imports/x.csv' },
  } as never);
  vi.mocked(recordPoUploadAction).mockResolvedValue({
    ok: true,
    data: { id: 'imp-1', duplicateOf: null, reimportOfCancelled: null },
  } as never);
  vi.mocked(parsePoImportAction).mockResolvedValue({ ok: true, data: undefined } as never);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true })) as never,
  );
  // happy-dom does not implement SubtleCrypto; the digest value is irrelevant
  // to this file's assertions, only that the flow gets past it.
  vi.stubGlobal('crypto', {
    ...globalThis.crypto,
    subtle: { digest: vi.fn(async () => new ArrayBuffer(32)) },
  });
});

describe('PoUploadForm — the PO name field', () => {
  it('prefills from the file name: extension dropped, separators prettified', async () => {
    render(<PoUploadForm />);
    const nameField = screen.getByLabelText('PO name') as HTMLInputElement;
    expect(nameField.value).toBe('');

    await userEvent.upload(
      screen.getByLabelText('PO file (PDF or CSV)'),
      csv('Aug_2026-DC4_book_order.csv'),
    );

    await waitFor(() => expect(nameField.value).toBe('Aug 2026 DC4 book order'));
  });

  it('sends the EDITED name as displayName while fileName stays the real uploaded filename', async () => {
    render(<PoUploadForm />);
    await userEvent.upload(screen.getByLabelText('PO file (PDF or CSV)'), csv('image.csv'));

    const nameField = screen.getByLabelText('PO name');
    await userEvent.clear(nameField);
    await userEvent.type(nameField, 'August DC4 Book Order');
    await userEvent.click(screen.getByRole('button', { name: /Upload & parse/i }));

    await waitFor(() => expect(recordPoUploadAction).toHaveBeenCalledTimes(1));
    expect(recordArg().displayName).toBe('August DC4 Book Order');
    // The file itself was NOT renamed.
    expect(recordArg().fileName).toBe('image.csv');
  });

  it('an emptied name field still uploads — the server stores null and falls back to the filename', async () => {
    render(<PoUploadForm />);
    await userEvent.upload(screen.getByLabelText('PO file (PDF or CSV)'), csv('image.csv'));
    await userEvent.clear(screen.getByLabelText('PO name'));
    await userEvent.click(screen.getByRole('button', { name: /Upload & parse/i }));

    await waitFor(() => expect(recordPoUploadAction).toHaveBeenCalledTimes(1));
    expect(recordArg().displayName).toBe('');
    expect(recordArg().fileName).toBe('image.csv');
  });

  it('picking a DIFFERENT file replaces the suggestion (no stale name from the previous pick)', async () => {
    render(<PoUploadForm />);
    const fileField = screen.getByLabelText('PO file (PDF or CSV)');
    const nameField = screen.getByLabelText('PO name') as HTMLInputElement;

    await userEvent.upload(fileField, csv('first_order.csv'));
    await waitFor(() => expect(nameField.value).toBe('first order'));

    await userEvent.upload(fileField, csv('second_order.csv'));
    await waitFor(() => expect(nameField.value).toBe('second order'));
  });
});
