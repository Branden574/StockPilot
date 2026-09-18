// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const info = vi.hoisted(() => ({ build: 'abc123def456', builtAt: '2026-09-18T17:00:00.000Z' }));
const registry = vi.hoisted(() => ({
  releases: [
    {
      id: 'a-draft',
      revision: 1,
      status: 'draft',
      publishedAt: '2026-09-20T17:00:00Z',
      entries: [],
    },
    {
      id: 'september-2026',
      revision: 2,
      status: 'published',
      publishedAt: '2026-09-18T17:00:00Z',
      entries: [],
    },
  ] as Array<Record<string, unknown>>,
}));
vi.mock('@/lib/build-info', () => ({
  get LOADED_BUILD() {
    return info.build;
  },
  get LOADED_BUILT_AT() {
    return info.builtAt;
  },
}));
vi.mock('@/lib/releases/registry', () => ({
  get RELEASES() {
    return registry.releases;
  },
}));

import { GET } from './route';

beforeEach(() => {
  info.build = 'abc123def456';
  info.builtAt = '2026-09-18T17:00:00.000Z';
});

describe('GET /api/version', () => {
  it('still answers `build`, which tabs running the previous notifier depend on', async () => {
    const body = await (await GET()).json();
    expect(body.build).toBe('abc123def456');
  });

  it('adds build time, environment and an OPAQUE registry key: no slug, no revision', async () => {
    const body = await (await GET()).json();
    expect(body).toEqual({
      build: 'abc123def456',
      builtAt: '2026-09-18T17:00:00.000Z',
      env: 'development',
      releasesKey: createHash('sha256')
        .update('september-2026@2:published')
        .digest('hex')
        .slice(0, 12),
    });
    // Unauthenticated callers learn that the registry changed, never what is in it.
    const text = JSON.stringify(body);
    expect(text).not.toContain('september-2026');
    expect(text).not.toContain('a-draft');
    expect(body).not.toHaveProperty('release');
  });

  it('changes the key when a release is re-announced or withdrawn, and not when a draft is prepared', async () => {
    const before = (await (await GET()).json()).releasesKey;
    const original = registry.releases;
    try {
      registry.releases = [
        {
          id: 'another-draft',
          revision: 1,
          status: 'draft',
          publishedAt: '2026-09-21T00:00:00Z',
          entries: [],
        },
        ...original,
      ];
      expect((await (await GET()).json()).releasesKey).toBe(before);

      registry.releases = original.map((r) =>
        r.id === 'september-2026' ? { ...r, revision: 3 } : r,
      );
      const reannounced = (await (await GET()).json()).releasesKey;
      expect(reannounced).not.toBe(before);

      registry.releases = original.map((r) =>
        r.id === 'september-2026' ? { ...r, status: 'withdrawn' } : r,
      );
      const withdrawn = (await (await GET()).json()).releasesKey;
      expect(withdrawn).not.toBe(before);
      expect(withdrawn).not.toBe(reannounced);

      registry.releases = [];
      expect((await (await GET()).json()).releasesKey).toBeNull();
    } finally {
      registry.releases = original;
    }
  });

  it('never exposes a raw commit: the build is a short opaque hash', async () => {
    const body = await (await GET()).json();
    expect(body.build).toMatch(/^[a-f0-9]{12}$/);
  });

  it('outside a Vercel build it answers a STABLE id, so development does not prompt on every poll', async () => {
    info.build = '';
    info.builtAt = '';
    const first = await (await GET()).json();
    const second = await (await GET()).json();
    expect(first.build).toMatch(/^[a-f0-9]{12}$/);
    expect(second.build).toBe(first.build);
    expect(first.builtAt).toBeNull();
  });

  it('is never cached', async () => {
    expect((await GET()).headers.get('Cache-Control')).toBe('no-store, max-age=0, must-revalidate');
  });
});
