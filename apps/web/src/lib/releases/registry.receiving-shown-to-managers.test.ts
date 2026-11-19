import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  dbPermissionRefusedCopy,
  MODULE_REGISTRY,
  PERMISSIONS,
  releaseSchema,
  ROLE_PERMISSIONS,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { buildReleaseList, legacyAnnouncementsFor, visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-receiving-shown-to-managers (2026-11-19): the What's
 * New for #617 (receiving follows the rule the database applies: a manager or
 * above with Adjust on-hand), published at the top, below the Liquid Glass
 * draft and above the Low + critical pages and list value release. The web
 * half is live when #617 is; the phone half comes with the next phone update,
 * and the words say so. SET AT MERGE: publishedAt is the whole minute after
 * #617's production deployment went live (the integrator's record), and the
 * Liquid Glass draft placeholder takes the same minute, so these tests pin
 * the shape and the order, not the minute itself. Its own file, so the
 * release tests other open branches edit stay as they are.
 */
const ID = 'receiving-shown-to-managers-2026-11';
const ENTRY = 'receive-items-for-people-who-can-receive';
const LOW_CRITICAL_ID = 'low-critical-pages-and-list-value-2026-11';
const LOW_CRITICAL_AT = '2026-11-18T10:00:00Z';
/** core RECEIVE_MANAGER_ONLY_COPY in #617: the page note and the refusal. */
const MANAGER_ONLY = 'Only a manager can receive purchase orders.';
/** ReceivingService's answer to the database's refusal of staff before #617. */
const NOT_FOUND = 'PO or line not found.';

const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = () => release().entries.find((e) => e.id === ENTRY)!;

const ALL_MODULES = Object.keys(MODULE_REGISTRY) as ModuleId[];
const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'] = ['receiving'],
): ReleaseViewer => ({ role, permissions, enabledModules });
const owner = viewer('owner', [...PERMISSIONS], ALL_MODULES);
const admin = viewer('admin', ROLE_PERMISSIONS.admin);
const manager = viewer('manager', ROLE_PERMISSIONS.manager);
const staff = viewer('staff', ROLE_PERMISSIONS.staff);
const member = viewer('viewer', ROLE_PERMISSIONS.viewer);
const receivingOff = viewer('staff', ROLE_PERMISSIONS.staff, []);
const noPurchaseOrders = viewer(
  'staff',
  ROLE_PERMISSIONS.staff.filter((p) => p !== 'purchase_orders:read'),
);
const shown = (v: ReleaseViewer) => visibleReleases(RELEASES, v).find((r) => r.id === ID);

const REPO = resolve(__dirname, '../../../../..');
/** A source file in the repository, as written. */
const source = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');

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

describe('the receiving release: order, status and date', () => {
  it('is published once, as revision 1, directly below the Liquid Glass draft and above the Low + critical pages and list value release, the newest published release', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    expect(RELEASES.slice(0, 3).map((r) => [r.id, r.status])).toEqual([
      ['liquid-glass-2026-11', 'draft'],
      [ID, 'published'],
      [LOW_CRITICAL_ID, 'published'],
    ]);
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(ID);
  });

  it('is dated on a whole minute, in the past, after the release below it, with the draft placeholder at the same minute and every release below it older', () => {
    const at = Date.parse(release().publishedAt);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(at).toBeGreaterThan(Date.parse(LOW_CRITICAL_AT));
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(RELEASES[0]!.publishedAt).toBe(release().publishedAt);
    for (const r of RELEASES.slice(2)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('parses under the shared schema, in plain text, with its one entry', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>!]/);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [ENTRY, 'fixed', 'Receiving'],
    ]);
    expect(RELEASES.filter((r) => r.entries.some((x) => x.id === ENTRY)).map((r) => r.id)).toEqual([
      ID,
    ]);
  });
});

describe('the receiving release: the words', () => {
  it('has the title, summary and entry as written', () => {
    expect(release().title).toBe(
      'Receive items on a purchase order shows only for people who can receive',
    );
    expect(release().summary).toBe(
      'On the web, Receive items on a purchase order now shows only for managers, admins and owners with the Adjust on-hand permission, and staff see "Only a manager can receive purchase orders." in its place. The mobile app does the same after its next update. Until then, Post receipt in the app answers a staff member with that sentence instead of "PO or line not found."',
    );
    expect(entry().title).toBe('Receive items shows only for people who can receive');
    expect(entry().whatChanged).toBe(
      'On the web, on a purchase order ready to receive, Receive items now shows only for managers, admins and owners with the Adjust on-hand permission. Staff with Adjust on-hand see "Only a manager can receive purchase orders." in its place, and still see what was ordered and received. In the mobile app, Scan, the quantities and Post receipt follow the same rule after the next update. Until then, when a staff member taps Post receipt in the app, it says "Only a manager can receive purchase orders." On the Roles page, Manage purchase orders says that receiving a PO needs a manager or above.',
    );
    expect(entry().whyItMatters).toBe(
      'Only managers, admins and owners have ever been able to post a receipt. Staff were offered Receive items and Post receipt, and every receipt they posted was refused with "PO or line not found." Nothing was recorded.',
    );
    expect(entry().howItAffectsYou).toBe(
      'Nothing changes in who can receive. If you are on staff, ask a manager to post the receipt. Without Adjust on-hand, a purchase order says what it said before.',
    );
    expect(entry().whatToDo).toBe(
      'No action needed. In the mobile app, the next update comes when the app says Update ready: tap Restart now, or close the app completely and open it again.',
    );
  });

  it('quotes the sentence people see and the one it replaces, and says which half waits for the phone update', () => {
    expect(release().summary).toContain(`"${MANAGER_ONLY}"`);
    expect(release().summary).toContain(`"${NOT_FOUND}"`);
    expect(entry().whatChanged).toContain(`"${MANAGER_ONLY}"`);
    expect(entry().whyItMatters).toContain(`"${NOT_FOUND}"`);
    expect(entry().whatChanged).toContain('On the web,');
    expect(entry().whatChanged).toContain('after the next update');
    expect(entry().whatChanged).toContain('Until then,');
  });

  it('keeps to the wording rules: no emoji, no exclamation mark, no "book", no internal names, and no links', () => {
    for (const text of readerText(release())) {
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/\bbook/i);
      expect(text).not.toMatch(
        /\b[SB]\d{1,3}\b|docket|migration|database|\b04\d\d\b|Claude|\bAI\b/i,
      );
      expect(text).not.toMatch(/stock:adjust|purchase_orders:|post_receipt|RPC|403/);
    }
    expect(entry().link).toBeUndefined();
  });
});

