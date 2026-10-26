import { beforeEach, describe, expect, it, vi } from 'vitest';

import { screenFunction } from './__fixtures__/screen-functions';
import { ApiError } from './api';
import { REQUEST_TIMED_OUT_COPY } from './connection-copy';
import {
  INTEGRATIONS_AAL2_REQUIRED,
  INTEGRATIONS_MFA_REQUIRED,
  disconnect,
  getConnections,
  integrationsMfaSentence,
  isForbiddenError,
  saveAccountMapping,
} from './integrations-api';

/**
 * Settings > Integrations shows "Access denied." when the server refuses the
 * connections read, the mapping save or the disconnect (the module was turned
 * off, or the member is no longer an owner or admin).
 *
 * THE DEFECT (docket B10). isForbiddenError tested the error's MESSAGE for
 * "API 403", the text api() threw before it threw a typed ApiError
 * (2026-07-31). An ApiError's message is the server's sentence and its status
 * is a field, so a 403 never matched: the screen printed the raw server
 * sentence in a red card and never showed its own Access denied state.
 *
 * These run the REAL api() against a stubbed fetch, so the classification is
 * pinned against what api() actually throws (the line-sheets-api-error.test.ts
 * idiom).
 */

// The API client reads __DEV__ and its native dependencies at load. vitest
// hoists vi.hoisted and vi.mock above the imports, so they run first.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
}));
vi.mock('./account-eviction', () => ({ notifyUnauthorized: vi.fn() }));
vi.mock('./request-cancellation', () => ({ registerInFlight: vi.fn(() => vi.fn()) }));

function respondWith(status: number, body: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    })),
  );
}

const MODULE_OFF = JSON.stringify({
  error: 'module_disabled',
  message: 'Module not enabled for this organization: integrations',
});

beforeEach(() => vi.clearAllMocks());

describe('Integrations: a refusal from the server is the Access denied state', () => {
  it('the 403 api() throws for a connections read is a refusal', async () => {
    respondWith(403, MODULE_OFF);
    const err = await getConnections().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect(isForbiddenError(err)).toBe(true);
  });

  it('a 403 whose body is not our JSON (an edge page) is a refusal too', async () => {
    respondWith(403, '<!doctype html><title>Forbidden</title>');
    const err = await getConnections().catch((e: unknown) => e);
    expect(isForbiddenError(err)).toBe(true);
  });

  it('a 403 from the mapping save and from the disconnect is a refusal', async () => {
    respondWith(403, JSON.stringify({ error: 'forbidden', message: 'Owners and admins only.' }));
    const saved = await saveAccountMapping('quickbooks', {
      billExpense: '1',
      inventoryAsset: '2',
      valuationOffset: '3',
    }).catch((e: unknown) => e);
    expect(isForbiddenError(saved)).toBe(true);
    const gone = await disconnect('quickbooks').catch((e: unknown) => e);
    expect(isForbiddenError(gone)).toBe(true);
  });

  it.each([401, 404, 409, 500])(
    'a %i is not a refusal of access to Integrations',
    async (status) => {
      respondWith(status, JSON.stringify({ error: 'x', message: 'Something else.' }));
      const err = await getConnections().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(isForbiddenError(err)).toBe(false);
    },
  );

  it('no answer at all (a timeout, a dropped connection) is not a refusal', () => {
    expect(isForbiddenError(new Error(REQUEST_TIMED_OUT_COPY))).toBe(false);
    expect(isForbiddenError(new TypeError('Network request failed'))).toBe(false);
  });

  it('a value that is not an error is not a refusal', () => {
    expect(isForbiddenError({ status: 403 })).toBe(false);
    expect(isForbiddenError(null)).toBe(false);
    expect(isForbiddenError('403')).toBe(false);
  });
});

/**
 * THE MFA GATE (docket B10 review). The server runs it before the permission
 * check on the mapping save and the disconnect, and answers 403 with
 * details.reason. Read as Access denied, an owner or admin who only had to
 * sign in again with their code (or set up a factor) lost the screen to
 * "Reopen this screen after an admin updates access". The bodies are the
 * server's own (mfaGateError, forwarded with its details).
 */
const STEP_UP = JSON.stringify({
  error: 'forbidden',
  message: 'Re-authenticate with MFA before performing this action.',
  details: { reason: 'aal2_required' },
});
const ENROLL = JSON.stringify({
  error: 'forbidden',
  message: 'Multi-factor authentication required. Enroll in MFA before performing this action.',
  details: { reason: 'mfa_required' },
});
const NO_PERMISSION = JSON.stringify({
  error: 'forbidden',
  message: 'Missing permission: integrations:manage',
});
const MAPPING = { billExpense: '1', inventoryAsset: '2', valuationOffset: '3' };

