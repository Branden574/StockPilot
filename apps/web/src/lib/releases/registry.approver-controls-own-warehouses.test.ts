import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  HOLD_AVAILABLE_STOCK_LABEL,
  isManagerOrAbove,
  MODULE_REGISTRY,
  NEEDED_BY_CHANGE_LABEL,
  ORDER_WAREHOUSE_WRITE_REFUSED_COPY,
  orderCancelOffer,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { actionsPanelOffersReads } from '../orders/actions-panel-reads';

import {
  buildReleaseList,
  legacyAnnouncementsFor,
  registryFingerprint,
  visibleReleases,
} from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-2026-11-05 (2026-11-05): the S2 release, published
 * at the top, above the Export items release.
 *
 * - #378 (squash bae51d8e6; web and migration 0416, live since 2026-11-03
 *   01:47Z): the six order functions an approver calls ask write access to
 *   the order's warehouse, and the web stops offering an approver outside it
 *   the order's controls.
 * - #487 (squash ebabb2772): the phone half, in EAS update group b0ba5d7e
 *   (runtime 1.4.0, published 2026-11-05 07:35Z). The integrator merges this
 *   only after iOS launches of that group show.
 *
 * Its own file, so the release tests other open branches edit stay as they
 * are. These tests pin the release's id, status, revision, date and order,
 * who its entry reaches, and the code its words rest on.
 */
const ID = 'approver-controls-own-warehouses-2026-11';
const ENTRY_ID = 'approver-controls-own-warehouses';
const EXPORT_ID = 'export-items-permission-2026-11';
// Added by docs/whats-new-count-sheet-long-names (2026-11-10): the count sheet
// release (#492), published later, at the top, above this one. It reaches
// whoever can open a cycle count's PDF where Cycle Counts is on.
const COUNT_SHEET_ID = 'count-sheet-long-names-2026-11';
const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = () => release().entries.find((e) => e.id === ENTRY_ID)!;

const ORDERS: ModuleId[] = ['orders'];
const everyone: ReleaseViewer = {
  role: 'owner',
  permissions: [...PERMISSIONS],
  enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
};
/** A member who holds no permission and no module. */
const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
/** Staff granted orders:approve, the approver the entry speaks to. */
const staffApprover: ReleaseViewer = {
  role: 'staff',
  permissions: ['orders:approve'],
  enabledModules: ORDERS,
};
/** Staff who pick (items:update) and do not approve. */
const staffPicker: ReleaseViewer = {
  role: 'staff',
  permissions: ['items:update'],
  enabledModules: ORDERS,
};
/** Staff with the role's own permissions, where Orders is on. */
const defaultStaff: ReleaseViewer = {
  role: 'staff',
  permissions: [...ROLE_PERMISSIONS.staff],
  enabledModules: ORDERS,
};
/** A viewer with the role's own permissions, who places requests. */
const defaultViewer: ReleaseViewer = {
  role: 'viewer',
  permissions: [...ROLE_PERMISSIONS.viewer],
  enabledModules: ORDERS,
};
/** A viewer granted orders:approve and items:update, where Orders is on:
 *  never offered the steps, before or after, so the words do not fit them. */
const viewerApprover: ReleaseViewer = {
  role: 'viewer',
  permissions: ['orders:approve'],
  enabledModules: ORDERS,
};
const viewerPicker: ReleaseViewer = {
  role: 'viewer',
  permissions: ['items:update'],
  enabledModules: ORDERS,
};
/** An approver where Orders is off. */
const approverOrdersOff: ReleaseViewer = {
  role: 'staff',
  permissions: ['orders:approve', 'items:update'],
  enabledModules: [],
};

/** A file in the repository, as written. */
const REPO = resolve(__dirname, '../../../../..');
const repoFile = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
/** A source file under apps/web/src, as written. */
const source = (rel: string) => repoFile(`apps/web/src/${rel}`);
/** A file in the mobile app, as written. */
const phone = (rel: string) => repoFile(`apps/mobile/${rel}`);
const count = (text: string, needle: string) => text.split(needle).length - 1;

/** Every string a reader can see in a release. */
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

const told = (v: ReleaseViewer) =>
  visibleReleases(RELEASES, v)
    .find((r) => r.id === ID)
    ?.entries.map((e) => e.id);

