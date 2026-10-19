import { describe, expect, it } from 'vitest';
import { resolveSurface, SECTION_ORDER } from './resolve';
import type { Role } from '../constants/roles';
import {
  DEFAULT_MODULE_IDS,
  MODULE_REGISTRY,
  modulesForPack,
  type DomainPack,
  type ModuleId,
  type NavSectionKey,
} from './registry';

const ALL = new Set(DEFAULT_MODULE_IDS);

describe('SECTION_ORDER', () => {
  it('covers every section used by any registry placement', () => {
    const used = new Set<string>();
    for (const def of Object.values(MODULE_REGISTRY))
      for (const p of def.placements) used.add(p.section);
    for (const s of used) expect(SECTION_ORDER).toContain(s);
  });

  // OWNER DECISION 2026-10-19: the sidebar and the phone drawer group their
  // links like the Claude design. The old keys keep their meaning (saved nav
  // orders, custom links and folded sections name them); the three new ones
  // sit between Inventory and Workspace, where their links were drawn.
  it('is exactly Overview, Inventory, Fulfillment, Purchasing, Insights, Workspace, Tools, Admin', () => {
    expect(SECTION_ORDER).toEqual([
      'overview',
      'inventory',
      'fulfillment',
      'purchasing',
      'insights',
      'workspace',
      'tools',
      'admin',
    ]);
  });
});

describe('resolveSurface', () => {
  it('admin sees the web sidebar including admin items', () => {
    const out = resolveSurface('web_sidebar', { role: 'admin', enabledModules: ALL });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/dashboard/inventory');
    expect(hrefs).toContain('/dashboard/admin');
  });
  it('staff does NOT see admin items', () => {
    const out = resolveSurface('web_sidebar', { role: 'staff', enabledModules: ALL });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs.some((h) => h.startsWith('/dashboard/admin'))).toBe(false);
  });
  it('effective permissions gate `requires` links (revoked purchase_orders:read hides the PO link)', () => {
    // A viewer normally has purchase_orders:read → sees the PO link…
    const withRead = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: ALL,
      permissions: new Set(['items:read', 'purchase_orders:read']),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(withRead).toContain('/dashboard/purchase-orders');

    // …revoke it via the effective set and the link disappears, even though the
    // static viewer role would include it.
    const withoutRead = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: ALL,
      permissions: new Set(['items:read']),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(withoutRead).not.toContain('/dashboard/purchase-orders');
  });
  it('read-permission grants surface the five auditor-readable modules for a viewer', () => {
    // Default viewer: none of the five read perms → none of the surfaces.
    const without = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: ALL,
      permissions: new Set(['items:read']),
    }).flatMap((s) => s.items.map((i) => i.href));
    for (const href of [
      '/dashboard/cycle-counts',
      '/dashboard/schedule',
      '/dashboard/bundles',
      '/dashboard/rentals',
      '/dashboard/audit',
    ])
      expect(without).not.toContain(href);

    // Grant the read perms (Auditor preset shape) → every surface appears,
    // WITHOUT any write permission and without being an admin.
    const withReads = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: ALL,
      permissions: new Set([
        'items:read',
        'cycle_counts:read',
        'schedule:read',
        'bundles:read',
        'rentals:read',
        'activity_logs:read',
      ]),
    }).flatMap((s) => s.items.map((i) => i.href));
    for (const href of [
      '/dashboard/cycle-counts',
      '/dashboard/schedule',
      '/dashboard/bundles',
      '/dashboard/rentals',
      '/dashboard/audit',
    ])
      expect(withReads).toContain(href);
  });
  it('returns placement gates on returns:read (module on, web only)', () => {
    const withReturns = new Set<ModuleId>([...ALL, 'returns']);
    const granted = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: withReturns,
      permissions: new Set(['returns:read']),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(granted).toContain('/dashboard/returns');
    const ungranted = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: withReturns,
      permissions: new Set(['items:read']),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(ungranted).not.toContain('/dashboard/returns');
  });
  it('mobile audit drawer item is permission-gated, not admin-gated', () => {
    const granted = resolveSurface('mobile_drawer', {
      role: 'viewer',
      enabledModules: ALL,
      permissions: new Set(['activity_logs:read']),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(granted).toContain('/admin/audit');
    // …but the rest of the admin section stays requiresAdmin-only.
    expect(granted).not.toContain('/admin');
    expect(granted).not.toContain('/admin/users');
  });
  it('disabling an optional module removes its items (core stays)', () => {
    const without = new Set([...ALL].filter((m) => m !== 'rentals'));
    const out = resolveSurface('web_sidebar', { role: 'admin', enabledModules: without });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).not.toContain('/dashboard/rentals');
    expect(hrefs).toContain('/dashboard/inventory');
  });
  it('a core module renders even if absent from enabledModules', () => {
    const out = resolveSurface('web_sidebar', { role: 'admin', enabledModules: new Set() });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/dashboard');
  });
  it('drops empty sections and sorts by defaultSortOrder', () => {
    const out = resolveSurface('web_sidebar', { role: 'admin', enabledModules: ALL });
    expect(out.every((s) => s.items.length > 0)).toBe(true);
    for (const s of out) {
      const orders = s.items.map((i) => i.sortOrder);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
    }
  });
  it('mobile_drawer resolves too (parity)', () => {
    const out = resolveSurface('mobile_drawer', { role: 'admin', enabledModules: ALL });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/inventory');
    expect(hrefs).toContain('/scan');
  });
});

