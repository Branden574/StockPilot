import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EXPORT_FORBIDDEN_COPY, EXPORT_SESSION_ENDED_COPY } from '@/lib/exports/export-refusal';

import { ExportBuilderPreview, type ExportBuilderPreviewProps } from './export-builder-preview';
import { initialExportBuilderState } from './export-builder-state';

/**
 * B68: a sample the server refused for good (no permission to export, or the
 * session ended) says why, in place of the sample. It used to be filed as a
 * passing failure: "Could not load a sample of this export. You can still
 * export the file." with a Try again that could only fail again.
 */

const FAILED = 'Could not load a sample of this export. You can still export the file.';

function renderPreview(props: Partial<ExportBuilderPreviewProps>) {
  return render(
    <ExportBuilderPreview
      state={initialExportBuilderState('other')}
      itemTypeKind="other"
      preview={null}
      onRetry={() => undefined}
      rowCount={3}
      {...props}
    />,
  );
}

describe('ExportBuilderPreview: a refused sample (B68)', () => {
  it.each([
    ['no permission', EXPORT_FORBIDDEN_COPY],
    ['an ended session', EXPORT_SESSION_ENDED_COPY],
  ])('%s: the sentence in a status line, with no Try again', (_why, sentence) => {
    const { container } = renderPreview({ refusal: sentence });
    expect(screen.getByRole('status').textContent).toBe(sentence);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(screen.queryByText('Loading a sample of this export…')).toBeNull();
    expect(screen.queryByRole('table', { name: 'Export preview' })).toBeNull();
    expect(container.textContent).not.toMatch(/forbidden|unauthenticated/i);
  });

  it('a refusal wins over a plain failure: Try again cannot help it', () => {
    renderPreview({ refusal: EXPORT_FORBIDDEN_COPY, failed: true });
    expect(screen.getByRole('status').textContent).toBe(EXPORT_FORBIDDEN_COPY);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it('a failed sample with no refusal still says it could not load, with Try again', () => {
    renderPreview({ failed: true, refusal: null });
    expect(screen.getByRole('status').textContent).toBe(FAILED);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('a sample still loading with no refusal shows the loading line', () => {
    renderPreview({});
    expect(screen.getByText('Loading a sample of this export…')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