/** The phone's way to load the update, as the phone entries say it. */
const LOAD_UPDATE =
  'tap Restart now when the app says Update ready, or close the app completely and open it again.';

describe('the S2 release: order, status and date', () => {
  it('is published once, as revision 1, directly below the count sheet release (published later, at the top) and above the Export items release, and no draft is left', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    // Re-pinned by docs/whats-new-count-sheet-long-names (2026-11-10; was: this release at 0, the newest published, and the Export items release at 1): the count sheet release is published later, at the top, the newest published release, so this one is at 1, directly above the Export items release at 2.
    expect(RELEASES[0]?.id).toBe(COUNT_SHEET_ID);
    expect(RELEASES[1]?.id).toBe(ID);
    expect(RELEASES[2]?.id).toBe(EXPORT_ID);
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(COUNT_SHEET_ID);
    expect(RELEASES.filter((r) => r.status === 'draft')).toEqual([]);
    // Permanent, unused anywhere else, and ends in the month it went out.
    expect(ID).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-2026-11$/);
    expect(RELEASES.flatMap((r) => r.entries).filter((e) => e.id === ENTRY_ID)).toHaveLength(1);
    expect(RELEASES.some((r) => r.id === ENTRY_ID)).toBe(false);
  });

  it('is dated in the past on a whole minute, after both halves went out, and after every release below it', () => {
    const at = Date.parse(release().publishedAt);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(at).toBeLessThanOrEqual(Date.now());
    // #378 and 0416 were live on the web and in the database from 01:47Z on
    // 2026-11-03; the phone update was published at 07:35Z on 2026-11-05.
    expect(at).toBeGreaterThan(Date.parse('2026-11-03T01:47:00Z'));
    expect(at).toBeGreaterThan(Date.parse('2026-11-05T07:35:00Z'));
    // Re-pinned by docs/whats-new-count-sheet-long-names (2026-11-10; was: slice(1)): the count sheet release is published at the top, so the releases below this one start at 2, and the one above it is dated later.
    for (const r of RELEASES.slice(2)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('is in the fingerprint, so publishing it changes what clients observe', () => {
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
  });
});

describe('the S2 release: what it says', () => {
  it('has one entry that answers the four questions, with no link and no draft words', () => {
    expect(release().entries.map((e) => e.id)).toEqual([ENTRY_ID]);
    expect(release().audience).toBeUndefined();
    const e = entry();
    expect([e.category, e.area]).toEqual(['fixed', 'Orders']);
    expect(e.link).toBeUndefined();
    for (const answer of [e.whatChanged, e.whyItMatters, e.howItAffectsYou]) {
      expect(answer.length).toBeGreaterThan(0);
    }
    expect(e.whatToDo.length).toBeGreaterThan(8);
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\bbook(ed)?\b/i);
    expect(text).not.toMatch(/!|%|guarantee|verified|instantly|faster|seamless/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toMatch(/\bemail(ed)?\b|\bnotif(y|ied)\b/i);
  });

  it('has a summary that stands on its own for an old phone build, and says how to load the update', () => {
    const summary = release().summary;
    expect(summary).toMatch(/^If you approve orders but work in only some warehouses, /);
    expect(summary).toContain('on the web or in the mobile app');
    expect(summary).toContain('Claim picking and Release show only on orders of your warehouses');
    expect(summary).toContain('Owners, admins and managers see no change.');
    expect(summary).toContain(
      'In the mobile app, tap Restart now when the app says Update ready, or close the app completely and open it again.',
    );
    expect(entry().whatToDo).toBe(
      `No action needed on the web. To load the latest update in the mobile app, ${LOAD_UPDATE}`,
    );
    const prompt = phone('src/lib/ota-update-prompt.ts');
    expect(prompt).toContain("export const UPDATE_PROMPT_TITLE = 'Update ready';");
    expect(prompt).toContain("export const UPDATE_PROMPT_RESTART = 'Restart now';");
  });

  it('tells only the change members see, and nothing on how the earlier screens could be used', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(
      /database|function|direct|PostgREST|rpc|API|bypass|exploit|attacker|token|0416|#\d+/i,
    );
    // #487's Orders list and Returns list fixes are timing fixes, left out.
    expect(text).not.toMatch(/Returns|workspace|Orders list/);
  });
});

