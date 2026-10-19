import { describe, expect, it } from 'vitest';

import { poImportSourceLabel } from './source-type-label';

describe('poImportSourceLabel (CONFLICTS D11: the imports list printed pdf / csv / scan raw)', () => {
  it('names the three sources a person uploads in words', () => {
    expect(poImportSourceLabel('pdf')).toBe('PDF');
    expect(poImportSourceLabel('csv')).toBe('CSV');
    expect(poImportSourceLabel('scan')).toBe('Scan');
  });

  it('names the other stored sources too', () => {
    expect(poImportSourceLabel('xlsx')).toBe('XLSX');
    expect(poImportSourceLabel('manual')).toBe('Manual');
  });

  it('shows an unknown value exactly as stored instead of hiding it', () => {
    expect(poImportSourceLabel('edi')).toBe('edi');
  });
});
