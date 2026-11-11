// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { POST } from './route';

/**
 * POST /api/appearance/style (plans/REVISION-DEFAULT.md R6, item 25): the
 * server sets the Design cookie for 400 days, because WebKit caps a cookie
 * written by script at 7 days. No auth and no database: it only sets the
 * caller's own sp_style cookie to a validated Design. A cross-site page must
 * not be able to flip it, so it needs the browser's same-origin headers and
 * the x-sp-appearance header a plain form or image cannot send.
 */

const URL_ = 'https://app.example.test/api/appearance/style';

function request(
  body: unknown,
  headers: Record<string, string> = {
    'sec-fetch-site': 'same-origin',
    'x-sp-appearance': '1',
    'content-type': 'application/json',
  },
  url = URL_,
): Request {
  return new Request(url, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const setCookie = (response: Response) => response.headers.get('set-cookie');

describe('POST /api/appearance/style', () => {
  it.each(['classic', 'liquid-glass'])(
    'sets sp_style=%s for 400 days, site-wide, lax, secure, readable by the head script; no-store',
    async (style) => {
      const response = await POST(request({ style }));
      expect(response.status).toBe(204);
      expect(setCookie(response)).toBe(
        `sp_style=${style}; Path=/; Max-Age=34560000; SameSite=Lax; Secure`,
      );
      expect(setCookie(response)).not.toMatch(/httponly/iu);
      expect(response.headers.get('cache-control')).toBe('no-store');
    },
  );

  it('accepts a matching Origin when the browser sends no Sec-Fetch-Site', async () => {
    const response = await POST(
      request({ style: 'classic' }, { origin: 'https://app.example.test', 'x-sp-appearance': '1' }),
    );
    expect(response.status).toBe(204);
    expect(setCookie(response)).toContain('sp_style=classic');
  });

  it.each([
    ['another site', { 'sec-fetch-site': 'cross-site', 'x-sp-appearance': '1' }],
    ['a sibling subdomain', { 'sec-fetch-site': 'same-site', 'x-sp-appearance': '1' }],
    ['another Origin', { origin: 'https://evil.example', 'x-sp-appearance': '1' }],
    [
      'a same-origin fetch header with another Origin',
      { 'sec-fetch-site': 'same-origin', origin: 'https://evil.example', 'x-sp-appearance': '1' },
    ],
    ['neither header', { 'x-sp-appearance': '1' }],
    ['no x-sp-appearance', { 'sec-fetch-site': 'same-origin' }],
    ['a wrong x-sp-appearance', { 'sec-fetch-site': 'same-origin', 'x-sp-appearance': 'yes' }],
  ])('refuses %s, and sets nothing', async (_label, headers) => {
    const response = await POST(request({ style: 'classic' }, headers as Record<string, string>));
    expect(response.status).toBe(403);
    expect(setCookie(response)).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    ['an unknown word', { style: 'dark' }],
    ['a label', { style: 'Liquid Glass' }],
    ['the stage 2 shape', { appearance: 'liquid-glass' }],
    ['nothing', {}],
    ['not JSON', 'style=classic'],
    ['a value with cookie syntax', { style: 'classic; Domain=evil.example' }],
    ['an oversized body', { style: 'classic', pad: 'x'.repeat(1000) }],
  ])('refuses %s, and sets nothing', async (_label, body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(setCookie(response)).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('on a plain-http local server it leaves Secure off, so a local browser keeps the cookie', async () => {
    const response = await POST(
      request(
        { style: 'classic' },
        { 'sec-fetch-site': 'same-origin', 'x-sp-appearance': '1' },
        'http://localhost:3400/api/appearance/style',
      ),
    );
    expect(setCookie(response)).toBe('sp_style=classic; Path=/; Max-Age=34560000; SameSite=Lax');
  });

  it('reads no session and no database, and exports POST only', () => {
    const source = readFileSync(join(__dirname, 'route.ts'), 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map((m) => m[1]).sort();
    expect(imports).toEqual([
      '@/lib/auth/cross-site-request',
      '@stockpilot/core',
      'next/server',
      'zod',
    ]);
    expect([...source.matchAll(/export (?:async )?function (\w+)/gu)].map((m) => m[1])).toEqual([
      'POST',
    ]);
  });
});
