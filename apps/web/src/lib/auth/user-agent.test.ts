import { describe, expect, it } from 'vitest';

import { browserDeviceName, parseUserAgent } from './user-agent';

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

describe('browserDeviceName: a web sign-in\u2019s device, from fixed words only', () => {
  const FIXED_WORDS =
    /^(Edge|Opera|Brave|Chrome|Firefox|Safari|Unknown browser) on (iOS|Android|macOS|Windows|Linux|Unknown OS)$/;

  it('names the browser and the system', () => {
    expect(
      browserDeviceName(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      ),
    ).toBe('Chrome on macOS');
    expect(
      browserDeviceName(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      ),
    ).toBe('Edge on Windows');
    expect(
      browserDeviceName(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iOS');
  });

  it('an agent that names neither, or no agent, is "Unknown browser on Unknown OS"', () => {
    for (const ua of [null, '', '   ', 'weird-bot/1.0', '<https://example.com/x|Open> Size <10>']) {
      expect(browserDeviceName(ua)).toBe('Unknown browser on Unknown OS');
    }
  });

  it('has no app branch: an agent that says it is the app is still named as a browser', () => {
    expect(browserDeviceName('StockPilot/1.0.2 (iPhone; iOS 17.0) Expo')).toBe(
      'Unknown browser on iOS',
    );
    expect(browserDeviceName('Expo StockPilot/1')).toBe('Unknown browser on Unknown OS');
    // Active sessions keeps its own words for the app.
    expect(parseUserAgent('StockPilot/1.0.2 (iPhone; iOS 17.0) Expo').label).toBe(
      'StockPilot app on iOS',
    );
  });

  it('whatever the agent says, the name is one of the fixed words (200 seeded agents)', () => {
    // A small seeded generator, so a failure names the same agent every run.
    let seed = 20261112;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    const PIECES = [
      'Mozilla/5.0',
      'Chrome/120.0',
      'Safari/604.1',
      'Firefox/128.0',
      'Edg/126.0',
      'OPR/110.0',
      'Brave',
      'Opera',
      'Expo',
      'StockPilot/1',
      '(iPhone; CPU iPhone OS 17_0)',
      'iPad',
      'Android 14',
      'Macintosh; Intel Mac OS X',
      'Windows NT 10.0',
      'X11; Linux x86_64',
      '<https://example.com|Open>',
      '[x](https://example.com)',
      'Size <10> & up',
      '\n',
      '`',
      '*bold*',
      '\u202E',
      'on',
      '  ',
    ];
    for (let i = 0; i < 200; i++) {
      const agent = Array.from(
        { length: 1 + (next() % 6) },
        () => PIECES[next() % PIECES.length],
      ).join(' ');
      const name = browserDeviceName(agent);
      expect(name, JSON.stringify(agent)).toMatch(FIXED_WORDS);
      expect(name, JSON.stringify(agent)).not.toContain('StockPilot');
    }
  });
});
