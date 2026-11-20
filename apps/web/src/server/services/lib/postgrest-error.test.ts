import { describe, expect, it } from 'vitest';

import { reportedMessage } from '@/lib/error-text';
import { ServiceError } from '@/server/services/context';

import { isDefiniteRefusal, isPermanentRefusal, postgrestErrorText } from './postgrest-error';

describe('postgrestErrorText', () => {
  it('returns a non-empty message unchanged', () => {
    expect(postgrestErrorText({ message: 'duplicate key', code: '23505' }, { status: 409 })).toBe(
      'duplicate key',
    );
  });

  it('names the status, code and hint when the message is empty, never the details', () => {
    expect(
      postgrestErrorText(
        {
          message: '',
          code: '23505',
          details: 'Key (email)=(pat.example@example.test) already exists.',
          hint: 'retry',
        },
        { status: 409, statusText: 'Conflict' },
      ),
    ).toBe('HTTP 409 Conflict, code 23505, hint: retry (empty error message)');
  });

  it("keeps a check violation's failing row out of the text", () => {
    const text = postgrestErrorText(
      { message: '', code: '23514', details: 'Failing row contains (Sample Person, 555-0100).' },
      { status: 400, statusText: 'Bad Request' },
    );
    expect(text).toBe('HTTP 400 Bad Request, code 23514 (empty error message)');
    expect(text).not.toContain('Sample Person');
  });

  it('keeps only the first "Caused by:" line of postgrest-js\'s own no-answer details', () => {
    expect(
      postgrestErrorText(
        {
          message: '',
          code: '',
          details:
            'TypeError: fetch failed\n    at node:internal/x\n\nCaused by: ECONNRESET (read)\nError: read\n    at y',
        },
        { status: 0 },
      ),
    ).toBe('no HTTP response, cause: ECONNRESET (read) (empty error message)');
  });

  it('a ServiceError built from it reports no row values', () => {
    const e = new ServiceError(
      'internal_error',
      postgrestErrorText(
        { message: '', code: '23505', details: 'Key (sku)=(SAMPLE-SKU-1) already exists.' },
        { status: 409 },
      ),
    );
    expect(reportedMessage(e)).toBe('HTTP 409, code 23505 (empty error message)');
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

describe('isDefiniteRefusal (F1-5: did the call surely not commit?)', () => {
  it('a SQLSTATE or a PGRST code is a definite answer: the transaction did not commit', () => {
    for (const code of ['P0001', '42501', '55P03', '23505', 'P0002', 'PGRST116', 'PGRST000']) {
      expect(isDefiniteRefusal({ message: 'x', code })).toBe(true);
    }
  });

  it('no code (a dropped connection, a gateway 502 or 504) is NOT: the statement may have committed', () => {
    for (const error of [
      { message: 'TypeError: fetch failed', code: '' },
      { message: 'Bad Gateway' },
      { message: '', code: null },
      { message: 'x', code: 'ECONNRESET' },
      null,
      undefined,
    ]) {
      expect(isDefiniteRefusal(error)).toBe(false);
    }
  });
});

describe('isPermanentRefusal (B82, integrator R4b: will the same request be refused again?)', () => {
  it('bad data, a constraint, or PostgREST refusing the request itself', () => {
    for (const code of ['22P02', '22001', '23502', '23503', '23505', 'PGRST100', 'PGRST116']) {
      expect(isPermanentRefusal({ message: 'x', code })).toBe(true);
    }
  });

  it('class 42 and PGRST2xx/3xx are not: they can be brief here (a migration push, a schema cache miss, pooling, a credential change)', () => {
    for (const code of [
      '42501',
      '42P01',
      '42P05',
      '42703',
      'PGRST202',
      'PGRST204',
      'PGRST205',
      'PGRST300',
      'PGRST301',
    ]) {
      expect(isDefiniteRefusal({ message: 'x', code })).toBe(true);
      expect(isPermanentRefusal({ message: 'x', code })).toBe(false);
    }
  });

  it('a brief failure is not, though isDefiniteRefusal counts it: a retry is what it needs', () => {
    for (const code of [
      '40001',
      '40P01',
      '57014',
      '08006',
      '53300',
      'PGRST000',
      'PGRST001',
      'PGRST002',
      'PGRST003',
    ]) {
      expect(isDefiniteRefusal({ message: 'x', code })).toBe(true);
      expect(isPermanentRefusal({ message: 'x', code })).toBe(false);
    }
  });

  it('no code, or one that is not a SQLSTATE or a PGRST code, is not', () => {
    for (const error of [
      { message: 'TypeError: fetch failed', code: '' },
      { message: 'Bad Gateway' },
      { message: '', code: null },
      { message: 'x', code: 'ECONNRESET' },
      { message: 'x', code: '2350' },
      { message: 'x', code: 'PGRST10' },
    ]) {
      expect(isPermanentRefusal(error)).toBe(false);
    }
    expect(isPermanentRefusal(null)).toBe(false);
    expect(isPermanentRefusal(undefined)).toBe(false);
  });
});
