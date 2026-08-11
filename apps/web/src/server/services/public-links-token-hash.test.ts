/**
 * Security MED-26 / migration 0330 — /r catalog tokens hashed at rest.
 *
 * Proves the four properties the security item demands, on the PUBLIC LINKS
 * side (the /m maintenance side has its own twin suite in
 * maintenance-share-links.test.ts):
 *   (a) create/duplicate write a 64-hex token_hash and NO plaintext under
 *       any key;
 *   (b) resolution compares sha256(presented plaintext) against the hash
 *       column — the plaintext returned at mint is what resolves;
 *   (c) presenting the STORED HASH as a token can never resolve (the
 *       service digests every presented value, so the comparison value is
 *       hash-of-the-hash, never the stored digest itself) — i.e. we did
 *       not store-and-compare plaintext under a misleading column name;
 *   (d) rotateToken mints a fresh hash over the SAME row (old plaintext's
 *       hash no longer matches) and keeps the org legacy column in sync by
 *       HASH comparison.
 */
import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The service calls revalidateTag on mutations; public-catalog builds an
// unstable_cache wrapper at import time.
vi.mock('next/cache', () => ({
  unstable_cache: vi.fn((fn: unknown) => fn),
  revalidateTag: vi.fn(),
}));

vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

const { createAdminClientMock } = vi.hoisted(() => ({ createAdminClientMock: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: createAdminClientMock,
}));

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { resolvePublicRequestToken } from './public-catalog';
import { PublicLinksService } from './public-links';

const LINK_ID = '22222222-2222-4222-8222-222222222222';

function build(canned: Parameters<typeof makeSupabaseStub>[0] = {}) {
  const stub = makeSupabaseStub(canned);
  // Defaults: admin role (holds public_links:manage per 0261 seed) and the
  // full grandfathered module set (public_requests enabled).
  const ctx = makeServiceContext(stub.client);
  return { stub, ctx };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PublicLinksService.create — show-once mint (MED-26 a)', () => {
  it('writes token_hash = sha256(returned plaintext), 64-hex, and NO plaintext token under any key', async () => {
    const { stub, ctx } = build({
      'public_request_links.insert': { data: { id: LINK_ID }, error: null },
    });

    const res = await new PublicLinksService(ctx).create({ name: 'Spring book fair' });

    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    const insert = stub.chainArgs.get('public_request_links.insert')![0]![0] as Record<string, unknown>;
    expect(insert.token_hash).toBe(sha256(res.token));
    expect(insert.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(insert).not.toHaveProperty('token');
    for (const value of Object.values(insert)) {
      expect(String(value)).not.toContain(res.token);
    }
  });

  it('mints a different token per create (no fixed/predictable value)', async () => {
    const { ctx } = build({
      'public_request_links.insert': { data: { id: LINK_ID }, error: null },
    });
    const svc = new PublicLinksService(ctx);
    const a = await svc.create({ name: 'A' });
    const b = await svc.create({ name: 'B' });
    expect(a.token).not.toBe(b.token);
  });
});

