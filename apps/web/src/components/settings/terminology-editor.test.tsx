import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_TERMINOLOGY } from '@stockpilot/core';

/**
 * The four label inputs used to sit under a <Label> tied to nothing, so a
 * screen reader read each one as an unnamed text box. Each label now names
 * its input.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/organization', () => ({ updateTerminologyAction: vi.fn() }));

import { TerminologyEditor } from './terminology-editor';

describe('TerminologyEditor', () => {
  it('names every label input after its label', () => {
    render(<TerminologyEditor current={DEFAULT_TERMINOLOGY} defaults={DEFAULT_TERMINOLOGY} />);
    for (const name of [
      'Charter (singular)',
      'Charter (plural)',
      'Warehouse (singular)',
      'Warehouse (plural)',
    ]) {
      expect(screen.getByLabelText(name)).toHaveAttribute('name');
    }
    expect(screen.getByLabelText('Warehouse (singular)')).toHaveValue(
      DEFAULT_TERMINOLOGY.warehouse_singular,
    );
    expect(screen.getByRole('button', { name: 'Reset to factory defaults' })).toBeInTheDocument();
  });
});
