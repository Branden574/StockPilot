import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reportError } from '@/lib/error-reporter';

import { ServiceError } from '../context';
import { rawErrorText, reportDegradedRead, settleAsDataError } from './fetch-by-ids';

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

/**
 * rawErrorText is the text a server log or a degraded-read report carries for
 * a failure (docket C21). A failed supabase-js call's `error` is a plain
 * object, and String() of it is "[object Object]": a report's `detail` (16
 * report sites) and three inventory messages read that, with the database's
 * reason gone. It now follows the reporter's rule (lib/error-text.ts):
 * message and code, never the server's `details`.
 */
describe('rawErrorText', () => {
  it("keeps a plain error object's message and code", () => {
    expect(
      rawErrorText({ message: 'canceling statement due to statement timeout', code: '57014' }),
    ).toBe('canceling statement due to statement timeout (code 57014)');
  });

  it('keeps what it answered before for a ServiceError, an Error and a string', () => {
    expect(rawErrorText(new ServiceError('internal_error', 'raw'))).toBe('raw');
    expect(rawErrorText(new Error('m'))).toBe('m');
    expect(rawErrorText('s')).toBe('s');
  });

  it('a read adapted by settleAsDataError keeps the text of a thrown plain object', async () => {
    expect(
      await settleAsDataError(Promise.reject({ message: 'deadlock detected', code: '40P01' })),
    ).toEqual({ data: null, error: { message: 'deadlock detected (code 40P01)' } });
  });
});

describe('reportDegradedRead', () => {
  beforeEach(() => {
    vi.mocked(reportError).mockClear();
  });

  it("reports a plain error object's message and code in detail, and never its details", () => {
    reportDegradedRead('dashboard-actions', {
      message: 'x',
      code: '42501',
      details: 'Key (email)=(someone@example.com) already exists.',
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = vi.mocked(reportError).mock.calls[0]!;
    expect((reported as Error).message).toBe('Id-list lookup failed; showing the page without it');
    expect(context.tag).toBe('dashboard-actions');
    expect(context.level).toBe('warning');
    expect(context.extra?.detail).toBe('x (code 42501)');
    expect(JSON.stringify(context)).not.toContain('someone@example.com');
  });
});
