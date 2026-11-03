import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The phone's sign-in and sign-out notes (S5, plans/S5.md 3.3 step 6).
 *
 * THE DEFECT. The phone signs in and out against GoTrue directly, so no phone
 * sign-in or sign-out ever reached the Audit log, and a new phone never sent
 * the new-device email the web sends. Each note is one bounded request
 * through api(); a failure is only warned and never holds a sign-in or a
 * sign-out.
 *
 * The device is named by its MODEL (expo-device modelName), never by
 * deviceName, which on iOS is the name a person gave the phone and often
 * carries their own name.
 */

const api = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ api: (...a: unknown[]) => api(...a) }));
const installId = vi.hoisted(() => ({
  value: '0f6c2d1e-8a4b-4c5d-9e6f-7a8b9c0d1e2f' as string | null,
}));
vi.mock('./install-id', () => ({ getInstallId: async () => installId.value }));
vi.mock('expo-device', () => ({
  modelName: 'iPhone 15 Pro',
  osName: 'iOS',
  osVersion: '18.1',
  deviceName: 'Example Person’s iPhone',
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.4.0' } } }));

import {
  sendSignedInNote,
  sendSignedOutNote,
  SIGNED_IN_NOTE_TIMEOUT_MS,
  SIGNED_OUT_NOTE_TIMEOUT_MS,
} from './auth-notes';

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue({ ok: true });
  installId.value = '0f6c2d1e-8a4b-4c5d-9e6f-7a8b9c0d1e2f';
  warn?.mockRestore();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('sendSignedInNote', () => {
  it('posts this install’s id and the device’s model, system and app version, with an 8 s timeout', async () => {
    await sendSignedInNote();
    expect(SIGNED_IN_NOTE_TIMEOUT_MS).toBe(8_000);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/api/v1/auth/signed-in', {
      method: 'POST',
      body: {
        installId: '0f6c2d1e-8a4b-4c5d-9e6f-7a8b9c0d1e2f',
        device: { model: 'iPhone 15 Pro', osName: 'iOS', osVersion: '18.1', appVersion: '1.4.0' },
      },
      timeoutMs: 8_000,
    });
  });

  it('never sends the name a person gave the phone', async () => {
    await sendSignedInNote();
    expect(JSON.stringify(api.mock.calls[0])).not.toContain('Example Person');
    const code = readFileSync(path.join(__dirname, 'auth-notes.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/deviceName/);
  });

  it('no install id (the Keychain refused): the note still goes, with none', async () => {
    installId.value = null;
    await sendSignedInNote();
    expect((api.mock.calls[0]![1] as { body: { installId: unknown } }).body.installId).toBeNull();
  });

  it('a failure is only warned', async () => {
    api.mockRejectedValueOnce(new Error('Network request failed'));
    await expect(sendSignedInNote()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[auth] could not record this sign-in', expect.any(Error));
  });
});

describe('sendSignedOutNote', () => {
  it('posts an empty body with a 6 s timeout', async () => {
    await sendSignedOutNote();
    expect(SIGNED_OUT_NOTE_TIMEOUT_MS).toBe(6_000);
    expect(api).toHaveBeenCalledWith('/api/v1/auth/signed-out', {
      method: 'POST',
      body: {},
      timeoutMs: 6_000,
    });
  });

  it('a failure is only warned', async () => {
    api.mockRejectedValueOnce(new Error('You do not have access to that.'));
    await expect(sendSignedOutNote()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[auth] could not record this sign-out', expect.any(Error));
  });
});