describe('PublicLinksService.duplicate — fresh hash, no plaintext (MED-26 a)', () => {
  it('the copy is inserted with its own 64-hex token_hash and no plaintext token key', async () => {
    const { stub, ctx } = build({
      'public_request_links.select': {
        data: {
          id: LINK_ID,
          name: 'Source',
          purpose: null,
          instructions: null,
          active: true,
          expires_at: null,
          available_from: null,
          available_until: null,
          availability_display: 'bucket',
          books_enabled: true,
          items_enabled: false,
          include_public_pool: false,
          default_max_qty: null,
          created_at: '2026-08-01T00:00:00Z',
          updated_at: '2026-08-01T00:00:00Z',
        },
        error: null,
      },
      'public_request_links.insert': { data: { id: 'new-link' }, error: null },
      'public_link_catalog_entries.select': { data: [], error: null },
    });

    await new PublicLinksService(ctx).duplicate(LINK_ID);

    const insert = stub.chainArgs.get('public_request_links.insert')![0]![0] as Record<string, unknown>;
    expect(insert.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(insert).not.toHaveProperty('token');
    // Always inserted inactive — the show-once URL for a copy comes from
    // Rotate in its editor, after review.
    expect(insert.active).toBe(false);
  });
});

describe('PublicLinksService.rotateToken — regenerate invalidates the old plaintext (MED-26 d)', () => {
  const OLD_TOKEN = 'a'.repeat(64);

  function cannedRotate(orgHash: string | null) {
    return {
      // loadForAudit reads the link row (token_hash included).
      'public_request_links.select': {
        data: {
          active: true,
          token_hash: sha256(OLD_TOKEN),
          name: 'General request link',
          include_public_pool: false,
          books_enabled: true,
          items_enabled: false,
          default_max_qty: null,
        },
        error: null,
      },
      'public_request_links.update': { data: { id: LINK_ID }, error: null },
      'organizations.select': { data: { public_request_token_hash: orgHash }, error: null },
      'organizations.update': { data: null, error: null },
    };
  }

  it('stores sha256(new plaintext) on the SAME link row — the OLD plaintext\'s hash no longer matches, so every previously shared URL stops resolving', async () => {
    const { stub, ctx } = build(cannedRotate(null));

    const res = await new PublicLinksService(ctx).rotateToken(LINK_ID);

    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.token).not.toBe(OLD_TOKEN);
    const update = stub.chainArgs.get('public_request_links.update')![0]![0] as Record<string, unknown>;
    expect(update.token_hash).toBe(sha256(res.token));
    expect(update.token_hash).not.toBe(sha256(OLD_TOKEN));
    expect(update).not.toHaveProperty('token');
    const filters = stub.chainArgs.get('public_request_links.update')!;
    expect(filters).toContainEqual(['organization_id', ctx.organizationId]);
    expect(filters).toContainEqual(['id', LINK_ID]);
  });

  it('General-link org sync compares and writes HASHES: when organizations.public_request_token_hash equals the link\'s old hash, the org row gets sha256(new token) — never a plaintext column', async () => {
    const { stub, ctx } = build(cannedRotate(sha256(OLD_TOKEN)));

    const res = await new PublicLinksService(ctx).rotateToken(LINK_ID);

    const orgUpdate = stub.chainArgs.get('organizations.update')![0]![0] as Record<string, unknown>;
    expect(orgUpdate.public_request_token_hash).toBe(sha256(res.token));
    expect(orgUpdate).not.toHaveProperty('public_request_token');
    expect(orgUpdate.public_request_token_rotated_at).toEqual(expect.any(String));
  });

  it('a NON-General link (org hash differs) never touches the organizations row', async () => {
    const { stub, ctx } = build(cannedRotate(sha256('b'.repeat(64))));
    await new PublicLinksService(ctx).rotateToken(LINK_ID);
    expect(stub.chainArgs.has('organizations.update')).toBe(false);
  });
});

describe('resolvePublicRequestToken — hash-compare resolution (MED-26 b/c)', () => {
  const TOKEN = 'c'.repeat(64);

  it('SECURITY PROPERTY (b) — the links lookup AND the legacy org fallback both filter on sha256(presented plaintext), never the plaintext', async () => {
    const adminStub = makeSupabaseStub({
      'public_request_links.select': { data: null, error: null },
      'organizations.select': { data: null, error: null },
    });
    createAdminClientMock.mockReturnValue(adminStub.client);

    await expect(resolvePublicRequestToken(TOKEN)).resolves.toBeNull();

    const linkArgs = adminStub.chainArgs.get('public_request_links.select')!;
    expect(linkArgs).toContainEqual(['token_hash', sha256(TOKEN)]);
    expect(linkArgs).not.toContainEqual(['token', TOKEN]);
    expect(linkArgs).not.toContainEqual(['token_hash', TOKEN]);

    const orgArgs = adminStub.chainArgs.get('organizations.select')!;
    expect(orgArgs).toContainEqual(['public_request_token_hash', sha256(TOKEN)]);
    expect(orgArgs).not.toContainEqual(['public_request_token', TOKEN]);
  });

  it('SECURITY PROPERTY (c) — presenting the STORED HASH as a token compares hash-of-the-hash, which can never equal the stored digest: a DB leak of token_hash grants nothing', async () => {
    const storedHash = sha256(TOKEN);
    const adminStub = makeSupabaseStub({
      'public_request_links.select': { data: null, error: null },
      'organizations.select': { data: null, error: null },
    });
    createAdminClientMock.mockReturnValue(adminStub.client);

    await expect(resolvePublicRequestToken(storedHash)).resolves.toBeNull();

    const linkArgs = adminStub.chainArgs.get('public_request_links.select')!;
    expect(linkArgs).toContainEqual(['token_hash', sha256(storedHash)]);
    expect(linkArgs).not.toContainEqual(['token_hash', storedHash]);
  });
});
