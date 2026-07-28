import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Radix Select needs pointer-capture APIs happy-dom doesn't implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/categories',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/categories', () => ({
  archiveCategoryAction: vi.fn(),
  createCategoryAction: vi.fn(),
  restoreCategoryAction: vi.fn(),
  setupSportsCategoriesAction: vi.fn(),
  updateCategoryAction: vi.fn(),
}));
vi.mock('@/server/actions/item-visibility', () => ({
  setCategoryPublicVisibilityAction: vi.fn(),
}));

import { createCategoryAction, updateCategoryAction } from '@/server/actions/categories';

import { CategoriesManager } from './categories-manager';

/**
 * Task 12's acceptance line is "a Sports root with eight subcategories, each
 * showing its resolved mode and counting unit". The live verification found the
 * MODE rendered and the UNIT missing everywhere on the screen: a Shoes row read
 * `Shoes | Tracking: Quantity by variant | Public` with no "pairs" anywhere, and
 * the editor dialog exposes no counting-unit control either. The unit was
 * resolving correctly elsewhere (the item form's grouping preview reads
 * "Counting unit pairs"), so this is purely the categories screen not saying it.
 *
 * The unit resolves through the SAME fallback chain the server's
 * `resolveTrackingProfile` uses — own column, then the parent's, then the
 * subcategory profile's default — so the screen can never claim a unit the
 * server would not stamp.
 */
function row(over: Partial<Parameters<typeof CategoriesManager>[0]['initial'][number]> = {}) {
  return {
    id: 'cat-1',
    name: 'Shoes',
    description: null,
    color: null,
    supports_sizes: true,
    public_visibility: 'public' as const,
    parent_id: 'cat-sports-root',
    tracking_mode: null,
    sports_subcategory_key: 'shoes',
    tracking_profile: null,
    default_unit_of_measure: null,
    ...over,
  };
}

const SPORTS_ROOT = row({
  id: 'cat-sports-root',
  name: 'Sports',
  parent_id: null,
  sports_subcategory_key: null,
  supports_sizes: false,
});

function renderManager(rows: ReturnType<typeof row>[], sportsEnabled = true) {
  render(
    <CategoriesManager
      initial={rows}
      canManage={false}
      canManagePublicVisibility={false}
      sportsEnabled={sportsEnabled}
      canManageSports={false}
    />,
  );
}

/** The manager as a sports ADMIN sees it — the only configuration in which the
 *  dialog's sports section renders and its payload builder runs. */
function renderEditable(rows: ReturnType<typeof row>[]) {
  render(
    <CategoriesManager
      initial={rows}
      canManage
      canManagePublicVisibility={false}
      sportsEnabled
      canManageSports
    />,
  );
}

describe('CategoriesManager — the resolved counting unit is rendered', () => {
  it('shows the subcategory profile default beside the tracking mode (pairs for Shoes)', () => {
    renderManager([SPORTS_ROOT, row()]);
    expect(screen.getByText(/Quantity by variant/)).toBeTruthy();
    expect(screen.getByText(/pairs/)).toBeTruthy();
  });

  it("prefers the category's own counting unit over the profile default", () => {
    renderManager([SPORTS_ROOT, row({ default_unit_of_measure: 'set' })]);
    expect(screen.getByText(/sets/)).toBeTruthy();
    expect(screen.queryByText(/pairs/)).toBeNull();
  });

  it("inherits the parent's counting unit when the child has none", () => {
    renderManager([
      row({
        id: 'cat-sports-root',
        name: 'Sports',
        parent_id: null,
        sports_subcategory_key: null,
        default_unit_of_measure: 'case',
      }),
      row({ sports_subcategory_key: null, tracking_mode: 'QUANTITY', default_unit_of_measure: null }),
    ]);
    expect(screen.getByText(/cases/)).toBeTruthy();
  });

  it("renders 'each' without pluralising it", () => {
    renderManager([SPORTS_ROOT, row({ sports_subcategory_key: 'jerseys' })]);
    expect(screen.getByText(/Numbered variant/)).toBeTruthy();
    expect(screen.getByText(/each/)).toBeTruthy();
  });

  it('a plain category still renders with no sports affordances at all (regression)', () => {
    renderManager(
      [row({ id: 'cat-plain', name: 'Electronics', parent_id: null, sports_subcategory_key: null })],
      true,
    );
    expect(screen.queryByText(/Tracking:/)).toBeNull();
    expect(screen.queryByText(/Counting unit/)).toBeNull();
  });

  it('renders nothing sports-related with the module off (regression)', () => {
    renderManager([SPORTS_ROOT, row()], false);
    expect(screen.queryByText(/Tracking:/)).toBeNull();
    expect(screen.queryByText(/Counting unit/)).toBeNull();
  });
});

/**
 * RE-VERIFY FAIL: renaming a profile-less child of the Sports root is refused.
 *
 * The server has distinguished ABSENT from NULL since the Task 12 fix —
 * `touchesSportsPolicy` is `patch[k] !== undefined`, and `update()`'s merge reads
 * `patch.X !== undefined ? (patch.X ?? null) : current.X`. So "untouched" is
 * expressible; this dialog just never expressed it. Its payload builder spread
 * `sportsSubcategoryKey / trackingMode / trackingProfile` unconditionally
 * whenever the sports section was on screen — including three explicit `null`s
 * on the "not a sports subcategory" branch — so EVERY save of EVERY subcategory
 * posted a sports-policy write. `assertSportsWriteAllowed` then demanded
 * `sports:manage`, and `assertSportsRootChildValid` re-ran on a row that had not
 * changed, refusing a plain rename with SPORTS_SUBCATEGORY_REQUIRED.
 *
 * The parallel gate for `parentId` was already fixed this way (the dialog always
 * resends the current parent, so `update()` compares it against the row and only
 * treats a genuine MOVE as a move). These tests hold the sports half to the same
 * rule: send a sports field only when the human actually changed it.
 *
 * The server stays strict. An explicit `null` still means "clear it" and must
 * still be sent — and still gated — when that is what was asked for.
 */