// Frozen nav guards: pin the EXACT sections and ordered links an admin with
// the full charter module set sees on each surface. They began as the
// original static nav (web BASE_NAV+ADMIN_NAV / mobile DRAWER_SECTIONS); any
// sortOrder or section drift fails here instead of silently reordering nav.
//
// Updated knowingly for the OWNER DECISION of 2026-10-19 (sidebar
// sub-categories, as in the Claude design): Fulfillment, Purchasing and
// Insights split out of Inventory and Workspace. No link was added or removed
// (the last test below proves it against the lists as they were).
//
// Updated again for the owner-approved preview order 2026-10-19: the owner
// approved the "Five groups" preview, which also orders the links inside
// Inventory, Fulfillment, Insights and Workspace (pinned link for link in
// 'the owner-approved preview order' below). Overview, Purchasing, Tools and
// Admin keep the order their links had.
describe('nav order is frozen', () => {
  const sectionsOf = (surface: 'web_sidebar' | 'mobile_drawer') =>
    resolveSurface(surface, { role: 'admin', enabledModules: ALL }).map(
      (s) => [s.section, s.items.map((i) => i.href)] as const,
    );

  it('web_sidebar (admin, full set): every section and its links, in order', () => {
    expect(sectionsOf('web_sidebar')).toEqual([
      ['overview', ['/dashboard']],
      [
        'inventory',
        [
          // Owner-approved preview order 2026-10-19 (the default modules have
          // no Product groups, which would sit after Books).
          '/dashboard/inventory',
          '/dashboard/books',
          '/dashboard/inventory/staging',
          // Exceptions follows Staging: the Exception Center is an
          // inventory-oversight surface.
          '/dashboard/exceptions',
          '/dashboard/cycle-counts',
          '/dashboard/movements',
          '/dashboard/locations',
          '/dashboard/categories',
          '/dashboard/tags',
          '/dashboard/procedures',
        ],
      ],
      // Owner-approved preview order 2026-10-19 (Returns, off by default,
      // would sit after Orders).
      ['fulfillment', ['/dashboard/orders', '/dashboard/rentals', '/dashboard/bundles']],
      [
        'purchasing',
        [
          '/dashboard/purchase-orders',
          '/dashboard/purchase-orders/recurring',
          '/dashboard/purchase-orders/imports',
          '/dashboard/suppliers',
        ],
      ],
      // Owner-approved preview order 2026-10-19: Briefing above AI Assistant.
      ['insights', ['/dashboard/reports', '/dashboard/insights', '/dashboard/ai']],
      [
        'workspace',
        [
          // Accounts, off by default, would sit between Team and Support.
          '/dashboard/schedule',
          '/dashboard/notifications',
          '/dashboard/team',
          '/dashboard/support',
          '/dashboard/settings',
        ],
      ],
      [
        'admin',
        [
          '/dashboard/admin',
          '/dashboard/admin/charters',
          '/dashboard/admin/warehouses',
          '/dashboard/admin/bins',
          '/dashboard/admin/users',
          '/dashboard/admin/vendor-mappings',
          '/dashboard/admin/uom-conversions',
          '/dashboard/admin/reconciliation',
          // Audit log moved to the grantable non-admin route (auditor
          // visibility); same position in the Admin section.
          '/dashboard/audit',
        ],
      ],
    ]);
  });

  it('mobile_drawer (admin, full set): every section and its links, in order', () => {
    expect(sectionsOf('mobile_drawer')).toEqual([
      ['overview', ['/']],
      [
        'inventory',
        [
          // Staging and Exceptions gained native twins (put-away is done on
          // foot; F1-1), placed where the web sidebar puts them: after Books,
          // in the owner-approved preview order 2026-10-19.
          '/inventory',
          '/books',
          '/staging',
          '/exceptions',
          '/cycle-counts',
          '/movements',
          '/locations',
          '/categories',
          '/tags',
          '/procedures',
        ],
      ],
      // Owner-approved preview order 2026-10-19.
      ['fulfillment', ['/orders', '/rentals', '/bundles']],
      // Receive POs (105) leads Purchasing, just above Purchase orders, as it
      // did in the old Inventory section.
      [
        'purchasing',
        ['/receive', '/purchase-orders', '/recurring-pos', '/po-imports', '/suppliers'],
      ],
      ['insights', ['/reports', '/ai']],
      ['workspace', ['/schedule', '/notifications', '/team', '/settings']],
      ['tools', ['/scan']],
      [
        'admin',
        [
          '/admin',
          '/admin/charters',
          '/admin/warehouses',
          '/admin/bins',
          '/admin/users',
          '/admin/vendor-mappings',
          '/admin/uom-conversions',
          '/admin/audit',
        ],
      ],
    ]);
  });

  // The frozen lists as they stood before the regroup, one flat run of links.
  const BEFORE_REGROUP = {
    web_sidebar: [
      '/dashboard',
      '/dashboard/inventory',
      '/dashboard/inventory/staging',
      '/dashboard/exceptions',
      '/dashboard/books',
      '/dashboard/categories',
      '/dashboard/tags',
      '/dashboard/movements',
      '/dashboard/rentals',
      '/dashboard/bundles',
      '/dashboard/orders',
      '/dashboard/cycle-counts',
      '/dashboard/procedures',
      '/dashboard/purchase-orders',
      '/dashboard/purchase-orders/recurring',
      '/dashboard/purchase-orders/imports',
      '/dashboard/locations',
      '/dashboard/suppliers',
      '/dashboard/reports',
      '/dashboard/ai',
      '/dashboard/insights',
      '/dashboard/schedule',
      '/dashboard/notifications',
      '/dashboard/team',
      '/dashboard/support',
      '/dashboard/settings',
      '/dashboard/admin',
      '/dashboard/admin/charters',
      '/dashboard/admin/warehouses',
      '/dashboard/admin/bins',
      '/dashboard/admin/users',
      '/dashboard/admin/vendor-mappings',
      '/dashboard/admin/uom-conversions',
      '/dashboard/admin/reconciliation',
      '/dashboard/audit',
    ],
    mobile_drawer: [
      '/',
      '/inventory',
      '/staging',
      '/exceptions',
      '/books',
      '/categories',
      '/tags',
      '/movements',
      '/rentals',
      '/bundles',
      '/orders',
      '/cycle-counts',
      '/procedures',
      '/receive',
      '/purchase-orders',
      '/recurring-pos',
      '/po-imports',
      '/locations',
      '/suppliers',
      '/reports',
      '/ai',
      '/schedule',
      '/notifications',
      '/team',
      '/settings',
      '/scan',
      '/admin',
      '/admin/charters',
      '/admin/warehouses',
      '/admin/bins',
      '/admin/users',
      '/admin/vendor-mappings',
      '/admin/uom-conversions',
      '/admin/audit',
    ],
  } as const;

  // Owner-approved preview order 2026-10-19: this asserted that every section
  // kept the order its links had. Inventory, Fulfillment, Insights and
  // Workspace now follow the preview instead, so only the sections it left
  // alone are held to the old order here.
  it.each(['web_sidebar', 'mobile_drawer'] as const)(
    '%s: every link is kept, and Overview, Purchasing, Tools and Admin keep the order their links had',
    (surface) => {
      const before: readonly string[] = BEFORE_REGROUP[surface];
      const sections = sectionsOf(surface);
      expect(sections.flatMap(([, hrefs]) => hrefs).sort()).toEqual([...before].sort());
      const unchanged = sections.filter(([section]) =>
        ['overview', 'purchasing', 'tools', 'admin'].includes(section),
      );
      expect(unchanged.length).toBe(surface === 'web_sidebar' ? 3 : 4);
      for (const [section, hrefs] of unchanged) {
        const places = hrefs.map((href) => before.indexOf(href));
        expect(places, section).toEqual([...places].sort((a, b) => a - b));
      }
    },
  );
});

