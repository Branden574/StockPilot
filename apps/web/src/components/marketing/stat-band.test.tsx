import { describe, expect, it } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

import { StatBand } from './stat-band';

/**
 * The pre-scrolly homepage's stat band, kept so the marketing page can be
 * reverted in one line. Its figures count up from 0 and were printed with
 * `n.toLocaleString()`, the RUNTIME's locale: "0ms" on the server, and "٠ms"
 * in a browser set to Arabic (Arabic-Indic digits), so React discarded the
 * server HTML (error #418) before the count even started. Small numbers look
 * the same in most locales, which is why this uses one with its own digits.
 */
describe('StatBand', () => {
  it('prints its figures the same on the server and in an Arabic-locale browser', async () => {
    const at = Date.parse('2026-10-24T18:00:00.000Z');
    const run = await hydrateAcrossClockShift(() => <StatBand />, {
      serverNow: at,
      browserNow: at,
      browserLocale: 'ar-EG',
    });
    try {
      expect(run.errors).toEqual([]);
      expect(run.container).toHaveTextContent('0ms');
      expect(run.container).toHaveTextContent('0%');
    } finally {
      run.unmount();
    }
  });
});
