import { describe, expect, it, vi } from 'vitest';

import { type SubcategoryTrackingProfile } from '@stockpilot/core';

import {
  EMPTY_TRACKING_PROFILE_DRAFT,
  isTrackingProfileComplete,
} from './tracking-profile-editor';

/**
 * `isTrackingProfileComplete` is the dialog's Save gate. It is derived from the
 * SHARED `trackingProfileSchema` + `trackingProfileConsistencyError` (review
 * fix) precisely so it cannot drift from what CategoriesService will accept —
 * the cases below are the ones the old hand-written field list let through.
 */
const COMPLETE: SubcategoryTrackingProfile = {
  key: 'warmup_gear',
  label: 'Warm-up gear',
  defaultMode: 'QUANTITY',
  allowedModes: ['QUANTITY', 'OPTIONAL_SERIALIZED'],
  supportedAttributes: ['brand', 'size'],
  requiredAttributes: ['size'],
  defaultCountingUnit: 'each',
  supportsNumbers: false,
  supportsSizes: true,
  supportsColors: false,
  individualTrackingAllowed: false,
};

describe('isTrackingProfileComplete', () => {
  it('accepts a complete, consistent draft', () => {
    expect(isTrackingProfileComplete(COMPLETE)).toBe(true);
  });

  it('rejects the empty draft the editor starts from', () => {
    expect(isTrackingProfileComplete(EMPTY_TRACKING_PROFILE_DRAFT)).toBe(false);
  });

  it('rejects a whitespace-only key or label', () => {
    expect(isTrackingProfileComplete({ ...COMPLETE, key: '   ' })).toBe(false);
    expect(isTrackingProfileComplete({ ...COMPLETE, label: '  ' })).toBe(false);
  });

  it('rejects a counting unit outside the shared vocabulary', () => {
    expect(
      isTrackingProfileComplete({
        ...COMPLETE,
        defaultCountingUnit: 'dozen' as SubcategoryTrackingProfile['defaultCountingUnit'],
      }),
    ).toBe(false);
  });

  it('rejects a non-boolean flag', () => {
    expect(
      isTrackingProfileComplete({
        ...COMPLETE,
        supportsSizes: undefined as unknown as boolean,
      }),
    ).toBe(false);
  });

  it('rejects a label past the length the server accepts', () => {
    expect(isTrackingProfileComplete({ ...COMPLETE, label: 'x'.repeat(121) })).toBe(false);
  });

  it('rejects the two cross-field inconsistencies', () => {
    expect(
      isTrackingProfileComplete({ ...COMPLETE, requiredAttributes: ['colorway'] }),
    ).toBe(false);
    expect(isTrackingProfileComplete({ ...COMPLETE, defaultMode: 'LOT_TRACKED' })).toBe(false);
  });
});

/**
 * The editor's choices use the shared Checkbox (DESIGN-SPEC 6.21): each
 * chip is one control named by its words, a required attribute is disabled
 * until it is supported, and every toggle still edits the draft.
 */
describe('TrackingProfileEditor checkboxes', () => {
  it('toggles allowed modes, attributes and flags through the shared Checkbox', async () => {
    const { render, screen } = await import('@testing-library/react');
    const { default: userEvent } = await import('@testing-library/user-event');
    const { TrackingProfileEditor } = await import('./tracking-profile-editor');
    const { TRACKING_MODE_LABELS } = await import('@stockpilot/core');
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<TrackingProfileEditor value={EMPTY_TRACKING_PROFILE_DRAFT} onChange={onChange} />);

    await user.click(screen.getByRole('checkbox', { name: TRACKING_MODE_LABELS.QUANTITY }));
    expect(onChange.mock.calls.at(-1)?.[0].allowedModes).toEqual(['QUANTITY']);

    await user.click(screen.getByRole('checkbox', { name: 'Can be individually tagged' }));
    expect(onChange.mock.calls.at(-1)?.[0].individualTrackingAllowed).toBe(true);

    // Required attributes wait for their supported twin.
    const boxes = screen.getAllByRole('checkbox');
    const disabled = boxes.filter((b) => (b as HTMLButtonElement).disabled);
    expect(disabled.length).toBeGreaterThan(0);
    for (const b of disabled) expect(b).toHaveAttribute('aria-checked', 'false');
  });
});