describe('requiresAnyOf (read-or-write nav fallback)', () => {
  it('shows a surface when the caller holds ONLY the paired write permission', () => {
    // An org can grant a role e.g. schedule:manage via the matrix without the
    // schedule:read default (viewer). The nav must not hide the surface from
    // someone who can WRITE to it.
    const sections = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: ALL,
      permissions: new Set(['schedule:manage']),
    });
    const hrefs = sections.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/dashboard/schedule');
  });

  it('shows a surface for a read-only grantee and hides it with neither perm', () => {
    const withRead = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: ALL,
      permissions: new Set(['cycle_counts:read']),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(withRead).toContain('/dashboard/cycle-counts');

    const withNeither = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: ALL,
      permissions: new Set([]),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(withNeither).not.toContain('/dashboard/cycle-counts');
    expect(withNeither).not.toContain('/dashboard/bundles');
    expect(withNeither).not.toContain('/dashboard/rentals');
    expect(withNeither).not.toContain('/dashboard/returns');
    expect(withNeither).not.toContain('/dashboard/schedule');
  });
});

/**
 * OWNER DECISION 2026-10-19 (sidebar sub-categories): who sees which section,
 * and which links sit in it, for every role. Every module on first (every
 * section a role can hold), then with modules off, where a section left empty
 * is dropped rather than drawn as a bare heading.
 *
 * The lists are in the owner-approved preview order 2026-10-19 (they held the
 * order the links had before the regroup until then).
 */
