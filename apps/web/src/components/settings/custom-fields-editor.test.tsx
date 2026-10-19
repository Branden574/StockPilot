import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CustomFieldDefinition } from '@stockpilot/core';

/**
 * CONFLICTS D17: the custom field row's icon buttons now say which field they
 * act on (the pencil had no name at all; the arrows said only "Move up"), and
 * the draft's Required box is the shared checkbox with its words.
 */

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/custom-fields', () => ({
  archiveCustomFieldAction: vi.fn(),
  createCustomFieldAction: vi.fn(),
  updateCustomFieldAction: vi.fn(),
}));

import { CustomFieldsEditor } from './custom-fields-editor';

function def(id: string, label: string, sortOrder: number): CustomFieldDefinition {
  return {
    id,
    organizationId: 'org-1',
    entity: 'item',
    fieldKey: label.toLowerCase().replace(/\W+/g, '_'),
    label,
    fieldType: 'text',
    options: null,
    required: false,
    sortOrder,
    archived: false,
  };
}

describe('CustomFieldsEditor accessible names (D17)', () => {
  it('names the edit and reorder buttons after their field', () => {
    render(
      <CustomFieldsEditor initialDefinitions={[def('a', 'Warranty', 0), def('b', 'Voltage', 1)]} />,
    );
    expect(screen.getByRole('button', { name: 'Edit Warranty' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move Voltage up' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Move Warranty up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Warranty down' })).toBeEnabled();
    expect(screen.getAllByRole('button', { name: 'Archive field' })).toHaveLength(2);
  });

  it('opens the draft from the named edit button, with the key locked and Required as a checkbox', () => {
    render(<CustomFieldsEditor initialDefinitions={[def('a', 'Warranty', 0)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Warranty' }));
    expect(screen.getByRole('heading', { name: 'Edit field' })).toBeInTheDocument();
    expect(screen.getByLabelText('Field key')).toBeDisabled();
    expect(screen.getByText(/Cannot be changed after creation\./)).toBeInTheDocument();
    const required = screen.getByRole('checkbox', { name: 'Required' });
    expect(required).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(required);
    expect(required).toHaveAttribute('aria-checked', 'true');
  });
});