describe('the receiving release: who is told', () => {
  it('names purchase_orders:read with Receiving on, on the entry, and nothing on the release', () => {
    expect(release().audience).toBeUndefined();
    expect(entry().audience).toEqual({
      anyPermission: ['purchase_orders:read'],
      modules: ['receiving'],
    });
  });

  it('tells every role that opens purchase orders where Receiving is on, and nobody else', () => {
    for (const v of [owner, admin, manager, staff, member]) {
      expect(
        shown(v)?.entries.map((e) => e.id),
        v.role,
      ).toEqual([ENTRY]);
    }
    expect(shown(receivingOff)).toBeUndefined();
    expect(shown(noPurchaseOrders)).toBeUndefined();
  });

  it('is the first notice for whoever it reaches, the Low + critical release is next for an owner, and an old phone build lists it first with its title and summary alone', () => {
    const read = {
      release_id: ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-19T04:31:00Z',
      read_at: '2026-11-19T04:31:00Z',
    };
    for (const v of [owner, admin, manager, staff, member]) {
      expect(buildReleaseList(RELEASES, v, [], null).latestUnread?.id, v.role).toBe(ID);
      expect(buildReleaseList(RELEASES, v, [read], null).latestUnread?.id, v.role).not.toBe(ID);
    }
    expect(buildReleaseList(RELEASES, owner, [read], null).latestUnread?.id).toBe(LOW_CRITICAL_ID);
    expect(buildReleaseList(RELEASES, receivingOff, [], null).latestUnread?.id).not.toBe(ID);
    for (const v of [owner, staff, member]) {
      expect(legacyAnnouncementsFor(RELEASES, v, {})[0], v.role).toEqual({
        id: ID,
        date: release().publishedAt.slice(0, 10),
        title: release().title,
        body: release().summary,
      });
    }
  });
});

describe('the receiving release: the code the words rest on', () => {
  // The rule, the page note and the phone gate are #617's (core
  // canPostReceipt and RECEIVE_MANAGER_ONLY_COPY, the purchase order page,
  // apps/mobile/src/lib/cta-gating.ts); this branch is cut from main before
  // #617 merges, so those are checked in #617's own tests. What is pinned
  // here is on main already and stays true after #617.
  it('without Adjust on-hand, a purchase order keeps the sentence it already says', () => {
    const page = source('apps/web/src/app/(dashboard)/dashboard/purchase-orders/[id]/page.tsx');
    expect(page).toContain(
      "const receiveRefusal = receivableHere && !canAdjustStock ? dbPermissionRefusedCopy('receipt_post') : null;",
    );
    expect(dbPermissionRefusedCopy('receipt_post')).toBe(
      'Receiving stock needs the Adjust on-hand permission. Ask an admin if you need it.',
    );
  });

  it("an installed phone shows the receipt route's own sentence for a refusal that names no reason", () => {
    const route = source('apps/web/src/app/api/v1/po/[id]/receipts/route.ts');
    expect(route).toContain('message: e.message,');
    const screen = source('apps/mobile/app/po/[id].tsx');
    expect(screen).toContain(
      'message: reason ?? (failure instanceof Error ? failure.message : String(failure)),',
    );
    const mapper = source('apps/mobile/src/lib/receipt-post-error.ts');
    expect(mapper).toContain("'Receive failed',");
    expect(mapper).toContain(
      "message || 'The receipt could not be posted. Check your connection and try again.',",
    );
    // No arm of the mapper matches a word of the sentence, so it reaches the
    // default arm as it is.
    for (const token of mapper.matchAll(/has\('([a-z_]+)'\)/g)) {
      expect(MANAGER_ONLY, token[1]).not.toContain(token[1]!);
    }
  });

  it('the earlier receiving entry is left as it was', () => {
    const earlier = RELEASES.flatMap((r) => r.entries).find(
      (e) => e.id === 'receiving-follows-permission',
    );
    expect(earlier?.howItAffectsYou).toContain('Nothing changes in who can receive');
  });
});