describe('the S2 release: who is told', () => {
  it('reaches whoever approves orders or picks where Orders is on, above the viewer role, and nobody else', () => {
    expect(entry().audience).toEqual({
      roles: ['owner', 'admin', 'manager', 'staff'],
      anyPermission: ['orders:approve', 'items:update'],
      modules: ['orders'],
    });
    for (const v of [everyone, staffApprover, staffPicker, defaultStaff]) {
      expect(told(v), v.role).toEqual([ENTRY_ID]);
    }
    for (const role of ['admin', 'manager'] as const) {
      const v: ReleaseViewer = {
        role,
        permissions: [...ROLE_PERMISSIONS[role]],
        enabledModules: ORDERS,
      };
      expect(told(v), role).toEqual([ENTRY_ID]);
    }
    const notTold: [string, ReleaseViewer][] = [
      ['member', member],
      ['defaultViewer', defaultViewer],
      ['viewerApprover', viewerApprover],
      ['viewerPicker', viewerPicker],
      ['approverOrdersOff', approverOrdersOff],
    ];
    for (const [name, v] of notTold) {
      expect(told(v), name).toBeUndefined();
    }
    // Staff pick by default (the phone's pick gate is a manager or
    // items:update), so every staff member where Orders is on is told.
    expect(ROLE_PERMISSIONS.staff).toContain('items:update');
    expect(ROLE_PERMISSIONS.viewer).not.toContain('items:update');
    expect(ROLE_PERMISSIONS.viewer).not.toContain('orders:approve');
  });

  it('is the first notice for whoever it reaches once the count sheet release is read, and a member it does not reach keeps their notice', () => {
    // Re-pinned by docs/whats-new-count-sheet-long-names (2026-11-10; was: nothing read or seen): the count sheet release is published later, at the top, and reaches an owner with every permission and module, so it is read and seen here first; for a reader it does not reach, the read and the stamp change nothing.
    const countSheetRead = {
      release_id: COUNT_SHEET_ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-10T20:10:00Z',
      read_at: '2026-11-10T20:10:00Z',
    };
    expect(buildReleaseList(RELEASES, everyone, [], null).latestUnread?.id).toBe(COUNT_SHEET_ID);
    for (const v of [everyone, staffApprover, staffPicker]) {
      expect(buildReleaseList(RELEASES, v, [countSheetRead], null).latestUnread?.id, v.role).toBe(
        ID,
      );
      expect(legacyAnnouncementsFor(RELEASES, v, { [COUNT_SHEET_ID]: true })[0], v.role).toEqual({
        id: ID,
        date: release().publishedAt.slice(0, 10),
        title: release().title,
        body: release().summary,
      });
    }
    expect(buildReleaseList(RELEASES, member, [], null).latestUnread?.id).toBe(EXPORT_ID);
    expect(legacyAnnouncementsFor(RELEASES, member, {}).map((a) => a.id)).not.toContain(ID);
  });
});

