import { describe, expect, it } from 'vitest';

import {
  audienceIncludes,
  clientReleaseSchema,
  releaseRegistrySchema,
  releaseSchema,
  releaseStateActionSchema,
  type Release,
  type ReleaseViewer,
} from './releases';

/**
 * Release content is published by pull request, so this schema IS the review
 * checklist a machine can enforce. Each rule below exists because breaking it
 * hurts a real reader: a link that strands a phone on "Unmatched Route", a date
 * that shows as yesterday, an entry that says nothing, an id whose rename
 * re-announces old news to everyone.
 */

const entry = {
  id: 'staging-search',
  category: 'improved' as const,
  area: 'Inventory',
  title: 'Find staged stock faster',
  whatChanged: 'Staging has a search box and filters.',
  whyItMatters: 'Long staging lists were slow to scan.',
  howItAffectsYou: 'Type part of a name or PO to narrow the list.',
  whatToDo: 'No action needed.',
  link: { href: '/dashboard/inventory/staging', label: 'Open Staging' },
};

const release = (over: Partial<Release> = {}): Release => ({
  id: 'september-2026',
  revision: 1,
  status: 'published',
  title: 'September improvements',
  summary: 'Faster staging, clearer stock numbers.',
  publishedAt: '2026-09-18T17:00:00Z',
  entries: [entry],
  ...over,
});

describe('releaseSchema', () => {
  it('accepts a complete release', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
  });

  it('requires all four answers on every entry, and none may be blank', () => {
    for (const key of ['whatChanged', 'whyItMatters', 'howItAffectsYou', 'whatToDo'] as const) {
      const { [key]: _omit, ...rest } = entry;
      expect(releaseSchema.safeParse(release({ entries: [rest as never] })).success).toBe(false);
      expect(
        releaseSchema.safeParse(release({ entries: [{ ...entry, [key]: '   ' }] })).success,
      ).toBe(false);
    }
  });

  it('keeps links inside the dashboard: no other path, no absolute URL, no script', () => {
    const ok = (href: string) =>
      releaseSchema.safeParse(release({ entries: [{ ...entry, link: { href, label: 'Open' } }] }))
        .success;
    expect(ok('/dashboard/orders?status=backordered')).toBe(true);
    expect(ok('/dashboard')).toBe(true);
    expect(ok('/whats-new/x')).toBe(false);
    expect(ok('https://example.com/dashboard')).toBe(false);
    expect(ok('//evil.example/dashboard')).toBe(false);
    expect(ok('javascript:alert(1)')).toBe(false);
    expect(ok('/dashboardx')).toBe(false);
  });

  it('refuses a bare date: it would render as the previous day west of Greenwich', () => {
    expect(releaseSchema.safeParse(release({ publishedAt: '2026-09-18' })).success).toBe(false);
    expect(
      releaseSchema.safeParse(release({ publishedAt: '2026-09-18T10:00:00-07:00' })).success,
    ).toBe(true);
  });

  it('refuses markup in text: content is rendered as text, and must read as text', () => {
    expect(releaseSchema.safeParse(release({ title: 'Hello <b>there</b>' })).success).toBe(false);
  });

  it('refuses unknown keys, so a typo in a field name cannot silently drop content', () => {
    expect(releaseSchema.safeParse({ ...release(), sumary: 'typo' }).success).toBe(false);
    expect(
      releaseSchema.safeParse(release({ entries: [{ ...entry, whatchanged: 'typo' } as never] }))
        .success,
    ).toBe(false);
  });

  it('refuses duplicate entry ids, and a withdrawn release with no explanation', () => {
    expect(releaseSchema.safeParse(release({ entries: [entry, entry] })).success).toBe(false);
    expect(releaseSchema.safeParse(release({ status: 'withdrawn' })).success).toBe(false);
    expect(
      releaseSchema.safeParse(release({ status: 'withdrawn', withdrawnNote: 'Rolled back.' }))
        .success,
    ).toBe(true);
  });

  it('only accepts audiences made of real roles, permissions and modules', () => {
    const withAudience = (audience: unknown) =>
      releaseSchema.safeParse(release({ audience: audience as never })).success;
    expect(
      withAudience({ roles: ['manager'], anyPermission: ['orders:approve'], modules: ['orders'] }),
    ).toBe(true);
    expect(withAudience({ roles: ['superuser'] })).toBe(false);
    expect(withAudience({ anyPermission: ['orders:teleport'] })).toBe(false);
    expect(withAudience({ modules: ['time_travel'] })).toBe(false);
    expect(withAudience({ roles: [] })).toBe(false);
  });
});

