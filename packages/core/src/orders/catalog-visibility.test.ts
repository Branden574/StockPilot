import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { effectivePermissions, PERMISSION_META } from '../constants/permissions';
import { ROLES } from '../constants/roles';

import {
  isFinalOrderCatalogRefusal,
  memberCanRequestOrders,
  ORDER_CATALOG_FAMILY_MAX,
  ORDER_CATALOG_LAST_HIDE_AT_COLUMN,
  ORDER_CATALOG_MANAGE_PAGE_SIZE,
  ORDER_CATALOG_REFUSALS,
  ORDER_CATALOG_TYPE_FILTERS,
  ORDER_CATALOG_VISIBILITY_CHANGED_AT_COLUMN,
  ORDER_CATALOG_VISIBILITY_FILTERS,
  ORDER_CATALOG_VISIBILITY_MAX_ITEMS,
  ORDER_CATALOG_VISIBILITY_PERMISSION,
  ORDER_CATALOG_VISIBLE_COLUMN,
  ORDER_ITEMS_ACCESS_ALLOW_SCOPE_COPY,
  ORDER_ITEMS_ACCESS_AUDIT_LABEL,
  ORDER_ITEMS_ACCESS_BUSY_COPY,
  ORDER_ITEMS_ACCESS_CHANGED_COPY,
  ORDER_ITEMS_ACCESS_DISABLED_COPY,
  ORDER_ITEMS_ACCESS_INVALID_COPY,
  ORDER_ITEMS_ACCESS_KEPT_ON_REINVITE_COPY,
  ORDER_ITEMS_ACCESS_MANAGER_NEEDS_DENY_COPY,
  ORDER_ITEMS_ACCESS_MODULE_OFF_COPY,
  ORDER_ITEMS_ACCESS_PHONE_ENTRY_COPY,
  ORDER_ITEMS_ACCESS_ROLE_DEFAULT_COPY,
  ORDER_ITEMS_ACCESS_SAVE_FAILED_COPY,
  ORDER_ITEMS_ACCESS_STATE_LABELS,
  ORDER_ITEMS_BUSY_COPY,
  ORDER_ITEMS_FORBIDDEN_COPY,
  ORDER_ITEMS_HIDE_CONFIRM_BODY_COPY,
  ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY,
  ORDER_ITEMS_KITS_NOTE_COPY,
  ORDER_ITEMS_LOAD_FAILED_COPY,
  ORDER_ITEMS_MANAGE_BUTTON_COPY,
  ORDER_ITEMS_MANAGE_SUBLINE_COPY,
  ORDER_ITEMS_NO_ACCESS_COPY,
  ORDER_ITEMS_ROLES_LOCK_NOTE_COPY,
  ORDER_ITEMS_SEARCH_PLACEHOLDER_COPY,
  ORDER_ITEMS_SELECTION_CAP_COPY,
  ORDER_ITEMS_SHOW_CONFIRM_BODY_COPY,
  ORDER_ITEMS_STATE_EXPECTED_COPY,
  ORDER_ITEMS_STATE_HIDDEN_COPY,
  ORDER_ITEMS_STATE_SHOWN_COPY,
  ORDER_ITEMS_TYPE_FILTER_LABELS,
  ORDER_ITEMS_VISIBILITY_FILTER_LABELS,
  ORDER_VISIBILITY_AUDIT_LABEL,
  orderCatalogAccessAfterSavingCopy,
  orderCatalogAccessChipCopy,
  orderCatalogAccessExplanations,
  orderCatalogAccessPreview,
  orderCatalogAccessSourceCopy,
  orderCatalogManageQueryString,
  orderItemsEmptyCopy,
  orderItemsHiddenSinceCopy,
  orderItemsHideConfirmTitle,
  orderItemsRefusalCopy,
  orderItemsRowActionLabel,
  orderItemsSavedCopy,
  orderItemsSelectedCopy,
  orderItemsShowConfirmTitle,
  parseOrderCatalogManageQuery,
  permissionExceptionFromGranted,
  permissionExceptionOverrides,
  type OrderCatalogAccessPreviewInput,
  type PermissionExceptionState,
} from './catalog-visibility';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

