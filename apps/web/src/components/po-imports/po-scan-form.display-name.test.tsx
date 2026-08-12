import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// sonner's real toast blows the stack under happy-dom (the repo already stubs
// it for the same reason in procedure-form.test.tsx and friends). Nothing here
// asserts on toasts.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { PoScanForm } from './po-scan-form';

/**
 * The scan form's naming UI (mig 0332) — the CLIENT half of the index-aligned
 * `displayName` contract that app/api/po-imports/scan/route.ts defines.
 *
 * Separate mode gives every attached file its own input, and the form must
 * append exactly one `displayName` per `file`, in the same order, even when
 * some are blank. Dropping a blank would shift every later name onto the wrong
 * file — the silent mis-association these assertions exist to prevent.
 */

function pdf(name: string): File {
  return new File([new Uint8Array(16)], name, { type: 'application/pdf' });
}

/** The FormData the form POSTed, decoded into the wire contract's three parts. */
function postedForm(): {
  files: string[];
  names: Array<string | null>;
  mode: string | null;
} {
  const fd = vi.mocked(fetch).mock.calls[0]![1]!.body as FormData;
  const raw = fd.get('displayNames');
  return {
    files: fd.getAll('file').map((f) => (f as File).name),
    names: raw === null ? [] : JSON.parse(String(raw)),
    mode: fd.get('mode') === null ? null : String(fd.get('mode')),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, id: 'imp-1', duplicateOf: null, lowConfidenceLines: 0 }),
    })) as never,
  );
});

describe('PoScanForm — one name, one import', () => {
  it('a single file sends the one typed name', async () => {
    render(<PoScanForm />);
    await userEvent.upload(screen.getByTestId('po-scan-file-input'), pdf('image.jpg'));
    await userEvent.type(screen.getByLabelText('PO name'), 'August DC4 Book Order');
    await userEvent.click(screen.getByRole('button', { name: /Extract with AI/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(postedForm()).toEqual({
      files: ['image.jpg'],
      names: ['August DC4 Book Order'],
      mode: 'combined',
    });
  });

  it('a single file with NO name sends an explicit [null] — one entry per import either way', async () => {
    render(<PoScanForm />);
    await userEvent.upload(screen.getByTestId('po-scan-file-input'), pdf('image.jpg'));
    await userEvent.click(screen.getByRole('button', { name: /Extract with AI/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(postedForm()).toEqual({ files: ['image.jpg'], names: [null], mode: 'combined' });
  });
});

describe('PoScanForm — separate mode gives each file its own name, index-aligned', () => {
  it('names are appended in file order, one per file', async () => {
    render(<PoScanForm />);
    await userEvent.upload(screen.getByTestId('po-scan-file-input'), [
      pdf('a.pdf'),
      pdf('b.pdf'),
      pdf('c.pdf'),
    ]);

    await userEvent.type(screen.getByLabelText('PO name for a.pdf'), 'First');
    await userEvent.type(screen.getByLabelText('PO name for b.pdf'), 'Second');
    await userEvent.type(screen.getByLabelText('PO name for c.pdf'), 'Third');
    await userEvent.click(screen.getByRole('button', { name: /Extract with AI/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(postedForm()).toEqual({
      files: ['a.pdf', 'b.pdf', 'c.pdf'],
      names: ['First', 'Second', 'Third'],
      mode: 'separate',
    });
  });

  it('an UNNAMED middle file sends an explicit null, so file 3 keeps its own name', async () => {
    render(<PoScanForm />);
    await userEvent.upload(screen.getByTestId('po-scan-file-input'), [
      pdf('a.pdf'),
      pdf('b.pdf'),
      pdf('c.pdf'),
    ]);
    await userEvent.type(screen.getByLabelText('PO name for a.pdf'), 'First');
    await userEvent.type(screen.getByLabelText('PO name for c.pdf'), 'Third');
    await userEvent.click(screen.getByRole('button', { name: /Extract with AI/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(postedForm()).toEqual({
      files: ['a.pdf', 'b.pdf', 'c.pdf'],
      names: ['First', null, 'Third'],
      mode: 'separate',
    });
  });

  it('removing a file removes ITS name, keeping the rest aligned', async () => {
    render(<PoScanForm />);
    await userEvent.upload(screen.getByTestId('po-scan-file-input'), [
      pdf('a.pdf'),
      pdf('b.pdf'),
      pdf('c.pdf'),
    ]);
    await userEvent.type(screen.getByLabelText('PO name for a.pdf'), 'First');
    await userEvent.type(screen.getByLabelText('PO name for b.pdf'), 'Second');
    await userEvent.type(screen.getByLabelText('PO name for c.pdf'), 'Third');

    await userEvent.click(screen.getByRole('button', { name: 'Remove b.pdf' }));
    await userEvent.click(screen.getByRole('button', { name: /Extract with AI/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(postedForm()).toEqual({
      files: ['a.pdf', 'c.pdf'],
      names: ['First', 'Third'],
      mode: 'separate',
    });
  });

  it('switching to "One multi-page PO" collapses to combined mode and ONE name', async () => {
    render(<PoScanForm />);
    await userEvent.upload(screen.getByTestId('po-scan-file-input'), [
      pdf('page1.pdf'),
      pdf('page2.pdf'),
    ]);
    await userEvent.type(screen.getByLabelText('PO name for page1.pdf'), 'August DC4 Book Order');

    await userEvent.click(screen.getByRole('button', { name: /One multi-page PO/i }));
    await userEvent.click(screen.getByRole('button', { name: /Extract with AI/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(postedForm()).toEqual({
      files: ['page1.pdf', 'page2.pdf'],
      names: ['August DC4 Book Order'],
      mode: 'combined',
    });
  });
});