describe('releaseRegistrySchema', () => {
  it('refuses duplicate release ids', () => {
    expect(releaseRegistrySchema.safeParse([release(), release()]).success).toBe(false);
  });

  it('requires newest first, but keeps the author’s order for a shared date', () => {
    const older = release({ id: 'older', publishedAt: '2026-08-01T00:00:00Z' });
    const newer = release({ id: 'newer', publishedAt: '2026-09-01T00:00:00Z' });
    const sameDay = release({ id: 'same-day', publishedAt: '2026-09-01T00:00:00Z' });
    expect(releaseRegistrySchema.safeParse([newer, sameDay, older]).success).toBe(true);
    expect(releaseRegistrySchema.safeParse([older, newer]).success).toBe(false);
  });
});

describe('audienceIncludes', () => {
  const viewer: ReleaseViewer = {
    role: 'staff',
    permissions: new Set(['items:read', 'orders:request'] as const),
    enabledModules: new Set(['inventory', 'orders'] as const),
  };

  it('is open to everyone when no audience is named', () => {
    expect(audienceIncludes(undefined, viewer)).toBe(true);
    expect(audienceIncludes({}, viewer)).toBe(true);
  });

  it('ANDs the dimensions and ORs inside each', () => {
    expect(audienceIncludes({ roles: ['staff', 'manager'] }, viewer)).toBe(true);
    expect(audienceIncludes({ roles: ['manager'] }, viewer)).toBe(false);
    expect(audienceIncludes({ anyPermission: ['orders:approve', 'orders:request'] }, viewer)).toBe(
      true,
    );
    expect(audienceIncludes({ anyPermission: ['orders:approve'] }, viewer)).toBe(false);
    expect(audienceIncludes({ modules: ['schedule', 'orders'] }, viewer)).toBe(true);
    expect(audienceIncludes({ modules: ['schedule'] }, viewer)).toBe(false);
    // role passes, module does not: refused.
    expect(audienceIncludes({ roles: ['staff'], modules: ['schedule'] }, viewer)).toBe(false);
  });

  it('accepts arrays as well as sets', () => {
    expect(
      audienceIncludes(
        { anyPermission: ['items:read'] },
        { role: 'viewer', permissions: ['items:read'], enabledModules: [] },
      ),
    ).toBe(true);
  });
});

describe('client contract', () => {
  it('ignores keys it does not know, so an old tab can read a newer deployment’s release', () => {
    const parsed = clientReleaseSchema.safeParse({
      id: 'x',
      revision: 3,
      status: 'published',
      title: 't',
      summary: 's',
      publishedAt: '2026-09-18T17:00:00Z',
      entryCount: 1,
      state: { read: false, dismissed: false, futureFlag: true },
      entries: [{ ...entry, category: 'a-category-from-the-future', futureField: 1 }],
      somethingNew: { nested: true },
    });
    expect(parsed.success).toBe(true);
    // An unknown category degrades to a safe label instead of failing the whole release.
    expect(parsed.success && parsed.data.entries[0]!.category).toBe('improved');
  });

  it('a state action can only name a release by slug, never a user', () => {
    expect(
      releaseStateActionSchema.safeParse({ action: 'read', releaseId: 'september-2026' }).success,
    ).toBe(true);
    expect(releaseStateActionSchema.safeParse({ action: 'read_all' }).success).toBe(true);
    expect(
      releaseStateActionSchema.safeParse({
        action: 'read',
        releaseId: 'september-2026',
        userId: 'u-2',
      }).success,
    ).toBe(false);
    expect(
      releaseStateActionSchema.safeParse({ action: 'read', releaseId: '../etc' }).success,
    ).toBe(false);
    expect(
      releaseStateActionSchema.safeParse({ action: 'unread', releaseId: 'september-2026' }).success,
    ).toBe(false);
  });
});