describe('the names the database and every surface share', () => {
  it('pins the column, permission and bound names', () => {
    expect(ORDER_CATALOG_VISIBLE_COLUMN).toBe('order_catalog_visible');
    expect(ORDER_CATALOG_VISIBILITY_CHANGED_AT_COLUMN).toBe('order_catalog_visibility_changed_at');
    expect(ORDER_CATALOG_LAST_HIDE_AT_COLUMN).toBe('order_catalog_last_hide_at');
    expect(ORDER_CATALOG_VISIBILITY_PERMISSION).toBe('orders:manage_catalog_visibility');
    // set_order_catalog_visibility: 1 to 500 distinct ids (0413, 22023 otherwise).
    expect(ORDER_CATALOG_VISIBILITY_MAX_ITEMS).toBe(500);
    // The established list page size (cycle-count-list.ts, list-page.ts).
    expect(ORDER_CATALOG_MANAGE_PAGE_SIZE).toBe(25);
    expect(ORDER_CATALOG_FAMILY_MAX).toBe(200);
    expect([...ORDER_CATALOG_VISIBILITY_FILTERS]).toEqual(['all', 'shown', 'hidden']);
    expect([...ORDER_CATALOG_TYPE_FILTERS]).toEqual(['all', 'items', 'books']);
  });

  it('the button is the permission label', () => {
    expect(ORDER_ITEMS_MANAGE_BUTTON_COPY).toBe('Manage order items');
    expect(PERMISSION_META[ORDER_CATALOG_VISIBILITY_PERMISSION].label).toBe(ORDER_ITEMS_MANAGE_BUTTON_COPY);
  });
});

