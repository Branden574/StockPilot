import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ORDER_ITEMS_ROLES_LOCK_NOTE_COPY, PERMISSIONS, PERMISSION_META } from '@stockpilot/core';

/**
 * The Roles & permissions matrix (W-ST-07a / 07b) on the shared Checkbox:
 * every box is still there (4 editable roles x every permission, plus one per
 * permission for the chosen member), a click saves at once with the spinner
 * in the box's place and the box keeps focus, and a refused save puts back
 * only its own box.
 */

type Res = { ok: true; data: unknown } | { ok: false; error: { message: string } };
const deferreds = vi.hoisted(() => [] as Array<(r: Res) => void>);
const setRole = vi.hoisted(() =>
  vi.fn(
    () =>
      new Promise<Res>((resolve) => {
        deferreds.push(resolve);
      }),
  ),
);
const setUser = vi.hoisted(() => vi.fn(async (): Promise<Res> => ({ ok: true, data: null })));
vi.mock('@/server/actions/permissions', () => ({
  setRolePermissionOverrideAction: setRole,
  setUserPermissionOverrideAction: setUser,
  applyAuditorPresetAction: vi.fn(async () => ({ ok: true, data: null })),
}));
vi.mock('sonner', () => ({
  toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

import { RolePermissionMatrix } from './role-permission-matrix';

const FIRST = PERMISSIONS[0]!;
const SECOND = PERMISSIONS[1]!;
const label = (role: string, perm: (typeof PERMISSIONS)[number]) =>
  `${role} — ${PERMISSION_META[perm].label}`;

beforeEach(() => {
  vi.clearAllMocks();
  deferreds.length = 0;
});

describe('RolePermissionMatrix', () => {
  it('draws one checkbox per editable role and permission, plus one per permission for the chosen member', () => {
    render(
      <RolePermissionMatrix
        roleOverrides={[]}
        userOverrides={[]}
        members={[{ userId: 'u-2', name: 'Sam', role: 'staff' }]}
      />,
    );
    expect(screen.getAllByRole('checkbox')).toHaveLength(
      PERMISSIONS.length * 4 + PERMISSIONS.length,
    );
    const perUser = screen.getByRole('region', { name: 'Permissions for Sam' });
    expect(within(perUser).getAllByRole('checkbox')).toHaveLength(PERMISSIONS.length);
    expect(screen.getByLabelText('Member')).toHaveValue('u-2');
  });

  it('lists Permissions by role once: the matrix scroll area is the region, not the card around it', () => {
    render(<RolePermissionMatrix roleOverrides={[]} userOverrides={[]} members={[]} />);
    const regions = screen.getAllByRole('region', { name: 'Permissions by role' });
    expect(regions).toHaveLength(1);
    expect(regions[0]!.tagName).toBe('DIV');
    expect(regions[0]).toHaveAttribute('tabindex', '0');
    expect(within(regions[0]!).getByRole('table')).toBeInTheDocument();
    // The card keeps the title as its heading.
    expect(
      screen.getByRole('heading', { level: 2, name: 'Permissions by role' }).closest('section'),
    ).not.toHaveAttribute('aria-labelledby');
  });

  it('saves on click with a spinner in the box’s place, keeps the box focused, and ignores a second press while saving', async () => {
    render(<RolePermissionMatrix roleOverrides={[]} userOverrides={[]} members={[]} />);
    const box = screen.getByRole('checkbox', { name: label('Viewer', FIRST) });
    const before = box.getAttribute('aria-checked');
    box.focus();
    fireEvent.click(box);

    expect(setRole).toHaveBeenCalledTimes(1);
    const same = screen.getByRole('checkbox', { name: label('Viewer', FIRST) });
    expect(same).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(box).toHaveAttribute('aria-busy', 'true');
    expect(box.getAttribute('aria-checked')).not.toBe(before);
    expect(screen.getByLabelText(`Saving ${label('Viewer', FIRST)}`)).toBeInTheDocument();

    fireEvent.click(box);
    expect(setRole).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferreds[0]!({ ok: true, data: null });
    });
    expect(box).not.toHaveAttribute('aria-busy');
    expect(screen.queryByLabelText(`Saving ${label('Viewer', FIRST)}`)).toBeNull();
  });

  it('a refused save reverts only its own box, not one saved meanwhile', async () => {
    render(<RolePermissionMatrix roleOverrides={[]} userOverrides={[]} members={[]} />);
    const a = screen.getByRole('checkbox', { name: label('Staff', FIRST) });
    const b = screen.getByRole('checkbox', { name: label('Staff', SECOND) });
    const aBefore = a.getAttribute('aria-checked');
    const bBefore = b.getAttribute('aria-checked');

    fireEvent.click(a);
    fireEvent.click(b);
    expect(setRole).toHaveBeenCalledTimes(2);

    await act(async () => {
      deferreds[1]!({ ok: true, data: null }); // B saved
    });
    await act(async () => {
      deferreds[0]!({ ok: false, error: { message: 'No.' } }); // A refused
    });

    expect(a.getAttribute('aria-checked')).toBe(aBefore);
    expect(b.getAttribute('aria-checked')).not.toBe(bBefore);
  });
});

/**
 * Roles page lock (migration 0413, design 8.5). orders:manage_catalog_visibility
 * is platform-managed: only StockPilot support sets a member's exception, from
 * the platform console. Org owners and admins SEE it here, read-only, in both
 * grids, with the note saying who manages it; no box for it saves anything
 * (the org actions and the database refuse it too). Every other permission
 * keeps working.
 */
describe('RolePermissionMatrix: the platform-managed Manage order items row', () => {
  const KEY = 'orders:manage_catalog_visibility' as const;
  const LABEL = PERMISSION_META[KEY].label;

  it('is read-only in the role grid, at its role default, with the note', () => {
    render(
      <RolePermissionMatrix
        // A role row for the key cannot exist (the database refuses it); if
        // one ever did, the resolver ignores it, and so does the grid.
        roleOverrides={[{ role: 'staff', permission: KEY, granted: true }]}
        userOverrides={[]}
        members={[]}
      />,
    );
    const expected: Record<string, 'true' | 'false'> = {
      Admin: 'true',
      Manager: 'true',
      Staff: 'false',
      Viewer: 'false',
    };
    for (const [role, checked] of Object.entries(expected)) {
      const box = screen.getByRole('checkbox', { name: `${role} — ${LABEL}` });
      expect(box).toBeDisabled();
      expect(box).toHaveAttribute('aria-checked', checked);
      fireEvent.click(box);
    }
    expect(setRole).not.toHaveBeenCalled();
    const grid = screen.getByRole('region', { name: 'Permissions by role' });
    const row = within(grid)
      .getByRole('rowheader', { name: new RegExp(LABEL) })
      .closest('tr')!;
    expect(within(row).getByText(ORDER_ITEMS_ROLES_LOCK_NOTE_COPY)).toBeInTheDocument();
    expect(within(row).getByLabelText('Owner has this by default')).toBeInTheDocument();
    // Its neighbours still save.
    expect(screen.getByRole('checkbox', { name: label('Staff', FIRST) })).toBeEnabled();
  });

  it("is read-only in the per-user panel and shows StockPilot's exception", () => {
    render(
      <RolePermissionMatrix
        roleOverrides={[]}
        userOverrides={[
          { user_id: 'u-mgr', permission: KEY, granted: false },
          { user_id: 'u-staff', permission: KEY, granted: true },
        ]}
        members={[
          { userId: 'u-mgr', name: 'Morgan', role: 'manager' },
          { userId: 'u-staff', name: 'Sam', role: 'staff' },
        ]}
      />,
    );
    const panel = () => screen.getByRole('region', { name: /^Permissions for / });
    let box = within(panel()).getByRole('checkbox', { name: `Morgan — ${LABEL}` });
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(box);
    expect(setUser).not.toHaveBeenCalled();
    let row = box.closest('tr')!;
    expect(within(row).getByText('Denied by StockPilot')).toBeInTheDocument();
    expect(within(row).getByText(ORDER_ITEMS_ROLES_LOCK_NOTE_COPY)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Member'), { target: { value: 'u-staff' } });
    box = within(panel()).getByRole('checkbox', { name: `Sam — ${LABEL}` });
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute('aria-checked', 'true');
    row = box.closest('tr')!;
    expect(within(row).getByText('Allowed by StockPilot')).toBeInTheDocument();
    // Another permission for the same member still saves.
    const other = within(panel()).getByRole('checkbox', {
      name: `Sam — ${PERMISSION_META[FIRST].label}`,
    });
    expect(other).toBeEnabled();
  });
});
