import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));

import { audit } from './audit';
import { ProcedureCommentsService } from './procedure-comments';

const OWN_COMMENT = {
  'procedure_comments.select': {
    data: {
      procedure_id: 'proc-1',
      author_id: 'user-test',
      body: 'Check the seal first.',
      deleted_at: null,
    },
    error: null,
  },
  'procedure_comments.update': { data: null, error: null },
};

function service(mfaSatisfied: boolean) {
  const stub = makeSupabaseStub(OWN_COMMENT);
  const svc = new ProcedureCommentsService(
    makeServiceContext(stub.client, { role: 'staff', mfaRequired: true, mfaSatisfied }) as never,
  );
  return { stub, svc };
}

const calls: Array<[string, (svc: ProcedureCommentsService) => Promise<unknown>]> = [
  ['update', (svc) => svc.update('comment-1', { body: 'Check the seal, then the valve.' })],
  ['delete', (svc) => svc.delete('comment-1')],
];

beforeEach(() => vi.clearAllMocks());

describe('ProcedureCommentsService gives the authenticator answer before a comment changes', () => {
  it.each(calls)(
    '%s, required and not satisfied: mfa_required, nothing read or written',
    async (_name, run) => {
      const { stub, svc } = service(false);
      await expect(run(svc)).rejects.toMatchObject({
        code: 'forbidden',
        details: { reason: 'mfa_required' },
      });
      expect(stub.fromCalls).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    },
  );

  it.each(calls)(
    '%s, required and satisfied: the author changes their own comment',
    async (_name, run) => {
      const { stub, svc } = service(true);
      await run(svc);
      expect(stub.chainArgs.get('procedure_comments.update')).toContainEqual(['id', 'comment-1']);
    },
  );
});
