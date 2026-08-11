import { describe, expect, it } from 'vitest';

import nextConfig from '../../next.config';

/**
 * Security wave E — MED-27 (Supabase CSP wildcard) and MED-28 (COOP/CORP).
 *
 * These assert the security PROPERTIES of the emitted header set, not the
 * literal strings the config happens to build today:
 *   • no CSP directive may allow a Supabase wildcard (any project);
 *   • the realtime socket must ship alongside the https origin (so nobody
 *     "narrows" the policy by deleting the wss entry and breaking realtime);
 *   • COOP must be popup-safe, because two flows read `window.open()`'s
 *     return value as their popup-blocked signal;
 *   • COEP must be absent;
 *   • CORP must be exactly one value per path, and must not cover the email
 *     assets that mail clients embed cross-origin.
 */

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

async function rules(): Promise<HeaderRule[]> {
  const fn = nextConfig.headers;
  if (!fn) throw new Error('next.config exports no headers()');
  return (await fn()) as HeaderRule[];
}

function headerValues(all: HeaderRule[], key: string): string[] {
  return all.flatMap((r) =>
    r.headers.filter((h) => h.key.toLowerCase() === key.toLowerCase()).map((h) => h.value),
  );
}

async function csp(): Promise<string> {
  const values = headerValues(await rules(), 'Content-Security-Policy');
  expect(values).toHaveLength(1);
  return values[0]!;
}

describe('CSP — Supabase origin is pinned, not wildcarded (MED-27)', () => {
  it('allows no supabase wildcard anywhere in the policy', async () => {
    const policy = await csp();
    expect(policy).not.toContain('*.supabase.co');
    expect(policy).not.toContain('*.supabase.in');
    expect(policy).not.toMatch(/\*\.supabase/);
  });

  it('pins one concrete https host in connect-src, img-src and media-src', async () => {
    const policy = await csp();
    const directive = (name: string) =>
      policy
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith(`${name} `))!;

    // A single `https://<host>` with no wildcard label, in every directive
    // that previously carried the wildcard.
    for (const name of ['connect-src', 'img-src', 'media-src']) {
      const d = directive(name);
      expect(d, name).toBeDefined();
      const supabaseSources = d.split(/\s+/).filter((s) => s.includes('supabase'));
      expect(supabaseSources.length, name).toBeGreaterThan(0);
      for (const source of supabaseSources) {
        expect(source, `${name} -> ${source}`).not.toContain('*');
      }
    }
  });

  it('keeps the realtime websocket origin alongside the https origin', async () => {
    const connect = (await csp())
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('connect-src '))!;
    const sources = connect.split(/\s+/);
    const https = sources.find((s) => s.startsWith('https://') && s.includes('supabase'));
    const wss = sources.find((s) => s.startsWith('wss://') && s.includes('supabase'));
    expect(https).toBeTruthy();
    expect(wss).toBeTruthy();
    // Same host, different scheme — a mismatch means realtime points somewhere
    // the REST client does not.
    expect(new URL(wss!).host).toBe(new URL(https!).host);
  });

  it('does not let next/image proxy an arbitrary Supabase project', async () => {
    const patterns = nextConfig.images?.remotePatterns ?? [];
    const supabase = patterns.filter((p) => String(p.hostname).includes('supabase'));
    expect(supabase.length).toBeGreaterThan(0);
    for (const p of supabase) {
      expect(String(p.hostname)).not.toContain('*');
    }
  });
});

describe('COOP / CORP / COEP (MED-28)', () => {
  it('sets a popup-safe COOP, never bare same-origin', async () => {
    const values = headerValues(await rules(), 'Cross-Origin-Opener-Policy');
    expect(values).toEqual(['same-origin-allow-popups']);
  });

  it('does not set COEP', async () => {
    expect(headerValues(await rules(), 'Cross-Origin-Embedder-Policy')).toEqual([]);
  });

  it('sets CORP same-origin for app paths', async () => {
    const all = await rules();
    const appRule = all.find((r) =>
      r.headers.some(
        (h) =>
          h.key === 'Cross-Origin-Resource-Policy' && h.value === 'same-origin',
      ),
    );
    expect(appRule).toBeDefined();
    const matches = (path: string) => new RegExp(`^${appRule!.source}$`).test(path);
    // Covers the app...
    expect(matches('/dashboard/inventory')).toBe(true);
    expect(matches('/api/v1/items')).toBe(true);
    // ...but must not match the email assets, or webmail image loads break.
    expect(matches('/email/lock@2x.gif')).toBe(false);
    expect(matches('/email-logo.png')).toBe(false);
    expect(matches('/opengraph-image')).toBe(false);
  });

  it('never emits two CORP values for the same path (an unparseable CORP fails OPEN)', async () => {
    const all = await rules();
    // Compile each CORP rule's source into a matcher and check no test path is
    // covered by more than one.
    const corpRules = all.filter((r) =>
      r.headers.some((h) => h.key === 'Cross-Origin-Resource-Policy'),
    );
    const matchers = corpRules.map((r) => ({
      re: new RegExp(`^${r.source.replace(/\/:path\+$/, '/.+').replace(/\/:path\*$/, '/.*')}$`),
      value: r.headers.find((h) => h.key === 'Cross-Origin-Resource-Policy')!.value,
    }));
    for (const path of [
      '/',
      '/dashboard',
      '/dashboard/inventory',
      '/api/v1/items',
      '/email',
      '/email/lock@2x.gif',
      '/email/motion/route@2x.gif',
      '/email-logo.png',
      '/opengraph-image',
    ]) {
      const hits = matchers.filter((m) => m.re.test(path));
      expect(hits.length, `${path} matched ${hits.length} CORP rules`).toBeLessThanOrEqual(1);
    }
  });

  it('leaves the cross-origin-embedded email assets unrestricted', async () => {
    const all = await rules();
    const emailRule = all.find((r) => r.source.startsWith('/email/:path'));
    expect(emailRule).toBeDefined();
    expect(
      emailRule!.headers.find((h) => h.key === 'Cross-Origin-Resource-Policy')?.value,
    ).toBe('cross-origin');
  });
});

describe('the pre-existing header set is not regressed', () => {
  it('still ships HSTS, nosniff, DENY framing and a referrer policy', async () => {
    const all = await rules();
    expect(headerValues(all, 'Strict-Transport-Security')[0]).toContain('max-age=');
    expect(headerValues(all, 'X-Content-Type-Options')).toEqual(['nosniff']);
    expect(headerValues(all, 'X-Frame-Options')).toEqual(['DENY']);
    expect(headerValues(all, 'Referrer-Policy')[0]).toBeTruthy();
  });

  it('keeps frame-ancestors none and object-src none in the CSP', async () => {
    const policy = await csp();
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
  });
});
