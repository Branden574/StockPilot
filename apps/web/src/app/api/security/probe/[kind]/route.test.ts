import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NEVER_SAMPLE_PATHS } from '@/lib/security/probe-sample';
import { recordSecurityEventSample } from '@/server/security/event-samples';
import { recordSecurityEvent } from '@/server/security/events';

import * as route from './route';

/**
 * Security invariant: the scanner-path route (next.config.ts rewrites /.env,
 * /wp-login.php and the like here; lib/security/probe-paths.ts): every method
 * answers a plain-text 404 "Not found" that is never cached, and a known kind
 * is recorded as exploit / blocked / <kind> from the web, with the request's
 * own headers and no organization. Any other kind records nothing.
 *
 * What was asked for (part 5, stage 3): beside the event, a scrubbed sample
 * of the request, only when the path is one the rule of that kind takes, never
 * under a path that can carry a token, never for a method outside the seven;
 * and nothing about it can change the answer or the event.
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
  // Both recorders are mocked for every test (src/test/setup.ts).
  expect(recordSecurityEvent).not.toHaveBeenCalled();
  expect(recordSecurityEventSample).not.toHaveBeenCalled();
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

/** A request as Vercel hands it after the rewrite: the original path, the rewrite's parameters in the query. */
function rewritten(
  path: string,
  query: string,
  method: (typeof METHODS)[number] | 'PROPFIND' = 'GET',
) {
  return new Request(`https://app.example.com${path}${query ? `?${query}` : ''}`, {
    method,
    headers: { 'x-real-ip': '203.0.113.21', 'x-vercel-ip-country': 'NL', cookie: 'example=value' },
  });
}

async function answerOf(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers].map(([k, v]) => [k.toLowerCase(), v]).sort(),
    body: [...new Uint8Array(await response.arrayBuffer())],
  };
}

/** The answer every probe gets, byte for byte, as it was before samples. */
function expectedAnswer(method: string) {
  return {
    status: 404,
    headers: [
      ['cache-control', 'no-store'],
      ['content-type', 'text/plain; charset=utf-8'],
    ],
    body: method === 'HEAD' ? [] : [...new TextEncoder().encode('Not found')],
  };
}

const EVENT = (reason: string) => ({
  category: 'exploit',
  outcome: 'blocked',
  reason,
  source: 'web',
});

