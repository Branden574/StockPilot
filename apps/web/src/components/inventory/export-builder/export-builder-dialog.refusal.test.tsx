import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EXPORT_FORBIDDEN_COPY,
  EXPORT_SESSION_ENDED_COPY,
  ExportRefusedError,
} from '@/lib/exports/export-refusal';

/**
 * B68: the Customize export dialog when the server refuses for good.
 *
 * A member without items:export (or whose session ended) saw "Could not load
 * a sample of this export. You can still export the file." with a Try again
 * that failed again, and then the bare code "forbidden" under Export file.
 * The requests now reject with ExportRefusedError carrying the sentence
 * (download-export.ts); this pins what the dialog does with it. The mocks are
 * export-builder-dialog.test.tsx's; lib/exports is the real module.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const downloadSpy = vi.fn(async (..._args: unknown[]) => {});
const previewSpy = vi.fn(async (..._args: unknown[]) => ({
  total: 111,
  truncated: false,
  slug: 'books' as const,
  sampleRows: [],
  readiness: { rows: 111, withIsbn: 97, missingIsbn: 14, withImage: 84, missingImage: 27 },
}));
vi.mock('@/lib/download-export', () => ({
  downloadInventoryExport: (...a: unknown[]) => downloadSpy(...a),
  fetchExportPreview: (...a: unknown[]) => previewSpy(...a),
}));
vi.mock('@/server/actions/export-presets', () => ({
  listSharedExportPresetsAction: vi.fn(async () => ({
    ok: true as const,
    data: { available: true, presets: [] },
  })),
  saveSharedExportPresetAction: vi.fn(),
  deleteSharedExportPresetAction: vi.fn(),
}));

import { ExportBuilderDialog } from './export-builder-dialog';

const FAILED = 'Could not load a sample of this export. You can still export the file.';

function renderDialog() {
  const onOpenChange = vi.fn();
  render(
    <ExportBuilderDialog
      open
      onOpenChange={onOpenChange}
      scope="filtered"
      itemType="book"
      filters={{ q: 'algebra' }}
      rowCountHint={111}
    />,
  );
  return { onOpenChange };
}

beforeEach(() => {
  downloadSpy.mockClear();
  previewSpy.mockClear();
  window.localStorage.clear();
});

describe('ExportBuilderDialog: a refused sample says why, with no Try again (B68)', () => {
  it.each([
    ['no permission to export', EXPORT_FORBIDDEN_COPY],
    ['an ended session', EXPORT_SESSION_ENDED_COPY],
  ])('%s', async (_why, sentence) => {
    previewSpy.mockRejectedValueOnce(new ExportRefusedError(sentence));
    renderDialog();
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText('Loading a sample of this export…')).toBeNull();
    expect(previewSpy).toHaveBeenCalledTimes(1);
  });

  it('Export file stays usable after a refused sample (a sample never blocks it)', async () => {
    previewSpy.mockRejectedValueOnce(new ExportRefusedError(EXPORT_FORBIDDEN_COPY));
    renderDialog();
    expect(await screen.findByText(EXPORT_FORBIDDEN_COPY)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export file' })).toHaveProperty('disabled', false);
  });

  it('a sample that failed for another reason still says it could not load, with Try again', async () => {
    previewSpy.mockRejectedValueOnce(
      new Error('Too many preview requests — please wait a moment.'),
    );
    renderDialog();
    expect(await screen.findByText(FAILED)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('ExportBuilderDialog: a refused export file says why, never the code (B68)', () => {
  it.each([
    ['no permission to export', EXPORT_FORBIDDEN_COPY],
    ['an ended session', EXPORT_SESSION_ENDED_COPY],
  ])('%s', async (_why, sentence) => {
    const user = userEvent.setup();
    downloadSpy.mockRejectedValueOnce(new ExportRefusedError(sentence));
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(sentence));
    expect(screen.getByRole('alert').textContent).not.toMatch(/forbidden|unauthenticated/i);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
