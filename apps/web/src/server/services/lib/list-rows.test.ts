import { describe, expect, it } from 'vitest';

import { json, NOT_A_LIST, realSupabaseClient } from '@/test/postgrest-answers';

import { ListReadError, listRows } from './list-rows';

/**
 * listRows is the one list check for a read whose answer decides who is told,
 * what a digest shows or whether a document is posted (docket S27). Only a
 * list is an answer: an empty body or an object read as "no rows" told the
 * wrong people, widened a digest, dropped webhooks or posted an ERP document
 * twice. It checks the list only; each reader keeps its own error branch.
 */
describe('listRows', () => {
  it.each(NOT_A_LIST)(
    '%s throws a ListReadError naming the table and the status, with no raw text',
    (_shape, answer) => {
      let thrown: unknown;
      try {
        listRows('role_permission_overrides', answer);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ListReadError);
      const err = thrown as ListReadError;
      expect(err.table).toBe('role_permission_overrides');
      expect(err.status).toBe(answer.status);
      expect(err.message).toBe(
        `role_permission_overrides answered no list (status ${answer.status})`,
      );
      // The answer itself never reaches the message.
      expect(err.message).not.toContain('not-a-list');
    },
  );

  it('names no status when the answer carried none', () => {
    expect(() => listRows('organization_members', { data: null })).toThrow(
      'organization_members answered no list (status none)',
    );
  });

  it('passes a list through as it came, an empty list included', () => {
    const rows = [{ user_id: 'user-1', role: 'manager' }];
    expect(listRows('organization_members', { data: rows, status: 200 })).toBe(rows);
    expect(listRows('organization_members', { data: [], status: 200 })).toEqual([]);
  });

  /**
   * The same answers through a real supabase-js client (its own postgrest-js),
   * so the shapes are the library's. The fetch is local: no request leaves
   * the test.
   */
  describe('through a real supabase-js client', () => {
    const read = (answer: () => Response) =>
      realSupabaseClient(() => answer())
        .from('user_permission_overrides')
        .select('user_id, permission, granted')
        .eq('organization_id', 'org-1');

    it.each([
      ['a 404 with an empty body', () => new Response('', { status: 404 }), 204],
      ['a 200 with an empty body', () => new Response('', { status: 200 }), 200],
    ])('%s is refused, never read as "no rows"', async (_shape, answer, status) => {
      const res = await read(answer);
      expect(res.error).toBeNull();
      expect(() => listRows('user_permission_overrides', res)).toThrow(
        `user_permission_overrides answered no list (status ${status})`,
      );
    });

    it('a list answer is the rows', async () => {
      const res = await read(() =>
        json([{ user_id: 'user-1', permission: 'stock:adjust', granted: false }]),
      );
      expect(listRows('user_permission_overrides', res)).toEqual([
        { user_id: 'user-1', permission: 'stock:adjust', granted: false },
      ]);
    });
  });
});