describe('what was asked for', () => {
  const CASES: Array<[string, string, string, { target: string; sample: string | null }]> = [
    [
      'env_file',
      '/backup/.env',
      'debug=1&dirs=backup&file=.env',
      { target: '/backup/.env', sample: 'debug=1' },
    ],
    [
      'git_dir',
      '/app/.git/config',
      'rest=config&dirs=app',
      { target: '/app/.git/config', sample: null },
    ],
    [
      'wordpress',
      '/wp-login.php',
      'redirect_to=x&wp=wp-login.php',
      { target: '/wp-login.php', sample: 'redirect_to=x' },
    ],
    [
      'php_file',
      '/cgi-bin/test.php',
      'a2=1&dirs=cgi-bin&file=test.php',
      { target: '/cgi-bin/test.php', sample: 'a2=1' },
    ],
    ['admin_tool', '/phpmyadmin/', 'tool=phpmyadmin', { target: '/phpmyadmin/', sample: null }],
    [
      'path_traversal',
      '/a/b/etc/passwd',
      'dirs=a&dirs=b&target=etc%2Fpasswd',
      { target: '/a/b/etc/passwd', sample: null },
    ],
  ];

  it.each(CASES)(
    'a %s probe: the scrubbed path and the query as the client sent it, with the headers',
    async (kind, path, query, expected) => {
      const req = rewritten(path, query);
      await route.GET(req, { params: Promise.resolve({ kind }) });
      expect(recordSecurityEventSample).toHaveBeenCalledTimes(1);
      expect(recordSecurityEventSample).toHaveBeenCalledWith(
        { reason: kind, method: 'GET', ...expected },
        req.headers,
      );
      expect(recordSecurityEvent).toHaveBeenCalledWith(EVENT(kind), req.headers);
    },
  );

  it('the sample carries no address, header value or cookie of its own', async () => {
    const req = rewritten('/backup/.env', 'q=example-query');
    await route.POST(req, { params: Promise.resolve({ kind: 'env_file' }) });
    const [sample] = vi.mocked(recordSecurityEventSample).mock.calls[0]!;
    expect(Object.keys(sample).sort()).toEqual(['method', 'reason', 'sample', 'target']);
    const text = JSON.stringify(sample);
    for (const value of ['203.0.113.21', 'NL', 'example=value'])
      expect(text.includes(value), value).toBe(false);
  });

  it('a secret in the path or the query is scrubbed before it reaches the recorder', async () => {
    const req = rewritten(
      '/x/someone%40example.com/.env',
      'password=vexample&id=0f1e2d3c-4b5a-4968-8776-655443322110',
    );
    await route.GET(req, { params: Promise.resolve({ kind: 'env_file' }) });
    expect(recordSecurityEventSample).toHaveBeenCalledWith(
      {
        reason: 'env_file',
        method: 'GET',
        target: '/x/<email>/.env',
        sample: 'password=<removed>&id=<id>',
      },
      req.headers,
    );
  });

  it('no sample when the path is not one the rule of that kind takes; the event is recorded as before', async () => {
    for (const [kind, path] of [
      ['env_file', '/api/security/probe/env_file'],
      ['git_dir', '/.env'],
      ['php_file', '/wp-content/plugins/example/index.php'],
      ['wordpress', '/dashboard'],
    ] as const) {
      const req = rewritten(path, 'file=.env');
      const response = await route.GET(req, { params: Promise.resolve({ kind }) });
      expect(await answerOf(response)).toEqual(expectedAnswer('GET'));
      expect(recordSecurityEvent).toHaveBeenLastCalledWith(EVENT(kind), req.headers);
    }
    expect(recordSecurityEventSample).not.toHaveBeenCalled();
    expect(recordSecurityEvent).toHaveBeenCalledTimes(4);
  });

  it.each(NEVER_SAMPLE_PATHS.map((p) => [p]))(
    'no sample under %s; the event is recorded as before',
    async (entry) => {
      const req = rewritten(`${entry}/Qx7kP2mZ9w/.env`, 'x=1&dirs=a&file=.env');
      const response = await route.GET(req, { params: Promise.resolve({ kind: 'env_file' }) });
      expect(await answerOf(response)).toEqual(expectedAnswer('GET'));
      expect(recordSecurityEvent).toHaveBeenCalledWith(EVENT('env_file'), req.headers);
      expect(recordSecurityEventSample).not.toHaveBeenCalled();
    },
  );

  it('no sample for a method outside the seven; the event and the answer are as before', async () => {
    const req = rewritten('/backup/.env', '', 'PROPFIND');
    const response = await route.GET(req, { params: Promise.resolve({ kind: 'env_file' }) });
    expect(await answerOf(response)).toEqual(expectedAnswer('GET'));
    expect(recordSecurityEvent).toHaveBeenCalledWith(EVENT('env_file'), req.headers);
    expect(recordSecurityEventSample).not.toHaveBeenCalled();
  });

  it('no sample for a kind that is not a probe kind', async () => {
    await route.GET(rewritten('/backup/.env', ''), {
      params: Promise.resolve({ kind: 'unknown' }),
    });
    expect(recordSecurityEventSample).not.toHaveBeenCalled();
  });

  it.each(METHODS)(
    '%s: the answer and the event are byte for byte what they were, sampled or not',
    async (method) => {
      const sampled = rewritten('/backup/.env', 'q=1', method);
      const unsampled = rewritten('/r/Qx7kP2mZ9w/.env', 'q=1', method);
      const direct = new Request('https://app.example.com/api/security/probe/env_file', { method });
      for (const req of [sampled, unsampled, direct]) {
        const response = await route[method](req, {
          params: Promise.resolve({ kind: 'env_file' }),
        });
        expect(await answerOf(response)).toEqual(expectedAnswer(method));
        expect(recordSecurityEvent).toHaveBeenLastCalledWith(EVENT('env_file'), req.headers);
      }
      expect(recordSecurityEvent).toHaveBeenCalledTimes(3);
      expect(recordSecurityEventSample).toHaveBeenCalledTimes(1);
      expect(vi.mocked(recordSecurityEventSample).mock.calls[0]![0].method).toBe(method);
    },
  );

  it('a recorder that throws cannot change the answer or the event', async () => {
    vi.mocked(recordSecurityEventSample).mockImplementation(() => {
      throw new Error('example failure');
    });
    for (const method of METHODS) {
      const req = rewritten('/backup/.env', 'q=1', method);
      const response = await route[method](req, { params: Promise.resolve({ kind: 'env_file' }) });
      expect(await answerOf(response)).toEqual(expectedAnswer(method));
      expect(recordSecurityEvent).toHaveBeenLastCalledWith(EVENT('env_file'), req.headers);
    }
    expect(recordSecurityEventSample).toHaveBeenCalledTimes(METHODS.length);
  });

  it('a request whose address cannot be read still gets the normal 404 and its event, and no sample', async () => {
    const real = rewritten('/backup/.env', 'q=1');
    const hostile = new Proxy(real, {
      get(target, prop) {
        if (prop === 'url') throw new Error('example failure');
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Request;
    const response = await route.GET(hostile, { params: Promise.resolve({ kind: 'env_file' }) });
    expect(await answerOf(response)).toEqual(expectedAnswer('GET'));
    expect(recordSecurityEvent).toHaveBeenCalledTimes(1);
    expect(recordSecurityEventSample).not.toHaveBeenCalled();
  });

  it('the recorder is never awaited: the route reads nothing back from it', () => {
    const src = readFileSync(path.join(__dirname, 'route.ts'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(src).toMatch(/\brecordSecurityEventSample\(sample, req\.headers\);/);
    expect(src).not.toMatch(/await\s+recordSecurityEventSample/);
    expect(src).not.toMatch(/probe-measure|logProbeMeasurement/);
  });
});
