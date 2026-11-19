import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PermissionsUnavailableError } from '@/lib/auth/effective-permissions';
import { reportError } from '@/lib/error-reporter';
import { ServiceError } from '@/server/services/context';

import { serviceErrorResponse } from './service-error-response';

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

describe('serviceErrorResponse', () => {
  beforeEach(() => {
    vi.mocked(reportError).mockClear();
  });

  it.each([
    ['unauthenticated', 401],
    ['forbidden', 403],
    ['module_disabled', 403],
    ['not_found', 404],
    ['validation_error', 400],
    ['conflict', 409],
    ['plan_limit_exceeded', 409],
  ] as const)('%s answers %i with its words, unreported', async (code, status) => {
    const res = serviceErrorResponse(new ServiceError(code, 'Made-up sentence.'), 'test.tag');
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code, message: 'Made-up sentence.' });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a refusal carries the details the service wrote', async () => {
    const res = serviceErrorResponse(
      new ServiceError('forbidden', 'Step up first.', { reason: 'aal2_required' }),
      'test.tag',
    );
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: 'Step up first.',
      details: { reason: 'aal2_required' },
    });
  });

  it('internal_error answers the fixed sentence without details and is reported once', async () => {
    const err = new ServiceError('internal_error', 'relation "made_up_table" does not exist', {
      row: 'made-up value',
    });
    const res = serviceErrorResponse(err, 'test.tag', { organizationId: 'org-1' });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'internal_error',
      message: 'Something went wrong. Please try again.',
    });
    expect(text).not.toContain('made_up_table');
    expect(text).not.toContain('made-up value');
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(err, { tag: 'test.tag', organizationId: 'org-1' });
  });

  it('anything else is answered and reported as internalErrorResponse answers it', async () => {
    const err = new TypeError('Cannot read properties of undefined');
    const res = serviceErrorResponse(err, 'test.tag');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'internal_error',
      message: 'Something went wrong. Please try again.',
    });
    expect(reportError).toHaveBeenCalledWith(err, { tag: 'test.tag' });
  });

  it('a check that could not run keeps its own sentence, reported as a warning', async () => {
    const err = new PermissionsUnavailableError();
    const res = serviceErrorResponse(err, 'test.tag');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error', message: err.message });
    expect(reportError).toHaveBeenCalledWith(err, { tag: 'test.tag', level: 'warning' });
  });
});
