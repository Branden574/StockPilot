import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Sentry reports only from real phones (2026-10-12). A Release build made on a
 * Mac for the iOS simulator inlines EXPO_PUBLIC_SENTRY_DSN from
 * apps/mobile/.env.local, and with !__DEV__ as the only gate it reported as
 * 'production': a 2-second hang while a simulator test walk sat on the sign-in
 * screen reached the owner as a new production issue. The event's user id was
 * the simulator's own Sentry installation id, so no real phone was involved.
 *
 * sentry.ts reads the DSN when it loads, so each case loads a fresh copy.
 */

const TEST_DSN = 'https://public@example.invalid/1';

async function initWith(opts: { dsn: string; isDevice: boolean }) {
  vi.resetModules();
  const init = vi.fn();
  vi.doMock('@sentry/react-native', () => ({ init }));
  vi.doMock('expo-constants', () => ({
    default: { expoConfig: { version: '1.4.0' } },
  }));
  vi.doMock('expo-device', () => ({ isDevice: opts.isDevice }));
  vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', opts.dsn);
  vi.stubGlobal('__DEV__', false);
  const { initSentry } = await import('./sentry');
  initSentry();
  return init;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('initSentry', () => {
  it('starts Sentry on a real phone in a Release build', async () => {
    const init = await initWith({ dsn: TEST_DSN, isDevice: true });
    expect(init).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0][0]).toMatchObject({
      dsn: TEST_DSN,
      enabled: true,
      environment: 'production',
      release: 'stockpilot@1.4.0',
    });
  });

  it('never starts Sentry in the simulator, even with the DSN built in', async () => {
    const init = await initWith({ dsn: TEST_DSN, isDevice: false });
    expect(init).not.toHaveBeenCalled();
  });

  it('stays dormant without a DSN', async () => {
    const init = await initWith({ dsn: '', isDevice: true });
    expect(init).not.toHaveBeenCalled();
  });
});
