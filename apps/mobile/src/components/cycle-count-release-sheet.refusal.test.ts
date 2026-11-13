import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readSource } from '../lib/__fixtures__/jsx-touch-audit';
import { screenFunction } from '../lib/__fixtures__/screen-functions';
import { api } from '../lib/api';

/**
 * What the release sheet shows when the server refuses a release (docket
 * S42b). The sheet's own `submit` is RUN from its source (screen-functions.ts)
 * over the REAL api() client, with only the network stood in for, so this is
 * the path a tap on Release count takes on an installed phone: api() throws
 * the body's `message` (ApiError) and the sheet shows it as it is.
 *
 * Since S42 the server answers an assignee who taps Release count again after
 * their first release went through (its answer lost), or whose count a
 * manager released while the sheet was open, 409 "This count was already
 * released." instead of 403 "Only the assigned employee or a manager can
 * release this count.". The phone needs no change for it: it shows whatever
 * sentence the server sends, word for word, and keeps the sheet open.
 */

// vitest hoists vi.hoisted and vi.mock above the imports: the API client
// reads __DEV__ and its native dependencies at load.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('../lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
}));
vi.mock('../lib/account-eviction', () => ({ notifyUnauthorized: vi.fn() }));
vi.mock('../lib/request-cancellation', () => ({ registerInFlight: vi.fn(() => vi.fn()) }));

const SHEET = 'src/components/cycle-count-release-sheet.tsx';
const CC = '11111111-1111-4111-8111-111111111111';
const ALREADY_RELEASED = 'This count was already released.';
const GENERIC = 'Only the assigned employee or a manager can release this count.';

const fetchMock = vi.fn();
function respondWith(status: number, body: unknown) {
  const text = JSON.stringify(body);
  fetchMock.mockImplementation(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  }));
  vi.stubGlobal('fetch', fetchMock);
}

/** The sheet's submit, with its state setters and props as spies. */
function sheet(category = 'Shift ending', notes = '') {
  const setSubmitting = vi.fn();
  const setError = vi.fn();
  const onReleased = vi.fn();
  const submit = screenFunction<() => Promise<void>>(SHEET, 'submit', {
    category,
    notes,
    setSubmitting,
    setError,
    api,
    cycleCountId: CC,
    onReleased,
  });
  return { submit, setSubmitting, setError, onReleased };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the release sheet shows the server’s refusal word for word', () => {
  it('409 already released: the sentence as sent, the sheet stays open and Release count is enabled again', async () => {
    respondWith(409, { error: 'conflict', message: ALREADY_RELEASED });
    const s = sheet();
    await s.submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url.endsWith(`/api/v1/cycle-counts/${CC}/release`)).toBe(true);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ reason: 'Shift ending' });

    expect(s.setError.mock.calls).toEqual([[null], [ALREADY_RELEASED]]);
    expect(s.onReleased).not.toHaveBeenCalled();
    expect(s.setSubmitting.mock.calls).toEqual([[true], [false]]);
  });

  it('403 keeps showing the generic sentence as sent', async () => {
    respondWith(403, { error: 'forbidden', message: GENERIC });
    const s = sheet();
    await s.submit();
    expect(s.setError).toHaveBeenLastCalledWith(GENERIC);
    expect(s.onReleased).not.toHaveBeenCalled();
  });

  it('a release that goes through closes the sheet and shows nothing', async () => {
    respondWith(200, { ok: true, cycleCount: { id: CC, assigned_to: null } });
    const s = sheet('Other', 'Called away');
    await s.submit();
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body)).toEqual({
      reason: 'Called away',
    });
    expect(s.onReleased).toHaveBeenCalledTimes(1);
    expect(s.setError.mock.calls).toEqual([[null]]);
  });

  it('the error the handler sets is the text the sheet draws, in an alert', () => {
    const code = readSource(path.resolve(__dirname, '../..', SHEET));
    expect(code).toMatch(
      /\{error \? \(\s*<Text accessibilityRole="alert" style=\{\[styles\.error, \{ color: c\.critText \}\]\}>\s*\{error\}\s*<\/Text>\s*\) : null\}/,
    );
  });
});