describe('CategoriesManager — the edit dialog sends only what changed', () => {
  const PLAIN_CHILD = row({
    id: 'cat-plain-child',
    name: 'Footwear',
    parent_id: 'cat-sports-root',
    sports_subcategory_key: null,
    tracking_mode: null,
    tracking_profile: null,
  });

  /** Open the edit dialog on a row, retype the name, save. */
  async function rename(user: ReturnType<typeof userEvent.setup>, from: string, to: string) {
    await user.click(screen.getByRole('button', { name: from }));
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, to);
    await user.click(screen.getByRole('button', { name: /save changes/i }));
  }

  /** The payload the dialog posted, as the action received it. */
  function sentPayload() {
    const call = vi.mocked(updateCategoryAction).mock.calls.at(-1);
    if (!call) throw new Error('updateCategoryAction was never called');
    return call[1] as Record<string, unknown>;
  }

  beforeEach(() => {
    vi.mocked(updateCategoryAction).mockResolvedValue({ ok: true, data: { id: 'x' } } as never);
    vi.mocked(createCategoryAction).mockResolvedValue({ ok: true, data: { id: 'x' } } as never);
  });

  it('PROBE: a plain rename of a profile-less Sports-root child touches no sports field', async () => {
    const user = userEvent.setup();
    renderEditable([SPORTS_ROOT, PLAIN_CHILD]);
    await rename(user, 'Footwear', 'Footwear & Cleats');

    await waitFor(() => expect(updateCategoryAction).toHaveBeenCalled());
    const payload = sentPayload();
    expect(payload.name).toBe('Footwear & Cleats');
    // ABSENT, not null. `touchesSportsPolicy` is presence-based, so a null here
    // is a sports-policy write and the rename is refused all over again.
    expect('sportsSubcategoryKey' in payload).toBe(false);
    expect('trackingMode' in payload).toBe(false);
    expect('trackingProfile' in payload).toBe(false);
  });

  it('round-trips an UNCHANGED profile as absent rather than resending it', async () => {
    const user = userEvent.setup();
    renderEditable([SPORTS_ROOT, row({ id: 'cat-shoes', name: 'Shoes', sports_subcategory_key: 'shoes' })]);
    await rename(user, 'Shoes', 'Shoes and Boots');

    await waitFor(() => expect(updateCategoryAction).toHaveBeenCalled());
    const payload = sentPayload();
    expect(payload.name).toBe('Shoes and Boots');
    expect('sportsSubcategoryKey' in payload).toBe(false);
    expect('trackingProfile' in payload).toBe(false);
  });

  it('still sends an EXPLICIT null when the human really clears the profile', async () => {
    const user = userEvent.setup();
    renderEditable([SPORTS_ROOT, row({ id: 'cat-shoes', name: 'Shoes', sports_subcategory_key: 'shoes' })]);

    await user.click(screen.getByRole('button', { name: 'Shoes' }));
    // Untick "This is a Sports subcategory" — the one gesture that means "clear".
    await user.click(await screen.findByRole('checkbox', { name: /this is a sports subcategory/i }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateCategoryAction).toHaveBeenCalled());
    const payload = sentPayload();
    // Present AND null: the server reads that as "clear it", still behind
    // sports:manage, and still refuses the incomplete states it always refused.
    expect('sportsSubcategoryKey' in payload).toBe(true);
    expect(payload.sportsSubcategoryKey).toBeNull();
  });

  it('sends the key the human picked when the subcategory actually changes', async () => {
    const user = userEvent.setup();
    renderEditable([SPORTS_ROOT, PLAIN_CHILD]);

    await user.click(screen.getByRole('button', { name: 'Footwear' }));
    await user.click(await screen.findByRole('checkbox', { name: /this is a sports subcategory/i }));
    await user.click(await screen.findByRole('combobox', { name: /subcategory type/i }));
    await user.click(await screen.findByRole('option', { name: /shoes/i }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateCategoryAction).toHaveBeenCalled());
    expect(sentPayload().sportsSubcategoryKey).toBe('shoes');
  });

  it('leaves CREATE alone — a new category states its whole sports intent', async () => {
    const user = userEvent.setup();
    renderEditable([SPORTS_ROOT, PLAIN_CHILD]);
    await user.click(screen.getByRole('button', { name: /add subcategory/i }));
    await user.type(await screen.findByLabelText('Name'), 'Helmets');
    await user.click(screen.getByRole('button', { name: /create category/i }));

    await waitFor(() => expect(createCategoryAction).toHaveBeenCalled());
    const payload = vi.mocked(createCategoryAction).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // There is no "current" to compare against, so the explicit nulls stand.
    expect('sportsSubcategoryKey' in payload).toBe(true);
    expect(payload.sportsSubcategoryKey).toBeNull();
  });
});
