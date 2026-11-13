import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * readCharterLabels (S44): the names of charters a member or a record holds
 * that the active list lacks, for a label. A failed read is reported as a
 * warning and answers [] (the caller then shows a neutral label); it never
 * throws, and it never changes which charters are held.
 */

const { reportError } = vi.hoisted(() => ({
  reportError: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import { ServiceError } from '../context';

import { readCharterLabels } from './unoffered-choices';

const ARCHIVED = '00000000-0000-4000-8000-0000000000c1';
const INACTIVE = '00000000-0000-4000-8000-0000000000b1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readCharterLabels', () => {
  it('returns the rows the read answers', async () => {
    const rows = [
      { id: ARCHIVED, name: 'Old Campus', status: 'archived' as const },
      { id: INACTIVE, name: 'Closed Campus', status: 'inactive' as const },
    ];
    const namesByIds = vi.fn(async () => rows);

    expect(await readCharterLabels(namesByIds, [ARCHIVED, INACTIVE, ARCHIVED], 'test.tag')).toEqual(
      rows,
    );
    expect(namesByIds).toHaveBeenCalledTimes(1);
    expect(namesByIds).toHaveBeenCalledWith([ARCHIVED, INACTIVE]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a failed read answers [] and is reported once as a warning, never thrown', async () => {
    const namesByIds = vi.fn(async () => {
      throw new ServiceError('internal_error', 'upstream connect error');
    });

    await expect(readCharterLabels(namesByIds, [ARCHIVED, INACTIVE], 'test.tag')).resolves.toEqual(
      [],
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, opts] = reportError.mock.calls[0] as [
      Error,
      { tag: string; level: string; extra: Record<string, unknown> },
    ];
    expect(opts.tag).toBe('test.tag');
    expect(opts.level).toBe('warning');
    expect(opts.extra.ids).toBe(2);
    expect(String(opts.extra.detail)).toContain('upstream connect error');
  });

  it('no ids, no read', async () => {
    const namesByIds = vi.fn(async () => []);

    expect(await readCharterLabels(namesByIds, [], 'test.tag')).toEqual([]);
    expect(await readCharterLabels(namesByIds, ['', ''], 'test.tag')).toEqual([]);
    expect(namesByIds).not.toHaveBeenCalled();
  });
});
