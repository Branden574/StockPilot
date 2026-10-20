import { MODULE_REGISTRY, SECTION_ORDER, type ModuleId, type Role } from '@stockpilot/core';
import { describe, expect, it, vi } from 'vitest';

import { drawerSectionsFor } from './drawer-nav';

// drawer-nav maps icon names to lucide components; the icons are irrelevant
// here and the native package does not load under node. (vi.mock is hoisted
// above the imports.)
vi.mock('./nav-icons', () => ({ NAV_ICONS: new Proxy({}, { get: () => () => null }) }));

/**
 * THE PHONE DRAWER'S HEADERS after the owner's regroup of 2026-10-19 (sidebar
 * sub-categories): the same sections as the web sidebar, each under its
 * UPPERCASE header, Overview under none. The phone never applies an org's
 * saved nav order, so there is nothing to carry over here; it shows the new
 * headers once the phone takes the update.
 */
const EVERY_MODULE = new Set(Object.keys(MODULE_REGISTRY) as ModuleId[]);

const headersOf = (role: Role, modules: Set<ModuleId>) =>
  drawerSectionsFor(role, modules).map((s) => s.label);

const linksUnder = (role: Role, header: string) =>
  drawerSectionsFor(role, EVERY_MODULE)
    .find((s) => s.label === header)
    ?.items.map((i) => i.label);

describe('the phone drawer headers', () => {
  it.each<[Role, (string | undefined)[]]>([
    [
      'owner',
      [
        undefined,
        'INVENTORY',
        'FULFILLMENT',
        'PURCHASING',
        'INSIGHTS',
        'WORKSPACE',
        'TOOLS',
        'ADMIN',
      ],
    ],
    [
      'admin',
      [
        undefined,
        'INVENTORY',
        'FULFILLMENT',
        'PURCHASING',
        'INSIGHTS',
        'WORKSPACE',
        'TOOLS',
        'ADMIN',
      ],
    ],
    // A manager's ADMIN holds the Audit log alone.
    [
      'manager',
      [
        undefined,
        'INVENTORY',
        'FULFILLMENT',
        'PURCHASING',
        'INSIGHTS',
        'WORKSPACE',
        'TOOLS',
        'ADMIN',
      ],
    ],
    [
      'staff',
      [undefined, 'INVENTORY', 'FULFILLMENT', 'PURCHASING', 'INSIGHTS', 'WORKSPACE', 'TOOLS'],
    ],
    // A viewer reads no reports and uses no AI, so no INSIGHTS.
    ['viewer', [undefined, 'INVENTORY', 'FULFILLMENT', 'PURCHASING', 'WORKSPACE', 'TOOLS']],
  ])('%s, every module on: the headers, in order', (role, headers) => {
    expect(headersOf(role, EVERY_MODULE)).toEqual(headers);
  });

  // Owner-approved preview order 2026-10-19 (the links kept the order they had
  // in INVENTORY and WORKSPACE until then).
  it('the links under the three new headers (owner, every module on)', () => {
    expect(linksUnder('owner', 'FULFILLMENT')).toEqual(['Orders', 'Returns', 'Rentals', 'Bundles']);
    expect(linksUnder('owner', 'PURCHASING')).toEqual([
      'Receive POs',
      'Purchase orders',
      'Recurring POs',
      'PO imports',
      'Suppliers',
    ]);
    expect(linksUnder('owner', 'INSIGHTS')).toEqual(['Reports', 'AI Assistant']);
    expect(linksUnder('owner', 'INVENTORY')).toEqual([
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
    ]);
  });

  it.each<[Role, (string | undefined)[]]>([
    ['owner', [undefined, 'INVENTORY', 'INSIGHTS', 'WORKSPACE', 'TOOLS', 'ADMIN']],
    ['staff', [undefined, 'INVENTORY', 'INSIGHTS', 'WORKSPACE', 'TOOLS']],
    ['viewer', [undefined, 'INVENTORY', 'WORKSPACE', 'TOOLS']],
  ])(
    '%s with only the core modules: no empty FULFILLMENT or PURCHASING header',
    (role, headers) => {
      expect(headersOf(role, new Set())).toEqual(headers);
    },
  );

  it('every section an owner sees has a header, except Overview at the top', () => {
    // An owner with every module holds every drawer section, so a key added to
    // core without a header here would show up as a second unlabelled group.
    const sections = drawerSectionsFor('owner', EVERY_MODULE);
    expect(sections[0]!.label).toBeUndefined();
    expect(sections[0]!.items.map((i) => i.href)).toEqual(['/']);
    expect(sections.slice(1).map((s) => s.label?.length ?? 0)).not.toContain(0);
    // The phone has a link in every section the registry has.
    expect(sections).toHaveLength(SECTION_ORDER.length);
  });
});

