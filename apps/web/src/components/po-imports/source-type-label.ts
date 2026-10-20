/**
 * The words for an import's source (CONFLICTS D11): the imports list used to
 * print the stored `source_type` as is ("pdf", "csv", "scan"). A value this
 * build does not know is shown as stored, so nothing is ever hidden.
 */
const SOURCE_TYPE_LABELS: Readonly<Record<string, string>> = {
  pdf: 'PDF',
  csv: 'CSV',
  scan: 'Scan',
  xlsx: 'XLSX',
  manual: 'Manual',
};

export function poImportSourceLabel(sourceType: string): string {
  return SOURCE_TYPE_LABELS[sourceType] ?? sourceType;
}
