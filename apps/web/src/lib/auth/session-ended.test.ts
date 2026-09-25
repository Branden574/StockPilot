import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));

import { isSessionEndedError, orSessionEnded, SESSION_ENDED_PATH, SessionEndedError } from './session-ended';

describe('orSessionEnded', () => {
  it('passes a successful read through', async () => {
    await expect(orSessionEnded(Promise.resolve([1]))).resolves.toEqual([1]);
  });
  it('turns an ENDED session into a redirect to the cookie-clearing route', async () => {
    await expect(orSessionEnded(Promise.reject(new SessionEndedError()))).rejects.toThrow(`REDIRECT:${SESSION_ENDED_PATH}`);
  });
  it('rethrows every other failure unchanged (fail closed)', async () => {
    const boom = new Error('unreadable');
    await expect(orSessionEnded(Promise.reject(boom))).rejects.toBe(boom);
  });
  it('recognises the error by name across module copies', () => {
    expect(isSessionEndedError({ name: 'SessionEndedError' })).toBe(true);
    expect(isSessionEndedError(new Error('x'))).toBe(false);
    expect(isSessionEndedError(null)).toBe(false);
  });
});
