// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: GET /api/cron/embeddings-sweep runs the hourly sweep
 * of items without a search embedding (lib/ai/embeddings-sweep.ts) on the
 * service role, across every organization with the AI module switched on
 * (lib/ai/embeddings-sweep.test.ts proves that filter). It runs only for
 * the cron's Bearer CRON_SECRET (constant-time compare) and FAILS CLOSED
 * when the secret is not set, as drain-outbox does; a failed run answers
 * with fixed words, once its error report is sent; its one summary line is
 * counts and the first failure's message (lib/ai/embeddings-sweep.test.ts
 * proves no item is named in it).
 */

const h = vi.hoisted(() => ({
  env: { CRON_SECRET: 'test-cron-secret' } as { CRON_SECRET?: string },
  sweep: vi.fn(),
  reportError: vi.fn(),
  admin: { serviceRole: true },
}));
vi.mock('@/lib/env', () => ({
  get env() {
    return h.env;
  },
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => h.admin) }));
vi.mock('@/lib/ai/embeddings-sweep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/embeddings-sweep')>()),
  sweepMissingEmbeddings: h.sweep,
}));

import { EMBED_TIMEOUT_MS } from '@/lib/ai/embeddings';
import { EMBEDDINGS_SWEEP } from '@/lib/ai/embeddings-sweep';

import { GET, maxDuration } from './route';

const RESULT = {
  skipped: null,
  aiOrgs: 3,
  orgs: 2,
  moreOrgs: false,
  orgsProcessed: 2,
  orgsFailed: 0,
  orgsLeft: 0,
  embedded: 5,
  failed: 1,
  firstError: '[GoogleGenerativeAI Error]: Error fetching from ...: [503 ] model overloaded',
  changed: 0,
  remaining: 1,
  timeUp: false,
  ms: 1234,
};

function req(auth?: string): Request {
  return new Request('https://test.local/api/cron/embeddings-sweep', {
    headers: auth === undefined ? {} : { authorization: auth },
  });
}

let info: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.env = { CRON_SECRET: 'test-cron-secret' };
  h.sweep.mockReset();
  h.sweep.mockResolvedValue(RESULT);
  h.reportError.mockReset();
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('GET /api/cron/embeddings-sweep: the cron secret', () => {
  it('refuses a request with no Authorization header', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(h.sweep).not.toHaveBeenCalled();
  });

  it('refuses a wrong secret of the same length', async () => {
    const res = await GET(req('Bearer test-cron-secreT'));
    expect(res.status).toBe(401);
    expect(h.sweep).not.toHaveBeenCalled();
  });

  it('fails closed when CRON_SECRET is not set: nothing it is sent opens it', async () => {
    h.env = {};
    for (const auth of [undefined, '', 'Bearer ', 'Bearer undefined', 'Bearer test-cron-secret']) {
      const res = await GET(req(auth));
      expect(res.status).toBe(401);
    }
    h.env = { CRON_SECRET: '' };
    expect((await GET(req('Bearer '))).status).toBe(401);
    expect(h.sweep).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/embeddings-sweep: the run', () => {
  it('runs the sweep on the service-role client with the default budget, and logs one line of counts', async () => {
    const res = await GET(req('Bearer test-cron-secret'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESULT);
    // The service-role client, and no second argument: EMBEDDINGS_SWEEP applies.
    expect(h.sweep).toHaveBeenCalledTimes(1);
    expect(h.sweep.mock.calls[0]).toEqual([h.admin]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]).toEqual(['[cron.embeddings-sweep]', JSON.stringify(RESULT)]);
  });

  it('a failed run answers 500 with fixed words, and reports the error', async () => {
    h.sweep.mockRejectedValue(new Error('could not find organizations: relation detail'));

    const res = await GET(req('Bearer test-cron-secret'));

    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: 'internal_error' });
    expect(body).not.toContain('relation detail');
    expect(h.reportError).toHaveBeenCalledWith(expect.any(Error), { tag: 'cron.embeddings-sweep' });
  });

  it('a failed run answers only once its error report is sent: the alert POST is never left in flight', async () => {
    // reportError posts to the alert webhook after printing its line. Were the
    // route to answer first, the instance could be suspended with that POST
    // still pending, and the alert would be lost.
    h.sweep.mockRejectedValue(new Error('could not find organizations'));
    let sendReport: (() => void) | undefined;
    h.reportError.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          sendReport = resolve;
        }),
    );

    let answered = false;
    const response = GET(req('Bearer test-cron-secret')).then((res) => {
      answered = true;
      return res;
    });
    for (let i = 0; i < 20 && !sendReport; i += 1) await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(sendReport).toBeTypeOf('function');
    expect(answered).toBe(false);
    sendReport!();
    expect((await response).status).toBe(500);
  });

  it('a run always ends well inside maxDuration', () => {
    // No item starts after the deadline; the one in flight has at most the
    // Gemini timeout, then its read again, its write and its organization's
    // count (allow a Supabase stall of 8 s each): 184 s. Well inside: at most
    // two thirds of the limit.
    expect(maxDuration).toBe(300);
    const worstMs = EMBEDDINGS_SWEEP.deadlineMs + EMBED_TIMEOUT_MS + 3 * 8_000;
    expect(worstMs).toBeLessThanOrEqual((maxDuration * 1000 * 2) / 3);
  });
});

/** The minutes a cron minute field fires on: '*', 'n', 'a-b', and '/step'. */
function minutesOf(field: string): number[] {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/') as [string, string | undefined];
    const step = stepText ? Number(stepText) : 1;
    let lo: number;
    let hi: number;
    if (range === '*') [lo, hi] = [0, 59];
    else if (range.includes('-')) [lo, hi] = range.split('-').map(Number) as [number, number];
    else [lo, hi] = [Number(range), stepText ? 59 : Number(range)];
    for (let m = lo; m <= hi; m += step) out.add(m);
  }
  return [...out];
}

describe('the schedule', () => {
  const vercel = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../../../../vercel.json'), 'utf8'),
  ) as { crons: Array<{ path: string; schedule: string }> };

  it('vercel.json runs the sweep every hour at minute 37', () => {
    const entries = vercel.crons.filter((c) => c.path === '/api/cron/embeddings-sweep');
    expect(entries).toEqual([{ path: '/api/cron/embeddings-sweep', schedule: '37 * * * *' }]);
  });

  it('minute 37 is a quiet one: no other cron fires on it, and it is clear of the :55 to :10 busy windows', () => {
    for (const c of vercel.crons) {
      if (c.path === '/api/cron/embeddings-sweep') continue;
      expect(minutesOf(c.schedule.split(' ')[0]!), c.path).not.toContain(37);
    }
    // 12:55-13:05, 13:55-14:10 and 14:55-15:10 UTC (the daily briefing, the
    // weekly digest, rental-overdue) are never touched at :37.
    expect(37).toBeGreaterThan(10);
    expect(37).toBeLessThan(55);
  });
});
