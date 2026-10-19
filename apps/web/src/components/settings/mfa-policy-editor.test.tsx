import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The organization MFA policy on the shared radio group (W-ST-03d): a named
 * group of three native radios (it was an unnamed group with a <label> nested
 * in a <label>), Discard only when changed, and Save policy keeps its name
 * while it saves.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const resolveSave = vi.hoisted(() => ({ current: null as null | ((r: unknown) => void) }));
const setPolicy = vi.hoisted(() =>
  vi.fn(
    (_input: { policy: string }) =>
      new Promise((resolve) => {
        resolveSave.current = resolve;
      }),
  ),
);
vi.mock('@/server/actions/mfa', () => ({ setOrgMfaPolicyAction: setPolicy }));

import { MfaPolicyEditor } from './mfa-policy-editor';

describe('MfaPolicyEditor', () => {
  it('is a named group of the three policies, with the current one chosen', () => {
    render(<MfaPolicyEditor current="admins_required" />);
    const group = screen.getByRole('radiogroup', { name: 'Organization MFA policy' });
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'Required for admins' })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save policy' })).toBeDisabled();
  });

  it('saves the chosen policy and keeps "Save policy" named while it saves', async () => {
    render(<MfaPolicyEditor current="optional" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Required for everyone' }));
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(setPolicy).toHaveBeenCalledWith({ policy: 'all_required' });
    expect(screen.getByRole('button', { name: 'Save policy' })).toBeDisabled();
    await act(async () => {
      resolveSave.current?.({ ok: true, data: null });
    });
  });
});
