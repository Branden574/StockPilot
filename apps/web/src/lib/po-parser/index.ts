import type { CanonicalPo } from '@stockpilot/core';
import { parsePdf } from './pdf';
import { parseCsvText } from './csv';

export type ParseSourceType = 'pdf' | 'csv';

export type ParsedPo = CanonicalPo & { rawText?: string };

export async function parsePoFile(
  buffer: Buffer,
  source: ParseSourceType,
): Promise<ParsedPo> {
  if (source === 'pdf') return parsePdf(buffer);
  if (source === 'csv') {
    const text = buffer.toString('utf8');
    return { ...parseCsvText(text), rawText: text };
  }
  throw new Error(`Unsupported source: ${source as string}`);
}

export { parsePdf, parsePdfText } from './pdf';
export { parseCsvText } from './csv';
export { classifyLine } from './classify';
export type { CanonicalPo, CanonicalPoLine } from '@stockpilot/core';