/**
 * OWNER DECISION 2026-10-19: the owner approved the "Five groups" sidebar
 * preview, which lists the links inside each group in this order. The drawer
 * draws the preview's links the phone has in that order (it has no Product
 * groups, Reorder Planning, Briefing or Support link), each role leaving out
 * only the links it cannot open. The phone's own links keep their places:
 * Receive POs first in PURCHASING, above Purchase orders, and Scan alone in
 * TOOLS.
 */
describe('the drawer draws the owner-approved preview order', () => {
  /** Each header (none for Overview) with its links, top to bottom. */
  type Drawn = [string | undefined, string[]][];
  const sectionsOf = (role: Role): Drawn =>
    drawerSectionsFor(role, EVERY_MODULE).map((s) => [s.label, s.items.map((i) => i.label)]);

  const INVENTORY = [
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
  const FULFILLMENT = ['Orders', 'Returns', 'Rentals', 'Bundles'];
  const PURCHASING = ['Receive POs', 'Purchase orders', 'Recurring POs', 'PO imports', 'Suppliers'];

  it.each<[Role, Drawn]>([
    [
      'admin',
      [
        [undefined, ['Overview']],
        ['INVENTORY', INVENTORY],
        ['FULFILLMENT', FULFILLMENT],
        ['PURCHASING', PURCHASING],
        ['INSIGHTS', ['Reports', 'AI Assistant']],
        [
          'WORKSPACE',
          ['Schedule', 'Notifications', 'Team', 'Accounts', 'Settings', 'Maintenance', 'Zendesk'],
        ],
        ['TOOLS', ['Scan']],
        [
          'ADMIN',
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
      ],
    ],
    [
      'manager',
      [
        [undefined, ['Overview']],
        ['INVENTORY', INVENTORY],
        ['FULFILLMENT', FULFILLMENT],
        ['PURCHASING', PURCHASING],
        ['INSIGHTS', ['Reports', 'AI Assistant']],
        [
          'WORKSPACE',
          ['Schedule', 'Notifications', 'Accounts', 'Settings', 'Maintenance', 'Zendesk'],
        ],
        ['TOOLS', ['Scan']],
        ['ADMIN', ['Audit log']],
      ],
    ],
    [
      'staff',
      [
        [undefined, ['Overview']],
        [
          'INVENTORY',
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
        ['FULFILLMENT', ['Orders', 'Rentals', 'Bundles']],
        ['PURCHASING', ['Receive POs', 'Purchase orders', 'Suppliers']],
        ['INSIGHTS', ['Reports', 'AI Assistant']],
        ['WORKSPACE', ['Notifications', 'Settings', 'Maintenance', 'Zendesk']],
        ['TOOLS', ['Scan']],
      ],
    ],
    [
      'viewer',
      [
        [undefined, ['Overview']],
        ['INVENTORY', ['Items', 'Books', 'Staging', 'Exceptions', 'Locations', 'Categories']],
        ['FULFILLMENT', ['Orders']],
        ['PURCHASING', ['Receive POs', 'Purchase orders', 'Suppliers']],
        ['WORKSPACE', ['Notifications', 'Settings', 'Maintenance', 'Zendesk']],
        ['TOOLS', ['Scan']],
      ],
    ],
  ])('%s, every module on: every header and its links, in the preview order', (role, expected) => {
    expect(sectionsOf(role)).toEqual(expected);
  });
});