describe('the S2 release: the code its words rest on', () => {
  it('says that owners, admins and managers work in every warehouse, and staff in their own', () => {
    for (const role of ['owner', 'admin', 'manager'] as const) {
      expect(isManagerOrAbove(role), role).toBe(true);
    }
    for (const role of ['staff', 'viewer'] as const) {
      expect(isManagerOrAbove(role), role).toBe(false);
    }
    const warehouse = source('lib/auth/warehouse.ts');
    expect(warehouse).toContain(
      'export function roleSeesEveryWarehouse(role: Role): boolean {\n  return isManagerOrAbove(role);\n}',
    );
    expect(warehouse).toContain("const writableIds = c.role === 'viewer' ? [] : readableIds;");
    expect(phone('src/lib/holdings-elsewhere.ts')).toContain(
      'return isManagerOrAbove(role as Role);',
    );
    expect(entry().howItAffectsYou).toMatch(
      /^Owners, admins and managers work in every warehouse, so nothing changes for them\. /,
    );
  });

  it('quotes the sentence the order service and 0416 refuse with', () => {
    expect(ORDER_WAREHOUSE_WRITE_REFUSED_COPY).toBe(
      "This order is in a warehouse you don't work in, so you can't change it. Ask a manager.",
    );
    expect(entry().whyItMatters).toContain(`“${ORDER_WAREHOUSE_WRITE_REFUSED_COPY}”`);
    expect(
      count(
        repoFile('supabase/migrations/0416_order_functions_warehouse_scope.sql'),
        "detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';",
      ),
    ).toBe(6);
    expect(source('server/services/order-requests.ts')).toContain(
      'throw new ForbiddenError(ORDER_WAREHOUSE_WRITE_REFUSED_COPY);',
    );
    expect(source('app/api/v1/orders/[id]/transition/route.ts')).toContain(
      "return NextResponse.json({ error: 'forbidden', message: e.message }, { status: 403 });",
    );
    // Not "only what you can do on it": Create return on a completed order
    // asks no warehouse in either app, and the database refuses it there.
    expect(entry().whyItMatters).toMatch(
      /Now these controls show only on orders of the warehouses you work in\.$/,
    );
    expect(entry().whyItMatters).not.toContain('only what you can do');
    // "for most of them": the warehouse slip refuses in its own words.
    expect(entry().whyItMatters).toContain('for most of them with');
    expect(source('app/api/orders/[id]/packing-slip-warehouse.pdf/route.tsx')).toContain(
      'Only someone who can hand this order over can print its warehouse slip.',
    );
  });

  it('web: the approver controls, Cancel, Hold and the lines follow the order warehouse', () => {
    const page = source('app/(dashboard)/dashboard/orders/[id]/page.tsx');
    expect(page).toContain(
      'const approverReadsHere = canApprove && approverAccessHas(approverAccess?.readableIds);',
    );
    expect(page).toContain(
      "canApprove && ctx.role !== 'viewer' && approverAccessHas(approverAccess?.writableIds);",
    );
    expect(page).toContain('canApprove={approverWritesHere}');
    expect(page).toContain('canWriteOrderWarehouse: approverWritesHere,');
    expect(page).toContain('canApproveOrders: approverWritesHere,');
    expect(page).toContain(
      'const viewerMayChangeLines = canApprove ? approverReadsHere : isOwnRequest;',
    );
    expect(page).toContain(
      'viewerMayChangeLines && !ADD_LINES_BLOCKED.includes(request.status) && !isReplacement;',
    );
    expect(HOLD_AVAILABLE_STOCK_LABEL).toBe('Hold available stock');
    const panel = source('components/orders/manager-actions-panel.tsx');
    expect(panel).toContain("const approves = canApprove && viewerRole !== 'viewer';");
    expect(panel).toMatch(/\{approves && \(\s*<div[^]*?Internal notes/);
  });

  it('web: the Manager actions card shows for such an approver only with a print or a signature, and never Print warehouse slip', () => {
    const page = source('app/(dashboard)/dashboard/orders/[id]/page.tsx');
    expect(page).toContain('(canApprove && actionsPanelOffersReads(request.status)) ||');
    expect(page).toContain('canPrintWarehouseSlip={viewerMayHandOver}');
    for (const status of ['pending_approval', 'approved', 'backordered', 'in_transit'] as const) {
      expect(actionsPanelOffersReads(status), status).toBe(false);
    }
    for (const status of [
      'picking_complete',
      'packing_slip_generated',
      'staged_for_pickup',
      'staged_for_delivery',
      'completed',
    ] as const) {
      expect(actionsPanelOffersReads(status), status).toBe(true);
    }
    const panel = source('components/orders/manager-actions-panel.tsx');
    expect(panel).toContain('title="Manager actions"');
    expect(panel).toContain('{canPrintWarehouseSlip && (');
    for (const label of ['Print pick slip', 'Print customer slip', 'View signature']) {
      expect(panel, label).toContain(label);
      expect(entry().whatChanged, label).toContain(label);
    }
    expect(entry().whatChanged).toContain(
      'its Manager actions card, when it shows, offers only Print pick slip, Print customer slip and View signature.',
    );
  });

  it('web: the needed-by Change and Claim picking already asked the warehouse, so they are told for the phone only', () => {
    expect(source('lib/orders/needed-by-change.ts')).toContain(
      '(input.access.hasAllAccess || input.access.writableIds.includes(input.warehouseId)));',
    );
    expect(source('app/(dashboard)/dashboard/orders/[id]/page.tsx')).toContain(
      "viewerCanPick = (isManagerOrAbove(ctx.role) || can(ctx, 'items:update')) && hasWhWrite;",
    );
    const e = entry().whatChanged;
    expect(e).toContain(
      `In the mobile app, ${NEEDED_BY_CHANGE_LABEL} beside its needed-by date is hidden too`,
    );
    expect(e).toContain(
      'Claim picking and Release show only on orders of your warehouses, as on the web, for everyone who picks.',
    );
    expect(e).toContain('On the web, its internal notes are hidden too');
  });

  it('phone: every control the entry names follows the order warehouse, and the screen waits for the saved permissions', () => {
    const screen = phone('app/order/[id].tsx');
    expect(screen).toContain('const orderAccess = orderWarehouseAccessAsShown({');
    expect(screen).toContain('const writesHere = orderAccess.writes === true;');
    expect(screen).toContain('const viewerCanPickHere = viewerCanPick && writesHere;');
    expect(count(screen, 'viewerCanPick: viewerCanPickHere,')).toBe(2);
    expect(count(screen, 'canApproveOrders: rpApprove && writesHere,')).toBeGreaterThanOrEqual(4);
    expect(count(screen, 'writesOrderWarehouse: writesHere,')).toBe(2);
    expect(screen).toContain(
      'const canAddItems = canAddOrderItems(lineGate) && !isReplacementOrder && linesInScope;',
    );
    expect(screen).toContain(
      'const canEditItems = canEditOrderLines(lineGate) && !isReplacementOrder && linesInScope;',
    );
    expect(screen).toContain('const savedPermissions = useEffectivePermissionsState();');
    expect(screen).toContain("actionBtn('Claim picking', 'claim'");
    expect(screen).toContain("'Release',");
    // The phone has no internal notes, so the entry names them for the web.
    expect(screen).not.toMatch(/internal notes/i);
    expect(phone('src/lib/order-manager-actions.ts')).toContain(
      'const approves = input.canApproveOrders && !input.isViewerRole && input.writesOrderWarehouse;',
    );
    const scope = phone('src/lib/order-warehouse-scope.ts');
    expect(scope).toContain('export function orderWarehouseAccessAsShown(input: {');
    expect(scope).toContain(
      'if (asked && input.scope == null) return { writes: false, reads: false };',
    );
  });

  it('an own request is still cancelled while it waits for approval, wherever it is, and its items follow the warehouse', () => {
    const outside = { canApprove: true, canWriteOrderWarehouse: false, canRequest: true };
    expect(orderCancelOffer({ status: 'pending_approval', isOwnRequest: true, ...outside })).toBe(
      'requester',
    );
    expect(orderCancelOffer({ status: 'pending_approval', isOwnRequest: false, ...outside })).toBe(
      null,
    );
    expect(orderCancelOffer({ status: 'approved', isOwnRequest: true, ...outside })).toBe(null);
    expect(
      orderCancelOffer({
        status: 'pending_approval',
        isOwnRequest: false,
        canApprove: true,
        canWriteOrderWarehouse: true,
        canRequest: true,
      }),
    ).toBe('approver');
    const service = source('server/services/order-requests.ts');
    expect(service).toContain(
      "if (!ownPending) await this.assertOrderWarehouseAccess(order.warehouse_id, 'write');",
    );
    expect(service).toContain("await this.assertOrderWarehouseAccess(h.warehouse_id, 'read');");
    expect(entry().howItAffectsYou).toContain(
      'A request you placed yourself can still be cancelled while it waits for approval, wherever it is, but its items can be changed only in a warehouse you work in.',
    );
  });

  it("a delivery's driver keeps the hand-over wherever the order is, on the web and in the mobile app", () => {
    const secrets = source('server/lib/order-secrets.ts');
    expect(secrets).toMatch(
      /export function handOverAllowed\([^]*?\): boolean \{\n {2}if \(isAssignedDriver\(ctx, order\)\) return true;/,
    );
    expect(source('app/(dashboard)/dashboard/orders/[id]/page.tsx')).toContain(
      "(isAssignedDriver && ['staged_for_delivery', 'in_transit'].includes(request.status)));",
    );
    expect(source('components/orders/manager-actions-panel.tsx')).toContain(
      '(approves || isDriverHere) && (',
    );
    expect(phone('src/lib/order-manager-actions.ts')).toContain(
      'const driverHere = input.isAssignedDriver && DRIVER_STATUSES.has(st);',
    );
    expect(entry().howItAffectsYou).toContain(
      'As the driver of a delivery, you can still hand it over, wherever it is.',
    );
  });
});
