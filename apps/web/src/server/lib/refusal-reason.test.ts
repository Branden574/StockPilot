import { describe, expect, it } from 'vitest';

import { mfaGateError, ServiceError } from '@/server/services/context';

import { refusalReasonDetails } from './refusal-reason';

/**
 * Security invariant: the queued-change routes forward from a refused
 * ServiceError's `details` only a string `reason`, as `{ details: { reason } }`.
 * No other field (an id, a name) and nothing at all for an internal_error or
 * for details without a string reason.
 */
describe('refusalReasonDetails', () => {
  it.each([
    ['mfa_required', mfaGateError({ mfaEnrolled: false })],
    ['aal2_required', mfaGateError({ mfaEnrolled: true })],
    [
      'assigned_to_another_user',
      new ServiceError('forbidden', 'Example sentence.', { reason: 'assigned_to_another_user' }),
    ],
  ])('forwards the %s reason exactly', (reason, e) => {
    expect(refusalReasonDetails(e)).toEqual({ details: { reason } });
  });

  it('forwards only the reason from details with other fields', () => {
    const e = new ServiceError('conflict', 'Example sentence.', {
      reason: 'example_reason',
      itemId: '11111111-0000-4000-8000-000000000001',
      name: 'Example item name',
      sku: 'EXAMPLE-SKU-1',
    });
    const out = refusalReasonDetails(e);
    expect(out).toEqual({ details: { reason: 'example_reason' } });
    const text = JSON.stringify(out);
    expect(text).not.toContain('11111111-0000-4000-8000-000000000001');
    expect(text).not.toContain('Example item name');
    expect(text).not.toContain('EXAMPLE-SKU-1');
  });

  it.each([
    ['a number', 7],
    ['an object', { code: 'example' }],
    ['null', null],
    ['an array', ['mfa_required']],
  ])('forwards nothing when the reason is %s', (_kind, reason) => {
    const e = new ServiceError('forbidden', 'Example sentence.', {
      reason,
      itemId: '11111111-0000-4000-8000-000000000001',
    });
    expect(refusalReasonDetails(e)).toEqual({});
  });

  it('forwards nothing for details without a reason, or no details', () => {
    expect(
      refusalReasonDetails(new ServiceError('validation_error', 'Example sentence.', { count: 3 })),
    ).toEqual({});
    expect(
      refusalReasonDetails(new ServiceError('forbidden', 'Missing permission: stock:adjust')),
    ).toEqual({});
  });

  it('forwards nothing for an internal_error, even with a string reason', () => {
    const e = new ServiceError('internal_error', 'relation "example_table" is busy', {
      reason: 'busy',
      retryable: true,
    });
    expect(refusalReasonDetails(e)).toEqual({});
  });
});