describe("Integrations: the MFA gate's refusal is not Access denied", () => {
  it.each([
    ['sign in again with the code', STEP_UP, INTEGRATIONS_AAL2_REQUIRED],
    ['set up a factor', ENROLL, INTEGRATIONS_MFA_REQUIRED],
  ])('%s: the save and the disconnect say so', async (_what, body, sentence) => {
    respondWith(403, body);
    for (const call of [
      () => saveAccountMapping('quickbooks', MAPPING),
      () => disconnect('quickbooks'),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(isForbiddenError(err)).toBe(false);
      expect(integrationsMfaSentence(err)).toBe(sentence);
    }
  });

  it('a missing permission, the module off and a 403 for any other reason stay Access denied', async () => {
    for (const body of [
      NO_PERMISSION,
      MODULE_OFF,
      JSON.stringify({ error: 'forbidden', message: 'No.', details: { reason: 'other' } }),
      '<!doctype html><title>Forbidden</title>',
    ]) {
      respondWith(403, body);
      const err = await disconnect('quickbooks').catch((e: unknown) => e);
      expect(isForbiddenError(err)).toBe(true);
      expect(integrationsMfaSentence(err)).toBeNull();
    }
  });

  it('the reason on any status but 403, or on a value that is not an error, is not the gate', () => {
    const reason = { reason: 'aal2_required' };
    expect(integrationsMfaSentence(new ApiError('x', 401, 'unauthenticated', reason))).toBeNull();
    expect(integrationsMfaSentence({ status: 403, details: reason })).toBeNull();
    expect(integrationsMfaSentence(new Error(REQUEST_TIMED_OUT_COPY))).toBeNull();
    expect(integrationsMfaSentence(null)).toBeNull();
  });
});

describe("Settings > Integrations (app/(drawer)/settings/integrations.tsx) on the MFA gate's refusal", () => {
  const SCREEN = 'app/(drawer)/settings/integrations.tsx';

  /** The screen's handlers, RUN from its source with the real api() under them. */
  function handlers() {
    const alert = vi.fn();
    const setForbidden = vi.fn();
    const deps = {
      PROVIDER: 'quickbooks',
      Alert: { alert },
      setForbidden,
      load: vi.fn(async () => undefined),
      isForbiddenError,
      integrationsMfaSentence,
      // onSave's form state
      saving: false,
      billExpense: MAPPING.billExpense,
      inventoryAsset: MAPPING.inventoryAsset,
      valuationOffset: MAPPING.valuationOffset,
      setSaving: vi.fn(),
      saveAccountMapping,
      disconnectConnection: disconnect,
    };
    return {
      alert,
      setForbidden,
      onSave: screenFunction<() => Promise<void>>(SCREEN, 'onSave', deps),
      onDisconnect: screenFunction<() => void>(SCREEN, 'onDisconnect', deps),
    };
  }

  /** Disconnect asks first; this taps its Disconnect button. */
  async function confirmDisconnect(alert: ReturnType<typeof vi.fn>) {
    const buttons = alert.mock.calls[0]![2] as { text: string; onPress?: () => Promise<void> }[];
    await buttons.find((b) => b.text === 'Disconnect')!.onPress!();
  }

  it.each([
    [STEP_UP, INTEGRATIONS_AAL2_REQUIRED],
    [ENROLL, INTEGRATIONS_MFA_REQUIRED],
  ])('Save mapping and Disconnect say what to do, and the screen stays', async (body, sentence) => {
    respondWith(403, body);
    const save = handlers();
    await save.onSave();
    expect(save.setForbidden).not.toHaveBeenCalled();
    expect(save.alert.mock.calls).toEqual([['Could not save', sentence]]);

    const drop = handlers();
    drop.onDisconnect();
    await confirmDisconnect(drop.alert);
    expect(drop.setForbidden).not.toHaveBeenCalled();
    expect(drop.alert.mock.calls[1]).toEqual(['Could not disconnect', sentence]);
  });

  it('a missing permission is still the Access denied state, with no alert', async () => {
    respondWith(403, NO_PERMISSION);
    const save = handlers();
    await save.onSave();
    expect(save.setForbidden).toHaveBeenCalledWith(true);
    expect(save.alert).not.toHaveBeenCalled();

    const drop = handlers();
    drop.onDisconnect();
    await confirmDisconnect(drop.alert);
    expect(drop.setForbidden).toHaveBeenCalledWith(true);
    expect(drop.alert).toHaveBeenCalledTimes(1);
  });
});
