import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PERMISSIONS,
  releaseSchema,
  ROLE_PERMISSIONS,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { INSTANT_MODE_MAX_ROWS } from '@/lib/inventory/instant-mode';

import { buildReleaseList, legacyAnnouncementsFor, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/releases-low-critical-pages (2026-11-18): the What's New for
 * #609 (squash 86625dbbf, live in production since 2026-11-18 09:59:07Z,
 * deployment dpl_4Bu6aVJihnSbh9sd2GdF7vLCTBGn), which uses the two database
 * functions of migration 0470 (#614). Published at the top, below the Liquid
 * Glass draft and above the emptied fields and schedule completion release.
 * Web only: no phone update. Its own file, so the release tests other open
 * branches edit stay as they are.
 */
const ID = 'low-critical-pages-and-list-value-2026-11';
const PAGES_ENTRY = 'low-critical-pages-full';
const VALUE_ENTRY = 'list-value-added-up-in-one-read';
const EMPTIED_FIELDS_ID = 'emptied-fields-and-schedule-completion-2026-11';
// Added by docs/whats-new-receiving-shown-to-managers (2026-11-19): the receiving release (whoever can open a purchase order where Receiving is on), published later, at the top, below the Liquid Glass draft.
const RECEIVING_ID = 'receiving-shown-to-managers-2026-11';
const RECEIVING_AT = '2026-11-19T04:30:00Z';
const PUBLISHED_AT = '2026-11-18T10:00:00Z';
const LIVE_609 = '2026-11-18T09:59:07Z';

const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (id: string) => release().entries.find((e) => e.id === id)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
): ReleaseViewer => ({ role, permissions, enabledModules: [] });
const owner = viewer('owner', [...PERMISSIONS]);
const admin = viewer('admin', ROLE_PERMISSIONS.admin);
const manager = viewer('manager', ROLE_PERMISSIONS.manager);
const staff = viewer('staff', ROLE_PERMISSIONS.staff);
const member = viewer('viewer', ROLE_PERMISSIONS.viewer);
const itemsReadOnly = viewer('staff', ['items:read']);
const noItems = viewer('staff', ['billing:read']);
const shown = (v: ReleaseViewer) => visibleReleases(RELEASES, v).find((r) => r.id === ID);

const REPO = resolve(__dirname, '../../../../..');
/** A source file in the repository, as written. */
const source = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
const WEB = 'apps/web/src';
const DASHBOARD = `${WEB}/app/(dashboard)/dashboard`;

function readerText(r: Release): string[] {
  return [
    r.title,
    r.summary,
    ...r.entries.flatMap((e) => [
      e.title,
      e.area ?? '',
      e.whatChanged,
      e.whyItMatters,
      e.howItAffectsYou,
      e.whatToDo,
      e.link?.label ?? '',
    ]),
  ];
}

describe('the Low + critical pages and list value release: order, status and date', () => {
  // Renamed by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: "is published once, as revision 1, directly below the Liquid Glass draft and above the emptied fields and schedule completion release, the newest published release"): the receiving release is published later, at the top, directly below the Liquid Glass draft.
  it('is published once, as revision 1, directly below the receiving release (published later, below the Liquid Glass draft at the top) and above the emptied fields and schedule completion release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(0, 3)): the receiving release is published at the top, below the Liquid Glass draft, so the list takes one more.
    expect(RELEASES.slice(0, 4).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: without it): the receiving release is published later, at the top, directly below the Liquid Glass draft.
      [RECEIVING_ID, 'published'],
      [ID, 'published'],
      [EMPTIED_FIELDS_ID, 'published'],
    ]);
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: ID): the receiving release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(RECEIVING_ID);
  });

  // Renamed by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: "is dated the whole minute after #609 went live, in the past, with the draft placeholder at the same minute and every release below it older"): the placeholder moved to the minute of the receiving release, published later, above this one.
  it('is dated the whole minute after #609 went live, in the past, with the draft placeholder at or after it and every release below it older', () => {
    expect(release().publishedAt).toBe(PUBLISHED_AT);
    const at = Date.parse(release().publishedAt);
    expect(at % 60_000).toBe(0);
    expect(at).toBeGreaterThan(Date.parse(LIVE_609));
    expect(at - Date.parse(LIVE_609)).toBeLessThan(60_000);
    expect(at).toBeLessThanOrEqual(Date.now());
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES[0].publishedAt equal to this release's): the placeholder is the minute of the receiving release, published later, above this one.
    expect(RELEASES[0]!.publishedAt).toBe(RECEIVING_AT);
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(at);
    // Re-pinned by docs/whats-new-receiving-shown-to-managers (2026-11-19; was: RELEASES.slice(2)): the receiving release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(3)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its two entries', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>!]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [PAGES_ENTRY, 'fixed', 'Inventory'],
      [VALUE_ENTRY, 'fixed', 'Inventory'],
    ]);
    for (const id of [PAGES_ENTRY, VALUE_ENTRY]) {
      expect(RELEASES.filter((r) => r.entries.some((x) => x.id === id)).map((r) => r.id)).toEqual([
        ID,
      ]);
    }
  });
});

