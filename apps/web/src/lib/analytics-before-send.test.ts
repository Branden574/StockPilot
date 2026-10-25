import type { CaptureResult } from 'posthog-js';
import { describe, expect, it } from 'vitest';

import { scrubAnalyticsEvent } from './analytics-before-send';

/**
 * PostHog's before_send (docket B39 review). The SDK decorates every event with
 * the page URL ($current_url), the referrer, the first and the session-entry
 * URL (also in the $set_once person bag), and on autocapture the clicked
 * element's href. On /signin?redirect=/invite/<token> (the invite page's Sign in
 * link) each of those carried the invite token to the vendor: before_send
 * returned every event that is not a perf_ event untouched. Shapes below are
 * the property names posthog-js 1.433 sets; placeholder values only.
 */

const TOKEN = 'placeholdertoken0000000000000000';
const SIGNIN = `https://app.example.test/signin?redirect=/invite/${TOKEN}`;
const INVITE = `https://app.example.test/invite/${TOKEN}`;

function event(partial: Record<string, unknown>): CaptureResult {
  return { uuid: '00000000-0000-4000-8000-000000000000', ...partial } as unknown as CaptureResult;
}

describe('scrubAnalyticsEvent', () => {
  it('takes the invite token out of every URL a $pageview on /signin carries', () => {
    const out = scrubAnalyticsEvent(
      event({
        event: '$pageview',
        properties: {
          $current_url: SIGNIN,
          $pathname: '/signin',
          $host: 'app.example.test',
          $referrer: INVITE,
          $referring_domain: 'app.example.test',
          $session_entry_url: SIGNIN,
          $set_once: { $initial_current_url: SIGNIN, $initial_referrer: INVITE },
          $browser: 'Chrome',
        },
        $set_once: { $initial_current_url: SIGNIN },
      }),
    );
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    const properties = out?.properties as Record<string, unknown>;
    expect(properties.$current_url).toBe(
      'https://app.example.test/signin?redirect=/invite/[redacted]',
    );
    expect(properties.$referrer).toBe('https://app.example.test/invite/[redacted]');
    // Everything else as the SDK set it.
    expect(properties.$pathname).toBe('/signin');
    expect(properties.$host).toBe('app.example.test');
    expect(properties.$browser).toBe('Chrome');
  });

  it("takes a share token out of an autocaptured click's href and element chain", () => {
    const out = scrubAnalyticsEvent(
      event({
        event: '$autocapture',
        properties: {
          $current_url: 'https://app.example.test/dashboard/settings',
          $elements: [{ tag_name: 'a', attr__href: `/r/${TOKEN}`, $el_text: 'Open link' }],
          $elements_chain: `a:text="Open link"attr__href="/r/${TOKEN}"nth-child="1"`,
          $external_click_url: `https://app.example.test/m/${TOKEN}`,
        },
      }),
    );
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    const properties = out?.properties as Record<string, unknown>;
    expect(properties.$elements_chain).toBe(
      'a:text="Open link"attr__href="/r/[redacted]"nth-child="1"',
    );
    expect(properties.$current_url).toBe('https://app.example.test/dashboard/settings');
  });

  it("takes a session's tokens out of a fragment the SDK kept", () => {
    const out = scrubAnalyticsEvent(
      event({
        event: '$pageview',
        properties: {
          $current_url:
            'https://app.example.test/signin?error=auth_callback_failed#access_token=header.payload.signature&refresh_token=r1&type=recovery',
        },
      }),
    );
    const url = (out?.properties as Record<string, unknown>).$current_url as string;
    expect(url).not.toContain('header.payload.signature');
    expect(url).not.toMatch(/refresh_token=r1/);
  });

  it("takes the invite token out of a session replay's page address", () => {
    // posthog-js sends replay data as $snapshot events through the same hook;
    // each meta record keeps the page's href (rrweb type 4).
    const out = scrubAnalyticsEvent(
      event({
        event: '$snapshot',
        properties: {
          $snapshot_data: [
            { type: 4, data: { href: SIGNIN, width: 1280, height: 800 }, timestamp: 1 },
          ],
          $session_id: 'session-1',
        },
      }),
    );
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    const [meta] = (out?.properties as { $snapshot_data: { data: { href: string } }[] })
      .$snapshot_data;
    expect(meta?.data.href).toBe('https://app.example.test/signin?redirect=/invite/[redacted]');
  });

  it('returns an event with no credential as the very same object', () => {
    const product = event({
      event: 'item_created',
      properties: {
        $current_url:
          'https://app.example.test/dashboard/inventory/3f2c1a9e-7b4d-4c1e-9a2f-0d5e6f7a8b9c?q=acme',
        $referrer: '$direct',
        $set_once: { $initial_current_url: 'https://app.example.test/dashboard' },
        quantity: 3,
      },
    });
    expect(scrubAnalyticsEvent(product)).toBe(product);
  });

  it('still turns a perf_ event into route templates', () => {
    const out = scrubAnalyticsEvent(
      event({
        event: 'perf_navigation',
        properties: { $current_url: SIGNIN, $referrer: INVITE, click_to_useful_ms: 742 },
      }),
    );
    expect(out?.properties).toEqual({
      $current_url: '/signin',
      $pathname: '/signin',
      click_to_useful_ms: 742,
    });
  });

  it('passes null through, and drops an event it cannot read rather than send it unread', () => {
    expect(scrubAnalyticsEvent(null)).toBeNull();
    const unreadable = event({ event: '$pageview' });
    Object.defineProperty(unreadable, 'properties', {
      enumerable: true,
      get() {
        throw new Error('unreadable');
      },
    });
    expect(scrubAnalyticsEvent(unreadable)).toBeNull();
  });
});
