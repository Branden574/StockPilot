import { describe, expect, it } from 'vitest';

import { parseUserAgent } from './user-agent';

describe('parseUserAgent', () => {
  it('parses Chrome on macOS', () => {
    const r = parseUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    );
    expect(r.browser).toBe('Chrome');
    expect(r.os).toBe('macOS');
    expect(r.label).toBe('Chrome on macOS');
  });

  it('parses Safari on iPhone', () => {
    const r = parseUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    );
    expect(r.browser).toBe('Safari');
    expect(r.os).toBe('iOS');
  });

  it('labels the native mobile app (Expo user agent)', () => {
    const r = parseUserAgent('StockPilot/1.0.2 (iPhone; iOS 17.0) Expo');
    expect(r.label).toBe('StockPilot app on iOS');
  });

  it('falls back gracefully on null / unknown', () => {
    expect(parseUserAgent(null).label).toBe('Unknown device');
    expect(parseUserAgent('weird-bot/1.0').label).toBe('Unknown browser on Unknown OS');
  });
});