describe('the Low + critical pages and list value release: the words', () => {
  it('has the title and summary as written', () => {
    expect(release().title).toBe(
      'Every page of a long Low + critical list is full, and the on hand value is added up in one read',
    );
    expect(release().summary).toBe(
      'On the web, a Low + critical list on Items or Books of more than 2,000 low or critical records now shows 30 of them on every page but the last, and its count and pages are those of the low or critical records. The on hand value above a long list is now added up in one read, so a record added or removed while it is being added up can no longer be counted twice or left out.',
    );
  });

  it('keeps to the wording rules: no emoji, no exclamation mark, "book" only as the Books page, no speed claim, no internal names, and no links', () => {
    for (const text of readerText(release())) {
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/\bbook(?!s\b)/i);
      expect(text).not.toMatch(/\b(faster|quicker|speed|ms|seconds?)\b/i);
      expect(text).not.toMatch(/\b[SB]\d{1,3}\b|docket|migration|\b04\d\d\b|Claude|\bAI\b/i);
      expect(text).not.toMatch(/is_low_stock|inventory_list_value|PostgREST|RPC/);
    }
    for (const e of release().entries) expect(e.link).toBeUndefined();
  });
});

describe('the Low + critical pages and list value release: who is told', () => {
  it('names items:read on each entry, and nothing on the release', () => {
    expect(release().audience).toBeUndefined();
    expect(entry(PAGES_ENTRY).audience).toEqual({ anyPermission: ['items:read'] });
    expect(entry(VALUE_ENTRY).audience).toEqual({ anyPermission: ['items:read'] });
  });

  it('tells every role that reads items both entries, and nobody who cannot read items', () => {
    for (const v of [owner, admin, manager, staff, member, itemsReadOnly]) {
      expect(shown(v)?.entries.map((e) => e.id), v.role).toEqual([PAGES_ENTRY, VALUE_ENTRY]);
    }
    expect(shown(noItems)).toBeUndefined();
  });

  it('is the first notice for whoever it reaches, the emptied fields release is next for an owner, and an old phone build lists it first with its title and summary alone', () => {
    const read = {
      release_id: ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-18T10:01:00Z',
      read_at: '2026-11-18T10:01:00Z',
    };
    for (const v of [owner, admin, manager, staff, member]) {
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(ID);
      expect(buildReleaseList(RELEASES, v, [read], null).latestUnread?.id, v.role).not.toBe(ID);
    }
    expect(buildReleaseList(RELEASES, owner, [read], null).latestUnread?.id).toBe(EMPTIED_FIELDS_ID);
    expect(buildReleaseList(RELEASES, noItems, [], null).latestUnread?.id).not.toBe(ID);
    for (const v of [owner, staff, member]) {
      expect(legacyAnnouncementsFor(RELEASES, v, {})[0], v.role).toEqual({
        id: ID,
        date: '2026-11-18',
        title: release().title,
        body: release().summary,
      });
    }
  });
});

describe('the Low + critical pages and list value release: the code the words rest on', () => {
  const service = () => source(`${WEB}/server/services/inventory.ts`);

  it('Low + critical is the stock=low chip on Items and Books, and both pages are 30 records a page', () => {
    const table = source(`${WEB}/components/inventory/inventory-table.tsx`);
    expect(table).toContain("const VIEWS = ['All items', 'Low + critical', 'Out of stock'] as const;");
    expect(table).toContain("if (v === 'Low + critical') next.set('stock', 'low');");
    for (const page of [`${DASHBOARD}/inventory/page.tsx`, `${DASHBOARD}/books/page.tsx`]) {
      const text = source(page);
      expect(text, page).toContain("lowStock: params.stock === 'low',");
      expect(text, page).toContain('const PAGE_SIZE = 30;');
      expect(text, page).toContain('planLivePage');
    }
  });

  it('the low rule is applied in the request, the 2,000 is the plan cap, and the old after-read filter is gone', () => {
    expect(service()).toContain("query = query.eq('is_low_stock', true);");
    expect(service()).not.toContain("query.or('reorder_point.gt.0,quantity_on_hand.lte.0')");
    expect(service()).toContain('if (first.count > INSTANT_MODE_MAX_ROWS) return null;');
    expect(INSTANT_MODE_MAX_ROWS).toBe(2000);
    const migration = source('supabase/migrations/0470_inventory_list_totals_in_database.sql');
    expect(migration).toContain('return coalesce(p_item.quantity_on_hand <= 0, false)');
    expect(migration).toContain('and coalesce(p_item.quantity_on_hand, 0) <= p_item.reorder_point, false);');
  });

  it('the value is one call beside the page unless the page is planned, as the caller, and the stored figure still serves the default view', () => {
    expect(service()).toContain("this.ctx.supabase.rpc('inventory_list_value', {");
    expect(service()).toContain('const planned = filters.plannedTotals ?? null;');
    expect(service()).toContain('const [mainRes, valueRes] = await Promise.all([query, valueRead]);');
    const migration = source('supabase/migrations/0470_inventory_list_totals_in_database.sql');
    expect(migration).toMatch(
      /create or replace function public\.inventory_list_value[\s\S]*?security invoker[\s\S]*?sum\(coalesce\(i\.quantity_on_hand, 0\) \* coalesce\(i\.unit_cost, 0\)\)/,
    );
    const loader = source(`${WEB}/server/loaders/inventory-list.ts`);
    expect(loader).toContain("['inventory-value-v1']");
    expect(loader).toContain("if (params.page !== undefined && params.page !== '1') return false;");
  });
});
