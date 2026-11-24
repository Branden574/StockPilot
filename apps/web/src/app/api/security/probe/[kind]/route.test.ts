import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('the measurement log line', () => {
  const KINDS = ['env_file', 'git_dir', 'wordpress', 'php_file', 'admin_tool', 'path_traversal'];
  const URL_WITH_TEXT =
    'https://app.example.com/api/security/probe/KIND?example=value&file=example-file';
  const HEADER_VALUES = [
    '/example-probe/settings',
    'example-forwarded-value',
    'example-cookie-value',
  ];

  function measured(kind: string, headers: Record<string, string> = {}, method = 'GET') {
    return new Request(URL_WITH_TEXT.replace('KIND', kind), {
      method,
      headers: {
        'x-forwarded-uri': HEADER_VALUES[0]!,
        'x-example': HEADER_VALUES[1]!,
        cookie: HEADER_VALUES[2]!,
        ...headers,
      },
    });
  }

  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    info.mockRestore();
  });

  it.each(KINDS)('a %s request writes exactly one line with the fixed shape', async (kind) => {
    const req = measured(kind);
    await route.GET(req, { params: Promise.resolve({ kind }) });
    expect(info).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(info.mock.calls[0]![0] as string);
    expect(Object.keys(parsed).sort()).toEqual(
      ['headerCount', 'headerNames', 'headers', 'kind', 'query', 'tag', 'url'].sort(),
    );
    expect(parsed.tag).toBe('security.probe.measure');
    expect(parsed.kind).toBe(kind);
    expect(parsed.url).toEqual({ present: true, matchesKind: false });
    expect(parsed.query).toEqual({ present: true, paramCount: 1, paramNames: ['file'] });
    expect(parsed.headers['x-forwarded-uri']).toEqual({ present: true, matchesKind: false });
    expect(parsed.headerCount).toBe([...req.headers.keys()].length);
    expect(parsed.headerNames).toEqual(['x-forwarded-uri']);
  });

  it('a header carrying a path of the kind is reported as a match', async () => {
    const req = measured('env_file', { 'x-original-url': '/example-probe/.env' });
    await route.GET(req, { params: Promise.resolve({ kind: 'env_file' }) });
    const parsed = JSON.parse(info.mock.calls[0]![0] as string);
    expect(parsed.headers['x-original-url']).toEqual({ present: true, matchesKind: true });
  });

  it('the line holds no path, query string, header value or header name outside the list', async () => {
    const req = measured('env_file');
    await route.GET(req, { params: Promise.resolve({ kind: 'env_file' }) });
    const line = info.mock.calls[0]![0] as string;
    for (const text of [
      '/example-probe',
      '/api/security/probe/env_file',
      '?example=value',
      'example=value',
      'example-file',
      'x-example',
      'cookie',
      ...HEADER_VALUES,
    ]) {
      expect(line.includes(text), text).toBe(false);
    }
  });

  it('an unknown kind writes no line', async () => {
    await route.GET(measured('unknown'), { params: Promise.resolve({ kind: 'unknown' }) });
    expect(info).not.toHaveBeenCalled();
  });

  it.each(METHODS)('%s: the answer and the recorded event are what they were', async (method) => {
    const req = measured('wordpress', {}, method);
    const response = await route[method](req, { params: Promise.resolve({ kind: 'wordpress' }) });
    expect(response.status).toBe(404);
    expect([...response.headers].map(([k, v]) => [k.toLowerCase(), v]).sort()).toEqual([
      ['cache-control', 'no-store'],
      ['content-type', 'text/plain; charset=utf-8'],
    ]);
    expect(await response.text()).toBe(method === 'HEAD' ? '' : 'Not found');
    expect(recordSecurityEvent).toHaveBeenCalledTimes(1);
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      { category: 'exploit', outcome: 'blocked', reason: 'wordpress', source: 'web' },
      req.headers,
    );
  });

  it('a throwing header accessor still gets the normal 404, the event, and no line', async () => {
    const real = measured('git_dir');
    const hostile = new Proxy(real, {
      get(target, prop) {
        if (prop === 'headers') {
          return {
            get: () => {
              throw new Error('example failure');
            },
            keys: () => {
              throw new Error('example failure');
            },
            values: () => {
              throw new Error('example failure');
            },
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Request;
    const response = await route.GET(hostile, { params: Promise.resolve({ kind: 'git_dir' }) });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    expect(info).not.toHaveBeenCalled();
    expect(recordSecurityEvent).toHaveBeenCalledTimes(1);
  });

  it('a console that throws does not change the answer', async () => {
    info.mockImplementation(() => {
      throw new Error('example failure');
    });
    const response = await route.GET(measured('php_file'), {
      params: Promise.resolve({ kind: 'php_file' }),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });
});