describe('sections per role after the regroup', () => {
  const EVERY_MODULE = new Set(Object.keys(MODULE_REGISTRY) as ModuleId[]);
  const ROLES: Role[] = ['owner', 'admin', 'manager', 'staff', 'viewer'];
  type Grouping = Array<[NavSectionKey, string[]]>;

  const grouping = (
    surface: 'web_sidebar' | 'mobile_drawer',
    role: Role,
    enabledModules: Set<ModuleId>,
  ): Grouping =>
    resolveSurface(surface, { role, enabledModules }).map((s) => [
      s.section,
      s.items.map((i) => i.label),
    ]);

  const WEB_INVENTORY = [
    'Items',
    'Books',
    'Product groups',
    'Staging',
    'Exceptions',
    'Cycle counts',
    'Movements',
    'Locations',
    'Categories',
    'Tags',
    'Procedures',
  ];
  const WEB_FULFILLMENT = ['Orders', 'Returns', 'Rentals', 'Bundles'];
  const WEB_PURCHASING = [
    'Purchase orders',
    'Recurring POs',
    'Reorder Planning',
    'PO imports',
    'Suppliers',
  ];
  const WEB_INSIGHTS = ['Reports', 'Briefing', 'AI Assistant'];
  const WEB_ADMIN = [
    'Admin overview',
    'Charters',
    'Warehouses',
    'Bins',
    'Users',
    'Vendor mappings',
    'UoM conversions',
    'Reconciliation',
    'Audit log',
  ];
  const WEB_OWNER: Grouping = [
    ['overview', ['Overview']],
    ['inventory', WEB_INVENTORY],
    ['fulfillment', WEB_FULFILLMENT],
    ['purchasing', WEB_PURCHASING],
    ['insights', WEB_INSIGHTS],
    [
      'workspace',
      [
        'Schedule',
        'Notifications',
        'Team',
        'Accounts',
        'Support',
        'Settings',
        'Maintenance',
        'Zendesk',
      ],
    ],
    ['admin', WEB_ADMIN],
  ];

  it.each<[Role, Grouping]>([
    ['owner', WEB_OWNER],
    ['admin', WEB_OWNER],
    [
      'manager',
      [
        ['overview', ['Overview']],
        ['inventory', WEB_INVENTORY],
        ['fulfillment', WEB_FULFILLMENT],
        ['purchasing', WEB_PURCHASING],
        ['insights', WEB_INSIGHTS],
        [
          'workspace',
          [
            'Schedule',
            'Notifications',
            'Accounts',
            'Support',
            'Settings',
            'Maintenance',
            'Zendesk',
          ],
        ],
        ['admin', ['Audit log']],
      ],
    ],
    [
      'staff',
      [
        ['overview', ['Overview']],
        [
          'inventory',
          [
            'Items',
            'Books',
            'Staging',
            'Exceptions',
            'Cycle counts',
            'Locations',
            'Categories',
            'Tags',
            'Procedures',
          ],
        ],
        ['fulfillment', ['Orders', 'Rentals', 'Bundles']],
        ['purchasing', ['Purchase orders', 'Suppliers']],
        ['insights', WEB_INSIGHTS],
        ['workspace', ['Notifications', 'Support', 'Settings', 'Maintenance', 'Zendesk']],
      ],
    ],
    [
      // No Insights: a viewer holds neither reports:read nor items:update.
      'viewer',
      [
        ['overview', ['Overview']],
        ['inventory', ['Items', 'Books', 'Staging', 'Exceptions', 'Locations', 'Categories']],
        ['fulfillment', ['Orders']],
        ['purchasing', ['Purchase orders', 'Suppliers']],
        ['workspace', ['Notifications', 'Support', 'Settings', 'Maintenance', 'Zendesk']],
      ],
    ],
  ])('web sidebar, %s, every module on', (role, expected) => {
    expect(grouping('web_sidebar', role, EVERY_MODULE)).toEqual(expected);
  });

  const PHONE_INVENTORY = [
    'Items',
    'Books',
    'Staging',
    'Exceptions',
    'Cycle counts',
    'Movements',
    'Locations',
    'Categories',
    'Tags',
    'Procedures',
  ];
  const PHONE_PURCHASING = [
    'Receive POs',
    'Purchase orders',
    'Recurring POs',
    'PO imports',
    'Suppliers',
  ];
  const PHONE_OWNER: Grouping = [
    ['overview', ['Overview']],
    ['inventory', PHONE_INVENTORY],
    ['fulfillment', WEB_FULFILLMENT],
    ['purchasing', PHONE_PURCHASING],
    ['insights', ['Reports', 'AI Assistant']],
    [
      'workspace',
      ['Schedule', 'Notifications', 'Team', 'Accounts', 'Settings', 'Maintenance', 'Zendesk'],
    ],
    ['tools', ['Scan']],
    [
      'admin',
      [
        'Admin overview',
        'Charters',
        'Warehouses',
        'Bins',
        'Users',
        'Vendor mappings',
        'UoM conversions',
        'Audit log',
      ],
    ],
  ];

  it.each<[Role, Grouping]>([
    ['owner', PHONE_OWNER],
    ['admin', PHONE_OWNER],
    [
      'manager',
      [
        ['overview', ['Overview']],
        ['inventory', PHONE_INVENTORY],
        ['fulfillment', WEB_FULFILLMENT],
        ['purchasing', PHONE_PURCHASING],
        ['insights', ['Reports', 'AI Assistant']],
        [
          'workspace',
          ['Schedule', 'Notifications', 'Accounts', 'Settings', 'Maintenance', 'Zendesk'],
        ],
        ['tools', ['Scan']],
        ['admin', ['Audit log']],
      ],
    ],
    [
      'staff',
      [
        ['overview', ['Overview']],
        [
          'inventory',
          [
            'Items',
            'Books',
            'Staging',
            'Exceptions',
            'Cycle counts',
            'Locations',
            'Categories',
            'Tags',
            'Procedures',
          ],
        ],
        ['fulfillment', ['Orders', 'Rentals', 'Bundles']],
        ['purchasing', ['Receive POs', 'Purchase orders', 'Suppliers']],
        ['insights', ['Reports', 'AI Assistant']],
        ['workspace', ['Notifications', 'Settings', 'Maintenance', 'Zendesk']],
        ['tools', ['Scan']],
      ],
    ],
    [
      'viewer',
      [
        ['overview', ['Overview']],
        ['inventory', ['Items', 'Books', 'Staging', 'Exceptions', 'Locations', 'Categories']],
        ['fulfillment', ['Orders']],
        ['purchasing', ['Receive POs', 'Purchase orders', 'Suppliers']],
        ['workspace', ['Notifications', 'Settings', 'Maintenance', 'Zendesk']],
        ['tools', ['Scan']],
      ],
    ],
  ])('phone drawer, %s, every module on', (role, expected) => {
    expect(grouping('mobile_drawer', role, EVERY_MODULE)).toEqual(expected);
  });

  // Only the core modules: nothing for Fulfillment or Purchasing to hold, so
  // neither is drawn; Insights keeps Reports (a core module) for the roles
  // that read reports.
  it.each<[Role, NavSectionKey[], NavSectionKey[]]>([
    [
      'owner',
      ['overview', 'inventory', 'insights', 'workspace', 'admin'],
      ['overview', 'inventory', 'insights', 'workspace', 'tools', 'admin'],
    ],
    [
      'admin',
      ['overview', 'inventory', 'insights', 'workspace', 'admin'],
      ['overview', 'inventory', 'insights', 'workspace', 'tools', 'admin'],
    ],
    [
      'manager',
      ['overview', 'inventory', 'insights', 'workspace', 'admin'],
      ['overview', 'inventory', 'insights', 'workspace', 'tools', 'admin'],
    ],
    [
      'staff',
      ['overview', 'inventory', 'insights', 'workspace'],
      ['overview', 'inventory', 'insights', 'workspace', 'tools'],
    ],
    [
      'viewer',
      ['overview', 'inventory', 'workspace'],
      ['overview', 'inventory', 'workspace', 'tools'],
    ],
  ])('%s with only the core modules: the empty sections are dropped', (role, web, phone) => {
    const core = new Set<ModuleId>();
    const webSections = grouping('web_sidebar', role, core);
    const phoneSections = grouping('mobile_drawer', role, core);
    expect(webSections.map(([key]) => key)).toEqual(web);
    expect(phoneSections.map(([key]) => key)).toEqual(phone);
    for (const sections of [webSections, phoneSections]) {
      for (const [, labels] of sections) expect(labels.length).toBeGreaterThan(0);
      const insights = sections.find(([key]) => key === 'insights');
      if (insights) expect(insights[1]).toEqual(['Reports']);
    }
  });

  it.each<[string, ModuleId[], NavSectionKey]>([
    [
      'Orders, Returns, Rentals and Bundles',
      ['orders', 'returns', 'rentals', 'bundles'],
      'fulfillment',
    ],
    [
      'the purchase order modules',
      ['purchase_orders', 'receiving', 'po_imports', 'suppliers', 'planning'],
      'purchasing',
    ],
  ])('every role, every module on but %s: no %s section', (_name, off, section) => {
    const modules = new Set([...EVERY_MODULE].filter((m) => !off.includes(m)));
    for (const role of ROLES) {
      for (const surface of ['web_sidebar', 'mobile_drawer'] as const) {
        const sections = grouping(surface, role, modules);
        expect(
          sections.map(([key]) => key),
          `${surface} ${role}`,
        ).not.toContain(section);
        expect(
          sections.map(([key]) => key),
          `${surface} ${role}`,
        ).toContain('inventory');
      }
    }
  });

  it('every role, every module on but AI: Insights holds Reports alone (none for a viewer)', () => {
    const modules = new Set([...EVERY_MODULE].filter((m) => m !== 'ai'));
    for (const role of ROLES) {
      for (const surface of ['web_sidebar', 'mobile_drawer'] as const) {
        const insights = grouping(surface, role, modules).find(([key]) => key === 'insights');
        expect(insights?.[1], `${surface} ${role}`).toEqual(
          role === 'viewer' ? undefined : ['Reports'],
        );
      }
    }
  });
});

