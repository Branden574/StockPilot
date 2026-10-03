import { redirect } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A SIGNED-OUT SESSION REDIRECTS FROM EVERY EXCEPTIONS ACTION. withContext()
 * answers a missing session with redirect('/signin'), which Next.js carries
 * as a thrown NEXT_REDIRECT. Every action here catches what it throws to word
 * a failure, and that catch used to turn the redirect into "Something went
 * wrong" and report it as an error (the phone's 401 was fixed to say the
 * session ended in the same release). The redirect is now rethrown, as the
 * rental and label actions do, so the browser goes to sign-in and nothing is
 * reported.
 */

const { withContextMock, reportError } = vi.hoisted(() => ({
  withContextMock: vi.fn(),
  reportError: vi.fn(async () => undefined),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 5_000 })),
}));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: withContextMock,
}));

import {
  actOnExceptionAction,
  confirmExceptionCountAction,
  escalateExceptionAction,
  finalizeExceptionEvidenceAction,
  listCountAssigneesAction,
  listItemRecountTargetsAction,
  listItemsRecountTargetsAction,
  removeExceptionEvidenceAction,
  requestExceptionCheckAction,
  startExceptionEvidenceUploadAction,
  startRecountAction,
} from './exceptions';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function signInRedirect(): unknown {
  try {
    redirect('/signin');
  } catch (e) {
    return e;
  }
  throw new Error('redirect() did not throw');
}

/** Every action the module exports, called with input that passes its own
 *  checks, so each reaches withContext(). */
const ACTIONS: Array<[string, () => Promise<unknown>]> = [
  ['actOnExceptionAction', () => actOnExceptionAction(ID, { action: 'acknowledge' })],
  [
    'confirmExceptionCountAction',
    () => confirmExceptionCountAction(ID, { cycleCountId: OTHER, countedQuantity: 2, note: null }),
  ],
  ['requestExceptionCheckAction', () => requestExceptionCheckAction()],
  ['startRecountAction', () => startRecountAction({ occurrenceIds: [ID], idempotencyKey: 'k-1' })],
  ['listCountAssigneesAction', () => listCountAssigneesAction()],
  ['listItemRecountTargetsAction', () => listItemRecountTargetsAction(ID)],
  ['listItemsRecountTargetsAction', () => listItemsRecountTargetsAction([ID])],
  ['startExceptionEvidenceUploadAction', () => startExceptionEvidenceUploadAction(ID, { fileExt: 'jpg' })],
  [
    'finalizeExceptionEvidenceAction',
    () => finalizeExceptionEvidenceAction(ID, { path: 'p', declaredMime: 'image/jpeg' }),
  ],
  ['removeExceptionEvidenceAction', () => removeExceptionEvidenceAction(ID, OTHER, null)],
  ['escalateExceptionAction', () => escalateExceptionAction(ID, {})],
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a signed-out session', () => {
  it('lists every exported action', async () => {
    const mod = await import('./exceptions');
    const exported = Object.entries(mod)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort();
    expect(ACTIONS.map(([name]) => name).sort()).toEqual(exported);
  });

  it.each(ACTIONS)('%s rethrows the sign-in redirect and reports nothing', async (_name, run) => {
    const redirectError = signInRedirect();
    withContextMock.mockRejectedValueOnce(redirectError);
    await expect(run()).rejects.toBe(redirectError);
    expect(withContextMock).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
  });
});
