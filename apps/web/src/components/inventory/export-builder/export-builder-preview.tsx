'use client';

import type { ExportPreviewResponse } from '@/lib/download-export';

import type { ExportBuilderState } from './export-builder-state';

export interface ExportBuilderPreviewProps {
  state: ExportBuilderState;
  itemTypeKind: 'book' | 'other';
  preview: ExportPreviewResponse | null;
  rowCount: number | null;
}

/** Built out in the preview task. */
export function ExportBuilderPreview(_props: ExportBuilderPreviewProps) {
  return null;
}