/**
 * OWNER DECISION 2026-10-19: the owner approved the "Five groups" sidebar
 * preview, which lists the links inside each group in this order. With no
 * order saved by the org, the web sidebar draws exactly these, and the phone
 * drawer draws the ones it has in the same order, with its own Receive POs
 * first in Purchasing and Scan alone in Tools. Overview and Admin are as they
 * were. (An org's saved order still wins: customization/index.test.ts.)
 */
describe('the owner-approved preview order (2026-10-19)', () => {
  const PREVIEW: Record<NavSectionKey, string[]> = {
    overview: ['Overview'],
    inventory: [
      'Items',
      'Books',
      'Product groups',
      'Staging',
      'Exceptions',
      'Cycle counts',
      'Movements',
      'Locations',
      'Categories',
      'Tags',
      'Procedures',
    ],
    fulfillment: ['Orders', 'Returns', 'Rentals', 'Bundles'],
    purchasing: ['Purchase orders', 'Recurring POs', 'Reorder Planning', 'PO imports', 'Suppliers'],
    insights: ['Reports', 'Briefing', 'AI Assistant'],
    workspace: [
      'Schedule',
      'Notifications',
      'Team',
      'Accounts',
      'Support',
      'Settings',
      'Maintenance',
      'Zendesk',
    ],
    tools: [],
    admin: [
      'Admin overview',
      'Charters',
      'Warehouses',
      'Bins',
      'Users',
      'Vendor mappings',
      'UoM conversions',
      'Reconciliation',
      'Audit log',
    ],
  };
  // The phone has no Product groups, Reorder Planning, Briefing, Support or
  // Reconciliation link; Receive POs and Scan are its own.
  const PHONE: Record<NavSectionKey, string[]> = {
    overview: ['Overview'],
    inventory: [
      'Items',
      'Books',
      'Staging',
      'Exceptions',
      'Cycle counts',
      'Movements',
      'Locations',
      'Categories',
      'Tags',
      'Procedures',
    ],
    fulfillment: ['Orders', 'Returns', 'Rentals', 'Bundles'],
    purchasing: ['Receive POs', 'Purchase orders', 'Recurring POs', 'PO imports', 'Suppliers'],
    insights: ['Reports', 'AI Assistant'],
    workspace: [
      'Schedule',
      'Notifications',
      'Team',
      'Accounts',
      'Settings',
      'Maintenance',
      'Zendesk',
    ],
    tools: ['Scan'],
    admin: [
      'Admin overview',
      'Charters',
      'Warehouses',
      'Bins',
      'Users',
      'Vendor mappings',
      'UoM conversions',
      'Audit log',
    ],
  };
  const PHONE_ONLY = ['Receive POs', 'Scan'];

  type Surface = 'web_sidebar' | 'mobile_drawer';
  const SURFACES: Surface[] = ['web_sidebar', 'mobile_drawer'];
  const ROLES: Role[] = ['owner', 'admin', 'manager', 'staff', 'viewer'];
  const EVERY_MODULE = new Set(Object.keys(MODULE_REGISTRY) as ModuleId[]);
  const PACKS: DomainPack[] = [
    'charter_school',
    'distribution',
    'agriculture_food',
    'retail_backroom',
    'light_3pl',
  ];
  const MODULE_SETS: Array<[string, Set<ModuleId>]> = [
    ['every module', EVERY_MODULE],
    ['the default modules', new Set(DEFAULT_MODULE_IDS)],
    ['only the core modules', new Set<ModuleId>()],
    ...PACKS.map((pack): [string, Set<ModuleId>] => [
      `the ${pack} pack`,
      new Set(modulesForPack(pack)),
    ]),
  ];

  const previewOf = (surface: Surface) => (surface === 'web_sidebar' ? PREVIEW : PHONE);
  const drawn = (surface: Surface, role: Role, enabledModules: Set<ModuleId>) =>
    resolveSurface(surface, { role, enabledModules }).map((s): [NavSectionKey, string[]] => [
      s.section,
      s.items.map((i) => i.label),
    ]);

  it.each(SURFACES)(
    '%s, admin, every module on: every section is the preview, link for link',
    (surface) => {
      const preview = previewOf(surface);
      expect(drawn(surface, 'admin', EVERY_MODULE)).toEqual(
        SECTION_ORDER.filter((s) => preview[s].length > 0).map((s) => [s, preview[s]]),
      );
    },
  );

  // A role that sees fewer links sees the preview's own order with the links
  // it cannot open left out. Which links each role sees is pinned link for
  // link in 'sections per role after the regroup' above.
  it.each(
    (['manager', 'staff', 'viewer'] as const).flatMap((role) =>
      SURFACES.map((surface): [Role, Surface] => [role, surface]),
    ),
  )('%s, %s, every module on: every section keeps the preview order', (role, surface) => {
    const preview = previewOf(surface);
    const sections = drawn(surface, role, EVERY_MODULE);
    expect(sections.length).toBeGreaterThan(3);
    for (const [section, labels] of sections) {
      expect(labels, section).toEqual(preview[section].filter((l) => labels.includes(l)));
    }
  });

  it('every role and module set draws each section in the preview order', () => {
    for (const [name, modules] of MODULE_SETS) {
      for (const role of ROLES) {
        for (const surface of SURFACES) {
          const preview = previewOf(surface);
          for (const [section, labels] of drawn(surface, role, modules)) {
            expect(labels, `${name}, ${role}, ${surface}, ${section}`).toEqual(
              preview[section].filter((l) => labels.includes(l)),
            );
          }
        }
      }
    }
  });

  it('the phone keeps the web preview order for every link the two share', () => {
    for (const section of SECTION_ORDER) {
      const shared = PHONE[section].filter((label) => !PHONE_ONLY.includes(label));
      expect(shared, section).toEqual(PREVIEW[section].filter((l) => shared.includes(l)));
    }
  });

  // Where the phone's own links land: Receive POs keeps its place at the top
  // of Purchasing, above Purchase orders, and Scan stays alone in Tools.
  it.each(ROLES)(
    'phone drawer, %s, every module on: Receive POs leads Purchasing, Scan is Tools',
    (role) => {
      const sections = new Map(drawn('mobile_drawer', role, EVERY_MODULE));
      expect(sections.get('purchasing')?.[0]).toBe('Receive POs');
      expect(sections.get('tools')).toEqual(['Scan']);
    },
  );
});
