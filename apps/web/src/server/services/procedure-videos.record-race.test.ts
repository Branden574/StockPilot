import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * A VIDEO THAT LOST ITS SLOT TOO MANY TIMES NEVER SHOWS POSTGRES TEXT (S31).
 *
 * record() retries a 23505 on (procedure_id, order_idx) three times, then
 * threw a conflict carrying the last Postgres message ("Couldn't slot the
 * video into the procedure (raced too many times): duplicate key value
 * violates unique constraint ..."), which the procedures action answers as it
 * is. The person reads the app's sentence now, and the text is reported.
 */

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({ unstable_cache: vi.fn((fn: unknown) => fn) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

import { ServiceError } from './context';
import { ProcedureVideosService } from './procedure-videos';

const PROC = 'proc-1';
const PG_TEXT =
  'duplicate key value violates unique constraint "procedure_videos_procedure_id_order_idx_key"';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProcedureVideosService.record after too many slot races (S31)', () => {
  it("says the app's sentence, never the Postgres text, and reports it once", async () => {
    const stub = makeSupabaseStub({
      'procedures.select': { data: { id: PROC }, error: null },
      'procedure_videos.select': { data: { order_idx: 2 }, error: null },
      'procedure_videos.insert': { data: null, error: { code: '23505', message: PG_TEXT } },
    });
    const svc = new ProcedureVideosService(makeServiceContext(stub.client));

    let caught: ServiceError | null = null;
    try {
      await svc.record({ procedureId: PROC, storagePath: `org-test/${PROC}/clip.mp4` });
    } catch (e) {
      caught = e as ServiceError;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect(caught).toMatchObject({
      code: 'conflict',
      message: "Couldn't slot the video into the procedure. Try again.",
    });
    expect(caught!.message).not.toContain('procedure_videos');
    expect(stub.fromCalls.filter((t) => t === 'procedure_videos').length).toBeGreaterThanOrEqual(6);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = reportError.mock.calls[0] as unknown as [Error, unknown];
    expect(reported.message).toBe(PG_TEXT);
    expect(context).toEqual({
      tag: 'procedure_videos.slot_race',
      organizationId: 'org-test',
      level: 'warning',
      extra: { attempts: 3 },
    });
  });
});
