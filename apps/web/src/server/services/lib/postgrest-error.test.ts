import { describe, expect, it } from 'vitest';

import { postgrestErrorText } from './postgrest-error';

describe('postgrestErrorText', () => {
  it('returns a non-empty message unchanged', () => {
    expect(postgrestErrorText({ message: 'duplicate key', code: '23505' }, { status: 409 })).toBe(
      'duplicate key',
    );
  });

  it('names the status, code, details and hint when the message is empty', () => {
    expect(
      postgrestErrorText(
        { message: '', code: 'PGRST000', details: 'upstream closed', hint: 'retry' },
        { status: 503, statusText: 'Service Unavailable' },
      ),
    ).toBe(
      'HTTP 503 Service Unavailable, code PGRST000, details: upstream closed, hint: retry (empty error message)',
    );
  });

  it('says there was no HTTP answer for status 0', () => {
    expect(postgrestErrorText({ message: '  ' }, { status: 0 })).toBe(
      'no HTTP response (empty error message)',
    );
  });

  it('never returns an empty string', () => {
    expect(postgrestErrorText({ message: '' })).toBe(
      'PostgREST error with an empty message and no status',
    );
  });
});
