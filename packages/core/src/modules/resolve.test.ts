import { describe, expect, it } from 'vitest';
import { resolveSurface, SECTION_ORDER } from './resolve';
import type { Role } from '../constants/roles';
import { DEFAULT_MODULE_IDS, MODULE_REGISTRY, type ModuleId, type NavSectionKey } from './registry';

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
// Insights split out of Inventory and Workspace. No link was added or removed,
// and every section keeps the relative order its links had before (the last
// test below proves it against the lists as they were): Reports, which ended
// Inventory, still sits above AI Assistant and Briefing, which began Workspace.
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
          '/dashboard/inventory',
          '/dashboard/inventory/staging',
          // Exceptions (sortOrder 7) lands between Staging (5) and Books (20):
          // the Exception Center is an inventory-oversight surface.
          '/dashboard/exceptions',
          '/dashboard/books',
          '/dashboard/categories',
          '/dashboard/tags',
          '/dashboard/movements',
          '/dashboard/cycle-counts',
          '/dashboard/procedures',
          '/dashboard/locations',
        ],
      ],
      ['fulfillment', ['/dashboard/rentals', '/dashboard/bundles', '/dashboard/orders']],
      [
        'purchasing',
        [
          '/dashboard/purchase-orders',
          '/dashboard/purchase-orders/recurring',
          '/dashboard/purchase-orders/imports',
          '/dashboard/suppliers',
        ],
      ],
      ['insights', ['/dashboard/reports', '/dashboard/ai', '/dashboard/insights']],
      [
        'workspace',
        [
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
          // foot; F1-1), placed where the web sidebar puts them: right after
          // Items, at sortOrder 5 and 7.
          '/inventory',
          '/staging',
          '/exceptions',
          '/books',
          '/categories',
          '/tags',
          '/movements',
          '/cycle-counts',
          '/procedures',
          '/locations',
        ],
      ],
      ['fulfillment', ['/rentals', '/bundles', '/orders']],
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

  it.each(['web_sidebar', 'mobile_drawer'] as const)(
    '%s: the regroup kept every link, and each section keeps the order its links had',
    (surface) => {
      const before: readonly string[] = BEFORE_REGROUP[surface];
      const sections = sectionsOf(surface);
      expect(sections.flatMap(([, hrefs]) => hrefs).sort()).toEqual([...before].sort());
      for (const [section, hrefs] of sections) {
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
    'Staging',
    'Exceptions',
    'Books',
    'Product groups',
    'Categories',
    'Tags',
    'Movements',
    'Cycle counts',
    'Procedures',
    'Locations',
  ];
  const WEB_FULFILLMENT = ['Rentals', 'Bundles', 'Orders', 'Returns'];
  const WEB_PURCHASING = [
    'Purchase orders',
    'Recurring POs',
    'Reorder Planning',
    'PO imports',
    'Suppliers',
  ];
  const WEB_INSIGHTS = ['Reports', 'AI Assistant', 'Briefing'];
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
        'Support',
        'Settings',
        'Accounts',
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
            'Support',
            'Settings',
            'Accounts',
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
            'Staging',
            'Exceptions',
            'Books',
            'Categories',
            'Tags',
            'Cycle counts',
            'Procedures',
            'Locations',
          ],
        ],
        ['fulfillment', ['Rentals', 'Bundles', 'Orders']],
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
        ['inventory', ['Items', 'Staging', 'Exceptions', 'Books', 'Categories', 'Locations']],
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
    'Staging',
    'Exceptions',
    'Books',
    'Categories',
    'Tags',
    'Movements',
    'Cycle counts',
    'Procedures',
    'Locations',
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
      ['Schedule', 'Notifications', 'Team', 'Settings', 'Accounts', 'Maintenance', 'Zendesk'],
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
          ['Schedule', 'Notifications', 'Settings', 'Accounts', 'Maintenance', 'Zendesk'],
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
            'Staging',
            'Exceptions',
            'Books',
            'Categories',
            'Tags',
            'Cycle counts',
            'Procedures',
            'Locations',
          ],
        ],
        ['fulfillment', ['Rentals', 'Bundles', 'Orders']],
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
        ['inventory', ['Items', 'Staging', 'Exceptions', 'Books', 'Categories', 'Locations']],
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