describe('the management words (web and phone say them identically)', () => {
  it('pins the design sentences', () => {
    expect(ORDER_ITEMS_MANAGE_SUBLINE_COPY).toBe(
      'Choose which items and books appear in Place an Order. Hidden items stay in Inventory, existing orders and reports.',
    );
    expect(ORDER_ITEMS_KITS_NOTE_COPY).toBe(
      'Kits appear in Place an Order only while every part can be ordered. If an item has other shown records with the same SKU, a kit can still use them.',
    );
    expect(ORDER_ITEMS_SEARCH_PLACEHOLDER_COPY).toBe('Search name, SKU, barcode or ISBN');
    expect(ORDER_ITEMS_VISIBILITY_FILTER_LABELS).toEqual({
      all: 'All',
      shown: 'Shown in Orders',
      hidden: 'Hidden from Orders',
    });
    expect(ORDER_ITEMS_TYPE_FILTER_LABELS).toEqual({ all: 'All types', items: 'Items', books: 'Books' });
    expect(ORDER_ITEMS_STATE_SHOWN_COPY).toBe('Shown in Orders');
    expect(ORDER_ITEMS_STATE_HIDDEN_COPY).toBe('Hidden from Orders');
    expect(ORDER_ITEMS_STATE_EXPECTED_COPY).toBe('Expected');
    expect(ORDER_ITEMS_SELECTION_CAP_COPY).toBe('Select up to 500 items at a time.');
    expect(ORDER_ITEMS_LOAD_FAILED_COPY).toBe("Couldn't load items. Try again.");
    expect(ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY).toBe(
      'Some selected items are no longer available to you. Nothing was changed.',
    );
    expect(ORDER_ITEMS_BUSY_COPY).toBe('These items are being changed by someone else. Try again.');
    expect(ORDER_ITEMS_FORBIDDEN_COPY).toBe(
      'You no longer have access to manage order items. Ask StockPilot support if this is unexpected.',
    );
    expect(ORDER_ITEMS_NO_ACCESS_COPY).toBe("You don't have access to manage order items.");
    expect(ORDER_ITEMS_ROLES_LOCK_NOTE_COPY).toBe(
      'Managed by StockPilot support. Managers, admins and owners have it by default.',
    );
  });

  it('the hide confirmation carries the brief sentence verbatim', () => {
    expect(ORDER_ITEMS_HIDE_CONFIRM_BODY_COPY).toBe(
      'These items will no longer be available for new orders. Existing orders and inventory will remain unchanged.',
    );
    expect(orderItemsHideConfirmTitle(12)).toBe('Hide 12 items from Orders?');
    expect(orderItemsHideConfirmTitle(1)).toBe('Hide 1 item from Orders?');
    expect(orderItemsShowConfirmTitle(3)).toBe('Show 3 items in Orders?');
    expect(orderItemsShowConfirmTitle(1)).toBe('Show 1 item in Orders?');
    expect(ORDER_ITEMS_SHOW_CONFIRM_BODY_COPY).toBe(
      "They return only where they were already allowed; this does not make them public or change anyone's access.",
    );
  });

  it('a row action names the item for assistive technology', () => {
    expect(orderItemsRowActionLabel(true, 'New Hire Shirt XS')).toBe('Hide New Hire Shirt XS from Orders');
    expect(orderItemsRowActionLabel(false, 'Field Guide to Ponds')).toBe('Show Field Guide to Ponds in Orders');
    expect(orderItemsRowActionLabel(true, '  ')).toBe('Hide from Orders');
    expect(orderItemsRowActionLabel(false, '')).toBe('Show in Orders');
  });

  it('counts, hidden since and the saved sentence', () => {
    expect(orderItemsSelectedCopy(0)).toBe('0 selected');
    expect(orderItemsSelectedCopy(1234)).toBe('1,234 selected');
    expect(orderItemsHiddenSinceCopy('Oct 26, 2026')).toBe('Hidden since Oct 26, 2026');
    expect(orderItemsSavedCopy({ visible: false, changed: 12, unchanged: 3 })).toBe(
      'Hidden 12 items. 3 were already hidden.',
    );
    expect(orderItemsSavedCopy({ visible: false, changed: 1, unchanged: 0 })).toBe('Hidden 1 item.');
    expect(orderItemsSavedCopy({ visible: false, changed: 2, unchanged: 1 })).toBe(
      'Hidden 2 items. 1 was already hidden.',
    );
    expect(orderItemsSavedCopy({ visible: true, changed: 4, unchanged: 0 })).toBe('Shown 4 items.');
    expect(orderItemsSavedCopy({ visible: true, changed: 0, unchanged: 1 })).toBe('That item was already shown.');
    expect(orderItemsSavedCopy({ visible: false, changed: 0, unchanged: 5 })).toBe(
      'All 5 items were already hidden.',
    );
  });

  it('the empty list says which filter emptied it', () => {
    expect(orderItemsEmptyCopy({ visibility: 'all', hasQuery: false })).toBe(
      'No items or books can be managed here yet.',
    );
    expect(orderItemsEmptyCopy({ visibility: 'shown', hasQuery: false })).toBe('No items are shown in Orders.');
    expect(orderItemsEmptyCopy({ visibility: 'hidden', hasQuery: false })).toBe('No items are hidden from Orders.');
    expect(orderItemsEmptyCopy({ visibility: 'hidden', hasQuery: true })).toBe('No items match your search.');
  });

  it('every refusal has words, and only forbidden-like ones are final', () => {
    for (const r of ORDER_CATALOG_REFUSALS) expect(orderItemsRefusalCopy(r), r).toMatch(/\.$/);
    expect(orderItemsRefusalCopy('forbidden')).toBe(ORDER_ITEMS_FORBIDDEN_COPY);
    expect(orderItemsRefusalCopy('items_unavailable')).toBe(ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY);
    expect(orderItemsRefusalCopy('busy')).toBe(ORDER_ITEMS_BUSY_COPY);
    expect(isFinalOrderCatalogRefusal('forbidden')).toBe(true);
    expect(isFinalOrderCatalogRefusal('feature_disabled')).toBe(true);
    expect(isFinalOrderCatalogRefusal('module_disabled')).toBe(true);
    // A step-up is not the end: the same operationId is sent again after it.
    expect(isFinalOrderCatalogRefusal('aal2_required')).toBe(false);
    expect(isFinalOrderCatalogRefusal('mfa_required')).toBe(false);
    expect(isFinalOrderCatalogRefusal('busy')).toBe(false);
    expect(isFinalOrderCatalogRefusal('items_unavailable')).toBe(false);
  });

  it('follows the words rules: no "book" for a quantity, no ids, no emojis', () => {
    const all = [
      ORDER_ITEMS_MANAGE_SUBLINE_COPY,
      ORDER_ITEMS_KITS_NOTE_COPY,
      ORDER_ITEMS_HIDE_CONFIRM_BODY_COPY,
      ORDER_ITEMS_SHOW_CONFIRM_BODY_COPY,
      ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY,
      ORDER_ITEMS_BUSY_COPY,
      ORDER_ITEMS_FORBIDDEN_COPY,
      ...ORDER_CATALOG_REFUSALS.map((r) => orderItemsRefusalCopy(r)),
    ];
    for (const s of all) {
      expect(s).not.toMatch(/\bbook\b/i);
      expect(s).not.toMatch(/_/);
      expect(s).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe('the management list query (one vocabulary for the page, the route and the phone)', () => {
  it('defaults', () => {
    expect(parseOrderCatalogManageQuery({})).toEqual({
      q: '',
      visibility: 'all',
      type: 'all',
      warehouseId: null,
      categoryId: null,
      page: 1,
    });
  });

  it('reads every field, from a record or URLSearchParams', () => {
    const want = { q: 'shirt', visibility: 'hidden', type: 'books', warehouseId: U1, categoryId: U2, page: 3 };
    expect(
      parseOrderCatalogManageQuery({ q: '  shirt ', visibility: 'hidden', type: 'books', warehouseId: U1, categoryId: U2, page: '3' }),
    ).toEqual(want);
    expect(
      parseOrderCatalogManageQuery(
        new URLSearchParams({ q: 'shirt', visibility: 'hidden', type: 'books', warehouseId: U1, categoryId: U2, page: '3' }),
      ),
    ).toEqual(want);
    // Next.js searchParams can hand an array: the first value is used.
    expect(parseOrderCatalogManageQuery({ visibility: ['shown', 'hidden'] }).visibility).toBe('shown');
  });

  it('never trusts a malformed value: unknown filters, non-uuids and bad pages fall back', () => {
    const p = parseOrderCatalogManageQuery({
      visibility: 'everything',
      type: 'rentals',
      warehouseId: 'not-a-uuid',
      categoryId: "1' or 1=1",
      page: '-4',
    });
    expect(p).toMatchObject({ visibility: 'all', type: 'all', warehouseId: null, categoryId: null, page: 1 });
    expect(parseOrderCatalogManageQuery({ page: 'abc' }).page).toBe(1);
    expect(parseOrderCatalogManageQuery({ page: '2.7' }).page).toBe(2);
    expect(parseOrderCatalogManageQuery({ page: '99999999999' }).page).toBe(100000);
    expect(parseOrderCatalogManageQuery({ warehouseId: U1.toUpperCase() }).warehouseId).toBe(U1);
    expect(parseOrderCatalogManageQuery({ q: 'x'.repeat(500) }).q).toHaveLength(200);
  });

  it('writes only the fields that differ from the defaults, and reads back what it wrote', () => {
    expect(orderCatalogManageQueryString(parseOrderCatalogManageQuery({}))).toBe('');
    const filters = parseOrderCatalogManageQuery({ q: 'atlas & rivers', visibility: 'shown', warehouseId: U1, page: '2' });
    const qs = orderCatalogManageQueryString(filters);
    expect(qs).toBe(`q=atlas+%26+rivers&visibility=shown&warehouseId=${U1}&page=2`);
    expect(parseOrderCatalogManageQuery(new URLSearchParams(qs))).toEqual(filters);
  });
});

describe('permission exception states', () => {
  it('reads an override row as the console state', () => {
    expect(permissionExceptionFromGranted(undefined)).toBe('default');
    expect(permissionExceptionFromGranted(null)).toBe('default');
    expect(permissionExceptionFromGranted(true)).toBe('allow');
    expect(permissionExceptionFromGranted(false)).toBe('deny');
  });

  it('writes a state as the user override rows effectivePermissions reads', () => {
    expect(permissionExceptionOverrides('default')).toEqual([]);
    expect(permissionExceptionOverrides('allow')).toEqual([
      { permission: ORDER_CATALOG_VISIBILITY_PERMISSION, granted: true },
    ]);
    expect(permissionExceptionOverrides('deny')).toEqual([
      { permission: ORDER_CATALOG_VISIBILITY_PERMISSION, granted: false },
    ]);
  });

  it('memberCanRequestOrders applies the role default, then the role row, then the user row', () => {
    expect(memberCanRequestOrders({ role: 'viewer' })).toBe(true);
    expect(memberCanRequestOrders({ role: 'viewer', roleOverride: false })).toBe(false);
    expect(memberCanRequestOrders({ role: 'viewer', roleOverride: false, userOverride: true })).toBe(true);
    expect(memberCanRequestOrders({ role: 'manager', userOverride: false })).toBe(false);
    expect(memberCanRequestOrders({ role: 'owner', roleOverride: false, userOverride: false })).toBe(true);
  });
});

// ── The God Admin preview (Appendix A of the design) ───────────────────────
describe('orderCatalogAccessPreview', () => {
  const base: OrderCatalogAccessPreviewInput = {
    role: 'staff',
    exception: 'default',
    disabled: false,
    ordersModuleEnabled: true,
    canRequestOrders: true,
  };
  const states: PermissionExceptionState[] = ['default', 'allow', 'deny'];

  it('matches the role and exception matrix for an active member', () => {
    const matrix: Record<(typeof ROLES)[number], [boolean, boolean, boolean]> = {
      owner: [true, true, false],
      admin: [true, true, false],
      manager: [true, true, false],
      staff: [false, true, false],
      viewer: [false, true, false],
    };
    for (const role of ROLES) {
      states.forEach((exception, i) => {
        const p = orderCatalogAccessPreview({ ...base, role, exception });
        expect(p.effective, `${role} ${exception}`).toBe(matrix[role][i]);
        expect(p.capability, `${role} ${exception}`).toBe(matrix[role][i]);
      });
    }
  });

  it('is built on effectivePermissions, so it cannot disagree with the app gate', () => {
    for (const role of ROLES) {
      for (const exception of states) {
        const p = orderCatalogAccessPreview({ ...base, role, exception });
        expect(p.capability).toBe(
          effectivePermissions(role, [], permissionExceptionOverrides(exception)).has(
            ORDER_CATALOG_VISIBILITY_PERMISSION,
          ),
        );
        expect(p.roleDefault).toBe(effectivePermissions(role).has(ORDER_CATALOG_VISIBILITY_PERMISSION));
      }
    }
  });

  it('a disabled account is never allowed, whatever the exception', () => {
    for (const role of ROLES) {
      for (const exception of states) {
        const p = orderCatalogAccessPreview({ ...base, role, exception, disabled: true });
        expect(p.effective).toBe(false);
        expect(p.blockers).toContain('account_disabled');
      }
    }
  });

  it('the Orders module off blocks everyone, and is named rather than granted', () => {
    const p = orderCatalogAccessPreview({ ...base, role: 'manager', ordersModuleEnabled: false });
    expect(p.capability).toBe(true);
    expect(p.effective).toBe(false);
    expect(p.blockers).toEqual(['orders_module_off']);
  });

  it('without orders:request the phone entry is the Orders list (a note, not a blocker)', () => {
    const p = orderCatalogAccessPreview({ ...base, exception: 'allow', canRequestOrders: false });
    expect(p.effective).toBe(true);
    expect(p.phoneEntryFromOrdersListOnly).toBe(true);
    expect(orderCatalogAccessPreview({ ...base, exception: 'deny', canRequestOrders: false }).phoneEntryFromOrdersListOnly).toBe(false);
  });

  it('names the source of the answer', () => {
    expect(orderCatalogAccessPreview({ ...base, exception: 'default' }).source).toBe('role_default');
    expect(orderCatalogAccessPreview({ ...base, exception: 'allow' }).source).toBe('allowed_by_stockpilot');
    expect(orderCatalogAccessPreview({ ...base, exception: 'deny' }).source).toBe('denied_by_stockpilot');
    expect(orderCatalogAccessSourceCopy('role_default')).toBe('Role default');
    expect(orderCatalogAccessSourceCopy('allowed_by_stockpilot')).toBe('Allowed by StockPilot');
    expect(orderCatalogAccessSourceCopy('denied_by_stockpilot')).toBe('Denied by StockPilot');
    expect(orderCatalogAccessChipCopy(true)).toBe('Allowed');
    expect(orderCatalogAccessChipCopy(false)).toBe('Not allowed');
  });

  it('says the result before saving', () => {
    const after = (i: Partial<OrderCatalogAccessPreviewInput>) =>
      orderCatalogAccessAfterSavingCopy(orderCatalogAccessPreview({ ...base, ...i }));
    expect(after({ role: 'manager', exception: 'deny' })).toBe(
      'After saving: Not allowed (denied by StockPilot). This stays until StockPilot changes it, even if their role changes.',
    );
    expect(after({ role: 'staff', exception: 'allow' })).toBe(
      'After saving: Allowed (allowed by StockPilot). This stays until StockPilot changes it, even if their role changes.',
    );
    expect(after({ role: 'manager', exception: 'default' })).toBe('After saving: Allowed (role default).');
    expect(after({ role: 'viewer', exception: 'default' })).toBe('After saving: Not allowed (role default).');
    expect(after({ role: 'staff', exception: 'allow', disabled: true })).toBe(
      'After saving: Not allowed (their account is disabled). This stays until StockPilot changes it, even if their role changes.',
    );
    expect(after({ role: 'manager', exception: 'default', ordersModuleEnabled: false })).toBe(
      'After saving: Not allowed (the Orders module is off).',
    );
  });

  it('explains only what applies', () => {
    expect(ORDER_ITEMS_ACCESS_ROLE_DEFAULT_COPY).toBe(
      'Managers, admins and owners have this by default. Staff and viewers do not.',
    );
    expect(ORDER_ITEMS_ACCESS_STATE_LABELS).toEqual({
      default: 'Follow role default',
      allow: 'Allow',
      deny: 'Deny',
    });
    const explain = (i: Partial<OrderCatalogAccessPreviewInput>) => {
      const input = { ...base, ...i };
      return orderCatalogAccessExplanations(orderCatalogAccessPreview(input), input);
    };
    expect(explain({ role: 'manager', exception: 'default' })).toEqual([ORDER_ITEMS_ACCESS_MANAGER_NEEDS_DENY_COPY]);
    expect(explain({ role: 'manager', exception: 'deny' })).toEqual([
      ORDER_ITEMS_ACCESS_MANAGER_NEEDS_DENY_COPY,
      ORDER_ITEMS_ACCESS_KEPT_ON_REINVITE_COPY,
    ]);
    expect(explain({ role: 'staff', exception: 'allow', canRequestOrders: false })).toEqual([
      ORDER_ITEMS_ACCESS_ALLOW_SCOPE_COPY,
      ORDER_ITEMS_ACCESS_PHONE_ENTRY_COPY,
      ORDER_ITEMS_ACCESS_KEPT_ON_REINVITE_COPY,
    ]);
    expect(explain({ role: 'staff', exception: 'default' })).toEqual([]);
    expect(explain({ role: 'staff', exception: 'allow', disabled: true, ordersModuleEnabled: false })).toEqual([
      ORDER_ITEMS_ACCESS_DISABLED_COPY,
      ORDER_ITEMS_ACCESS_MODULE_OFF_COPY,
      ORDER_ITEMS_ACCESS_ALLOW_SCOPE_COPY,
      ORDER_ITEMS_ACCESS_KEPT_ON_REINVITE_COPY,
    ]);
    expect(ORDER_ITEMS_ACCESS_MANAGER_NEEDS_DENY_COPY).toBe(
      'A manager, admin or owner needs Deny to lose their default access; Reset returns them to it.',
    );
    expect(ORDER_ITEMS_ACCESS_ALLOW_SCOPE_COPY).toBe(
      'Allow gives only this capability. They still need access to the warehouses and categories they will manage; it does not grant stock edits, order approval or permission to give this to others.',
    );
    expect(ORDER_ITEMS_ACCESS_MODULE_OFF_COPY).toBe(
      'The Orders module is off for this organization, so nobody can manage order items until it is turned on.',
    );
    expect(ORDER_ITEMS_ACCESS_PHONE_ENTRY_COPY).toBe(
      "They can't place orders, so on the phone they open Manage order items from the Orders list, not from Place an Order.",
    );
    expect(ORDER_ITEMS_ACCESS_KEPT_ON_REINVITE_COPY).toBe(
      'This choice stays if they are removed from the organization and invited again.',
    );
    expect(ORDER_ITEMS_ACCESS_DISABLED_COPY).toBe(
      'Their account is disabled, so they have no access until it is re-enabled.',
    );
  });

  it('a lost compare-and-set is a stale row, never "not authorized"', () => {
    expect(ORDER_ITEMS_ACCESS_CHANGED_COPY).toBe(
      "This member's order items access changed while you were working. Reload the page and try again.",
    );
    expect(ORDER_ITEMS_ACCESS_CHANGED_COPY).not.toMatch(/authori[sz]ed|permission/i);
  });

  it('the console save refusals: busy, invalid and failed, none of them "not authorized"', () => {
    expect(ORDER_ITEMS_ACCESS_BUSY_COPY).toBe(
      "Another change to this member's order items access is still saving. Try again in a moment.",
    );
    expect(ORDER_ITEMS_ACCESS_INVALID_COPY).toBe("That change couldn't be sent. Reload the page and try again.");
    expect(ORDER_ITEMS_ACCESS_SAVE_FAILED_COPY).toBe(
      "Order items access couldn't be saved. Reload the page to see what it is now, then try again.",
    );
    for (const copy of [ORDER_ITEMS_ACCESS_BUSY_COPY, ORDER_ITEMS_ACCESS_INVALID_COPY, ORDER_ITEMS_ACCESS_SAVE_FAILED_COPY]) {
      expect(copy).not.toMatch(/authori[sz]ed/i);
    }
  });

  it('the two audit labels stay apart', () => {
    expect(ORDER_VISIBILITY_AUDIT_LABEL).toBe('Ordering visibility changed');
    expect(ORDER_ITEMS_ACCESS_AUDIT_LABEL).toBe('Order items access changed');
  });
});

describe('importing catalog-visibility.ts runs nothing (Metro evaluates core on start-up)', () => {
  it('has no call, new or tagged template at its top level, and core exports it', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = path.join(here, 'catalog-visibility.ts');
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
      if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n)) {
        found.push(n.getText(sf).slice(0, 60));
        return;
      }
      ts.forEachChild(n, visit);
    };
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) continue;
      visit(st);
    }
    expect(found).toEqual([]);
    const index = readFileSync(path.join(here, '../index.ts'), 'utf8');
    expect(index).toContain("export * from './orders/catalog-visibility';");
  });
});
