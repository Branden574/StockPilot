'use client';

import type { InventoryExportFieldKey } from '@/lib/exports/field-registry';

import type { ExportBuilderState } from './export-builder-state';

export interface ExportBuilderFieldsProps {
  state: ExportBuilderState;
  itemTypeKind: 'book' | 'other';
  onToggle: (key: InventoryExportFieldKey) => void;
  onMove: (key: InventoryExportFieldKey, direction: 'up' | 'down' | 'top' | 'bottom') => void;
}

/** Built out in the field-selection task. */
export function ExportBuilderFields(_props: ExportBuilderFieldsProps) {
  return null;
}
