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

  it('the links under the three new headers (owner, every module on)', () => {
    expect(linksUnder('owner', 'FULFILLMENT')).toEqual(['Rentals', 'Bundles', 'Orders', 'Returns']);
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
      'Staging',
      'Exceptions',
      'Books',
      'Categories',
      'Tags',
      'Movements',
      'Cycle counts',
      'Procedures',
      'Locations',
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
