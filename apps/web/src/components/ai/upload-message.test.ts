import { describe, expect, it } from 'vitest';

import { CHAT_MESSAGE_MAX_CHARS } from '@/lib/ai/chat-limits';
import { syntheticIsbn13s } from '@/test/synthetic-isbns';

import { buildUploadMessage, tooManyIsbnsNote } from './upload-message';

/**
 * What the web AI Assistant sends for an attached file's ISBNs, and the note
 * when a file has more than it adds at a time (docket B76). The message moved
 * out of the panel unchanged: the system prompt tells the model to look for
 * its first line (lib/ai/chat.ts, Bulk ISBN imports step 0).
 */

describe('buildUploadMessage', () => {
  it('is the message the panel always sent, byte for byte', () => {
    expect(
      buildUploadMessage('order-sheet.csv', ['9780306406157', '0306406152'], '2 regex hits'),
    ).toBe(
      '[Uploaded order-sheet.csv — extracted 2 ISBNs (2 regex hits)]\n' +
        '\n' +
        '9780306406157\n' +
        '0306406152\n' +
        '\n' +
        'Please preview the bulk import for these ISBNs and tell me which warehouse + charter you need.',
    );
    expect(buildUploadMessage('one.txt', ['9780306406157'], undefined)).toBe(
      '[Uploaded one.txt — extracted 1 ISBN]\n' +
        '\n' +
        '9780306406157\n' +
        '\n' +
        'Please preview the bulk import for these ISBNs and tell me which warehouse + charter you need.',
    );
  });

  it('50 ISBN-13s with the longest file name and notes still fit in one chat message', () => {
    const message = buildUploadMessage(
      `${'n'.repeat(251)}.csv`,
      syntheticIsbn13s(50),
      '50 regex hits, +49 from AI, 120 unverified guesses dropped',
    );
    expect(message).toHaveLength(1145);
    expect(message.length).toBeLessThanOrEqual(CHAT_MESSAGE_MAX_CHARS);
  });
});

describe('tooManyIsbnsNote', () => {
  it('points to Bulk ISBN import when the person can open it', () => {
    expect(tooManyIsbnsNote(51, true)).toBe(
      'Found 51 ISBNs in this file. The assistant adds up to 50 at a time, so use Bulk ISBN import for this list.',
    );
  });

  it('asks for a smaller file otherwise', () => {
    expect(tooManyIsbnsNote(51, false)).toBe(
      'Found 51 ISBNs in this file. The assistant adds up to 50 at a time, so attach a file with 50 or fewer.',
    );
  });

  it('writes a large count with a thousands separator', () => {
    expect(tooManyIsbnsNote(1234, true)).toMatch(/^Found 1,234 ISBNs in this file\. /);
  });
});
