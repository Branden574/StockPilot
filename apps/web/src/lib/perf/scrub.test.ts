import type { CaptureResult } from 'posthog-js';
import { describe, expect, it } from 'vitest';

import { scrubPerfEvent } from './scrub';

/**
 * rum.ts decides what WE put on a perf event. This hook deals with what the
 * PostHog SDK adds to it afterwards: the current URL, the referrer, the page
 * title, the session's entry URL. The fixture below is the shape the SDK
 * really sends from an item page reached from a search.
 */

const UUID = '3f2c1a9e-7b4d-4c1e-9a2f-0d5e6f7a8b9c';
const ITEM_URL = `https://app.stockpilotusa.com/dashboard/inventory/${UUID}?q=acme+widget&return=%2Fdashboard%2Finventory`;

function sdkEvent(event: string, extra: Record<string, unknown> = {}): CaptureResult {
  return {
    uuid: '0190c0de-0000-7000-8000-000000000001',
    event,
    properties: {
      $current_url: ITEM_URL,
      $pathname: `/dashboard/inventory/${UUID}`,
      $host: 'app.stockpilotusa.com',
      $referrer: 'https://app.stockpilotusa.com/dashboard/inventory?q=jane%40example.com',
      $referring_domain: 'app.stockpilotusa.com',
      $session_entry_url: `https://app.stockpilotusa.com/dashboard/orders/1042?token=abc`,
      $session_entry_pathname: '/dashboard/orders/1042',
      $session_entry_referrer: 'https://mail.google.com/',
      $session_entry_referring_domain: 'mail.google.com',
      $prev_pageview_pathname: `/dashboard/inventory/${UUID}/edit`,
      $title: 'Acme Widget (SKU AB-1042) · StockPilot',
      title: 'Acme Widget (SKU AB-1042) · StockPilot',
      $browser: 'Chrome',
      $browser_version: 140,
      $device_type: 'Desktop',
      $lib: 'web',
      $session_id: '0190c0de-aaaa-7000-8000-000000000002',
      $viewport_width: 1440,
      $set_once: {
        $initial_current_url: ITEM_URL,
        $initial_pathname: `/dashboard/inventory/${UUID}`,
        $initial_referrer: 'https://mail.google.com/',
        $initial_browser: 'Chrome',
      },
      ...extra,
    },
    $set: { $current_url: ITEM_URL, $browser: 'Chrome' },
    $set_once: { $initial_current_url: ITEM_URL, $initial_referring_domain: 'mail.google.com' },
  };
}

