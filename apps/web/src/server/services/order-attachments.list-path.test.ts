import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OrderAttachmentsService.list signs a row's stored path only when it is under
 * this organization's folder, contains no `?`, `#` or whitespace, and passes
 * the shared segment check (no empty, `.` or `..` segment). Any other row is
 * listed without a link and reported once, at warning level, by id and
 * organization only. The full {org}/{order}/{file} shape is not asked here:
 * the shapes the web panel and the phone mint are signed as before.
 */

const { createSignedUrl, reportError } = vi.hoisted(() => ({
  createSignedUrl: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock('next/cache', () => ({ unstable_cache: vi.fn((fn: unknown) => fn) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl }) } }),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import type { ServiceContext } from './context';
import { isSignableAttachmentPath, OrderAttachmentsService } from './order-attachments';

const ORG = '0a000000-0000-4000-8000-0000000000aa';
const ORDER = '0b000000-0000-4000-8000-0000000000bb';
const OTHER_ORG = '0d000000-0000-4000-8000-0000000000dd';

function row(id: string, storagePath: string) {
  return {
    id,
    order_request_id: ORDER,
    storage_path: storagePath,
    content_type: 'image/jpeg',
    kind: 'dropoff_photo',
    created_at: '2026-11-01T00:00:00Z',
  };
}

function service(rows: Array<ReturnType<typeof row>>) {
  const stub = makeSupabaseStub({
    'order_request_attachments.select': { data: rows, error: null },
  });
  return new OrderAttachmentsService(
    makeServiceContext(stub.client, { organizationId: ORG }) as unknown as ServiceContext,
  );
}

beforeEach(() => {
  createSignedUrl.mockReset();
  createSignedUrl.mockImplementation(async (path: string) => ({
    data: { signedUrl: `https://signed.example.test/${path}` },
    error: null,
  }));
  reportError.mockReset();
  reportError.mockResolvedValue(undefined);
});

describe('isSignableAttachmentPath', () => {
  it.each([
    ['the web panel shape', `${ORG}/${ORDER}/0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4.webp`],
    ['the phone shape', `${ORG}/${ORDER}/k3j9x0q2m7ab.jpg`],
    [
      'a name outside the upload shape, still in the folder',
      `${ORG}/${ORDER}/proof_photo-old.JPEG`,
    ],
    ['a deeper path in the folder', `${ORG}/${ORDER}/sub/a1.jpg`],
  ])('signs %s', (_label, path) => {
    expect(isSignableAttachmentPath(path, ORG)).toBe(true);
  });

  it.each([
    ['another organization', `${OTHER_ORG}/${ORDER}/a1.jpg`],
    ['no organization folder', `a1.jpg`],
    ['a question mark', `${ORG}/${ORDER}/a1.jpg?x=1`],
    ['a hash', `${ORG}/${ORDER}/a1.jpg#x`],
    ['a space', `${ORG}/${ORDER}/a1 b.jpg`],
    ['a trailing space', `${ORG}/${ORDER}/a1.jpg `],
    ['a tab', `${ORG}/${ORDER}/a1\t.jpg`],
    ['a trailing slash', `${ORG}/${ORDER}/a1.jpg/`],
    ['an empty segment', `${ORG}//a1.jpg`],
    ['a dot-dot segment', `${ORG}/../${OTHER_ORG}/a1.jpg`],
    ['a percent sign', `${ORG}/${ORDER}/%2e.jpg`],
    ['not a string', null],
  ])('does not sign %s', (_label, path) => {
    expect(isSignableAttachmentPath(path, ORG)).toBe(false);
  });
});

describe('OrderAttachmentsService.list', () => {
  it('signs the web and phone shapes as before', async () => {
    const web = `${ORG}/${ORDER}/0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4.webp`;
    const phone = `${ORG}/${ORDER}/k3j9x0q2m7ab.jpg`;
    const list = await service([row('att-web', web), row('att-phone', phone)]).list(ORDER);

    expect(list.find((a) => a.id === 'att-web')?.url).toBe(`https://signed.example.test/${web}`);
    expect(list.find((a) => a.id === 'att-phone')?.url).toBe(
      `https://signed.example.test/${phone}`,
    );
    expect(list.find((a) => a.id === 'att-phone')?.thumbUrl).toBe(
      `https://signed.example.test/${phone}`,
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it('lists an unsignable row without a link, never signs it, and reports it once by id', async () => {
    const good = `${ORG}/${ORDER}/k3j9x0q2m7ab.jpg`;
    const bad = `${ORG}/${ORDER}/a1.jpg?x=1`;
    const rows = [row('att-good', good), row('att-unsignable-1', bad)];

    const first = await service(rows).list(ORDER);
    const second = await service(rows).list(ORDER);

    for (const list of [first, second]) {
      const listed = list.find((a) => a.id === 'att-unsignable-1');
      expect(listed).toBeDefined();
      expect(listed?.url).toBeNull();
      expect(listed?.thumbUrl).toBeNull();
      expect(listed?.storagePath).toBe(bad);
      expect(list.find((a) => a.id === 'att-good')?.url).toBe(
        `https://signed.example.test/${good}`,
      );
    }
    expect(createSignedUrl.mock.calls.map((c) => c[0])).not.toContain(bad);

    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, context] = reportError.mock.calls[0] as [Error, Record<string, unknown>];
    expect(context).toMatchObject({
      tag: 'order-attachments.unsignable-path',
      level: 'warning',
      organizationId: ORG,
      extra: { attachmentId: 'att-unsignable-1' },
    });
    expect(JSON.stringify(context)).not.toContain('a1.jpg');
    expect(err.message).not.toContain('a1.jpg');
  });

  it('lists a row under another organization folder without a link', async () => {
    const other = `${OTHER_ORG}/${ORDER}/k3j9x0q2m7ab.jpg`;
    const list = await service([row('att-unsignable-2', other)]).list(ORDER);

    expect(list[0]?.url).toBeNull();
    expect(list[0]?.thumbUrl).toBeNull();
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
