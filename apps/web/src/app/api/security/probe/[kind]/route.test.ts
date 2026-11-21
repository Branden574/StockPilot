import { beforeEach, describe, expect, it } from 'vitest';

import { recordSecurityEvent } from '@/server/security/events';

import * as route from './route';

/**
 * The scanner-path route (next.config.ts rewrites /.env, /wp-login.php and
 * the like here; lib/security/probe-paths.ts): every method answers a
 * plain-text 404 "Not found" that is never cached, and a known kind is
 * recorded as exploit / blocked / <kind> from the web, with the request's own
 * headers and no organization. Any other kind records nothing.
 *
 * Addresses are from the documentation ranges (RFC 5737).
 */

const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function call(method: (typeof METHODS)[number], kind: string) {
  const req = new Request(`https://app.example.com/api/security/probe/${kind}`, {
    method,
    headers: { 'x-real-ip': '203.0.113.21' },
  });
  return { req, res: route[method](req, { params: Promise.resolve({ kind }) }) };
}

beforeEach(() => {
  // The recorder is mocked for every test (src/test/setup.ts).
  expect(recordSecurityEvent).not.toHaveBeenCalled();
});

describe('the probe route', () => {
  it.each(METHODS)('%s answers 404 "Not found", text/plain, no-store', async (method) => {
    const { res } = call(method, 'env_file');
    const response = await res;
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(method === 'HEAD' ? '' : 'Not found');
  });

  it.each(['env_file', 'git_dir', 'wordpress', 'php_file', 'admin_tool', 'path_traversal'])(
    'a %s request is recorded as exploit / blocked from the web, with its headers',
    async (kind) => {
      const { req, res } = call('GET', kind);
      await res;
      expect(recordSecurityEvent).toHaveBeenCalledTimes(1);
      expect(recordSecurityEvent).toHaveBeenCalledWith(
        { category: 'exploit', outcome: 'blocked', reason: kind, source: 'web' },
        req.headers,
      );
    },
  );

  it('every method records', async () => {
    for (const method of METHODS) await call(method, 'git_dir').res;
    expect(recordSecurityEvent).toHaveBeenCalledTimes(METHODS.length);
  });

  it.each(['unknown', 'ENV_FILE', 'over_minute_cap', '', 'env_file%00', '../env_file'])(
    'any other kind (%j) answers the same 404 and records nothing',
    async (kind) => {
      const response = await call('GET', kind).res;
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not found');
      expect(recordSecurityEvent).not.toHaveBeenCalled();
    },
  );

  it('the answer is the same for a known kind and an unknown one', async () => {
    const known = await call('POST', 'wordpress').res;
    const unknown = await call('POST', 'nothing-here').res;
    expect([...known.headers]).toEqual([...unknown.headers]);
    expect(await known.text()).toBe(await unknown.text());
  });
});
