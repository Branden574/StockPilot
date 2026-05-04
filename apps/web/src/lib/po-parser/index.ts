import type { CanonicalPo } from '@stockpilot/core';
import { parsePdf } from './pdf';
import { parseCsvText } from './csv';

export type ParseSourceType = 'pdf' | 'csv';

export async function parsePoFile(
  buffer: Buffer,
  source: ParseSourceType,
): Promise<CanonicalPo> {
  if (source === 'pdf') return parsePdf(buffer);
  if (source === 'csv') return parseCsvText(buffer.toString('utf8'));
  throw new Error(`Unsupported source: ${source as string}`);
}

export { parsePdf, parsePdfText } from './pdf';
export { parseCsvText } from './csv';
export { classifyLine } from './classify';
export type { CanonicalPo, CanonicalPoLine } from '@stockpilot/core';