describe('scrubPerfEvent: a perf event', () => {
  const ours = { route: '/dashboard/inventory/[id]', click_to_useful_ms: 742, nav_kind: 'soft-nav' };

  it('gets the route TEMPLATE as its url and pathname', () => {
    const out = scrubPerfEvent(sdkEvent('perf_navigation', ours));
    expect(out?.properties.$current_url).toBe('/dashboard/inventory/[id]');
    expect(out?.properties.$pathname).toBe('/dashboard/inventory/[id]');
  });

  it('derives the template from $current_url when the SDK sent no $pathname', () => {
    const event = sdkEvent('perf_web_vital');
    delete event.properties.$pathname;
    const out = scrubPerfEvent(event);
    expect(out?.properties.$pathname).toBe('/dashboard/inventory/[id]');
    expect(out?.properties.$current_url).toBe('/dashboard/inventory/[id]');
  });

  it('invents no url when the SDK sent neither', () => {
    const out = scrubPerfEvent({
      uuid: 'u',
      event: 'perf_images',
      properties: { route: '/dashboard', image_count: 12 },
    });
    expect(out?.properties).toEqual({ route: '/dashboard', image_count: 12 });
  });

  it('carries no id, search term, email, token, title or referrer anywhere in the payload', () => {
    const wire = JSON.stringify(scrubPerfEvent(sdkEvent('perf_navigation', ours)));
    for (const leak of [
      UUID,
      'acme',
      'jane',
      'example.com',
      'token=',
      'AB-1042',
      'Acme Widget',
      'mail.google.com',
      '1042',
      'https://',
      'return=',
    ]) {
      expect(wire).not.toContain(leak);
    }
  });

  it('keeps what a performance chart does need: our properties and the SDK’s harmless ones', () => {
    const out = scrubPerfEvent(sdkEvent('perf_navigation', ours));
    expect(out?.properties).toMatchObject({
      ...ours,
      $host: 'app.stockpilotusa.com',
      $browser: 'Chrome',
      $browser_version: 140,
      $device_type: 'Desktop',
      $lib: 'web',
      $session_id: '0190c0de-aaaa-7000-8000-000000000002',
      $viewport_width: 1440,
    });
    expect(out?.properties.$set_once).toEqual({ $initial_browser: 'Chrome' });
    expect(out?.$set).toEqual({ $browser: 'Chrome' });
    expect(out?.$set_once).toEqual({});
    expect(out?.uuid).toBe('0190c0de-0000-7000-8000-000000000001');
    expect(out?.event).toBe('perf_navigation');
  });

  it('does not mutate the event it was given', () => {
    const event = sdkEvent('perf_navigation', ours);
    const before = JSON.stringify(event);
    scrubPerfEvent(event);
    expect(JSON.stringify(event)).toBe(before);
  });

  it('templates a share path too, should one ever get this far', () => {
    const out = scrubPerfEvent({
      uuid: 'u',
      event: 'perf_web_vital',
      properties: { $pathname: `/r/${'a'.repeat(64)}`, $current_url: `https://x.test/r/${'a'.repeat(64)}` },
    });
    expect(out?.properties.$pathname).toBe('/r/[token]');
    expect(JSON.stringify(out)).not.toContain('aaaa');
  });
});

describe('scrubPerfEvent: every other event', () => {
  it('is returned untouched, the very same object', () => {
    for (const name of ['$pageview', '$autocapture', 'order_submitted', 'performance_review', 'xperf_']) {
      const event = sdkEvent(name);
      const before = JSON.stringify(event);
      expect(scrubPerfEvent(event)).toBe(event);
      expect(JSON.stringify(event)).toBe(before);
    }
  });
});

describe('scrubPerfEvent: never throws', () => {
  it('returns null for null, the one input that may become null', () => {
    expect(scrubPerfEvent(null)).toBeNull();
  });

  it('hands odd shapes straight back', () => {
    const odd: unknown[] = [undefined, 0, '', 'perf_navigation', [], () => {}, { event: 42 }, {}];
    for (const value of odd) {
      expect(() => scrubPerfEvent(value as CaptureResult)).not.toThrow();
      expect(scrubPerfEvent(value as CaptureResult)).toBe(value);
    }
  });

  it('copes with a perf event whose properties are missing or not an object', () => {
    for (const properties of [undefined, null, 'nope', 7, ['a']]) {
      const event = { uuid: 'u', event: 'perf_images', properties } as unknown as CaptureResult;
      expect(() => scrubPerfEvent(event)).not.toThrow();
      expect(scrubPerfEvent(event)?.event).toBe('perf_images');
    }
  });

  it('FAILS CLOSED on a perf event it cannot read: dropped, never sent unscrubbed', () => {
    const hostile = {
      uuid: 'u',
      event: 'perf_navigation',
      get properties(): never {
        throw new Error('getter exploded');
      },
    } as unknown as CaptureResult;
    expect(() => scrubPerfEvent(hostile)).not.toThrow();
    expect(scrubPerfEvent(hostile)).toBeNull();
  });

  it('leaves alone an event whose NAME cannot be read', () => {
    const hostile = {
      get event(): never {
        throw new Error('getter exploded');
      },
    } as unknown as CaptureResult;
    expect(scrubPerfEvent(hostile)).toBe(hostile);
  });
});
