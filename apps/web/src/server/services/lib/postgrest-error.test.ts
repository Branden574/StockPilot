import { describe, expect, it } from 'vitest';

import { isDefiniteRefusal, isPermanentRefusal, postgrestErrorText } from './postgrest-error';

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

describe('isPermanentRefusal (B82, integrator R4: will the same request be refused again?)', () => {
  it('bad data, a constraint, a missing table, column or right, or PostgREST refusing the request', () => {
    for (const code of [
      '22P02',
      '22001',
      '23502',
      '23503',
      '23505',
      '42501',
      '42P01',
      '42703',
      'PGRST100',
      'PGRST116',
      'PGRST204',
      'PGRST205',
      'PGRST300',
      'PGRST301',
    ]) {
      expect(isPermanentRefusal({ message: 'x', code })).toBe(true);
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
