import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RadioGroup, RadioGroupItem } from './radio-group';

/**
 * The shared radio group (redesign P2.2): native radios under one name in a
 * role="radiogroup", in a row look and a radio-card look.
 */

const FORMATS = [
  { value: 'csv', label: 'CSV', description: 'Opens in any spreadsheet.' },
  { value: 'xlsx', label: 'Excel', description: 'Keeps number formats.' },
  { value: 'pdf', label: 'PDF', description: 'Ready to print.' },
] as const;

function Formats({
  variant,
  onValueChange,
  disabled,
  disabledItem,
}: {
  variant?: 'default' | 'card';
  onValueChange?: (v: string) => void;
  disabled?: boolean;
  disabledItem?: string;
}) {
  const [value, setValue] = React.useState('csv');
  return (
    <RadioGroup
      aria-label="File format"
      value={value}
      variant={variant}
      disabled={disabled}
      onValueChange={(v) => {
        onValueChange?.(v);
        setValue(v);
      }}
    >
      {FORMATS.map((f) => (
        <RadioGroupItem
          key={f.value}
          value={f.value}
          label={f.label}
          description={f.description}
          disabled={disabledItem === f.value}
        />
      ))}
    </RadioGroup>
  );
}

describe('RadioGroup', () => {
  it('is a named radio group whose options are named by their labels and described by their descriptions', () => {
    render(<Formats />);
    expect(screen.getByRole('radiogroup', { name: 'File format' })).toBeInTheDocument();
    const csv = screen.getByRole('radio', { name: 'CSV' });
    expect(csv).toBeChecked();
    expect(csv).toHaveAccessibleDescription('Opens in any spreadsheet.');
    expect(screen.getByRole('radio', { name: 'PDF' })).not.toBeChecked();
    // One name for the whole group, so the browser treats them as one choice.
    const names = new Set(screen.getAllByRole('radio').map((r) => r.getAttribute('name')));
    expect(names.size).toBe(1);
  });

  it('a click chooses, once', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Formats onValueChange={onValueChange} />);
    await user.click(screen.getByRole('radio', { name: 'PDF' }));
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('pdf');
    expect(screen.getByRole('radio', { name: 'PDF' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'CSV' })).not.toBeChecked();
  });

  it('radio card: a click anywhere on the card, the description included, chooses it', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Formats variant="card" onValueChange={onValueChange} />);
    await user.click(screen.getByText('Keeps number formats.'));
    expect(onValueChange).toHaveBeenCalledWith('xlsx');
    expect(screen.getByRole('radio', { name: 'Excel' })).toBeChecked();
  });

  it('the arrow keys move the choice; Tab reaches the chosen option', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Formats onValueChange={onValueChange} />);
    await user.tab();
    expect(screen.getByRole('radio', { name: 'CSV' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Excel' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Excel' })).toHaveFocus();
    expect(onValueChange).toHaveBeenLastCalledWith('xlsx');
  });

  it('keeps its own choice when not controlled, starting from defaultValue', async () => {
    const user = userEvent.setup();
    render(
      <RadioGroup aria-label="Keeps its SKU" defaultValue="keep">
        <RadioGroupItem value="keep" label="Keep the SKU" />
        <RadioGroupItem value="new" label="Give it a new SKU" />
      </RadioGroup>,
    );
    expect(screen.getByRole('radio', { name: 'Keep the SKU' })).toBeChecked();
    await user.click(screen.getByText('Give it a new SKU'));
    expect(screen.getByRole('radio', { name: 'Give it a new SKU' })).toBeChecked();
  });

  it('disabled group and disabled option: no choice', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { unmount } = render(<Formats disabled onValueChange={onValueChange} />);
    for (const r of screen.getAllByRole('radio')) expect(r).toBeDisabled();
    await user.click(screen.getByText('PDF'));
    expect(onValueChange).not.toHaveBeenCalled();
    unmount();

    render(<Formats disabledItem="pdf" onValueChange={onValueChange} />);
    expect(screen.getByRole('radio', { name: 'PDF' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Excel' })).toBeEnabled();
    await user.click(screen.getByText('PDF'));
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('a form posts the chosen value under the given name', () => {
    render(
      <form data-testid="form">
        <RadioGroup aria-label="MFA policy" name="mfa-policy" defaultValue="admins">
          <RadioGroupItem value="off" label="Off" />
          <RadioGroupItem value="admins" label="Owners and admins" />
        </RadioGroup>
      </form>,
    );
    const data = new FormData(screen.getByTestId('form') as HTMLFormElement);
    expect(data.get('mfa-policy')).toBe('admins');
  });

  it('in forced colors the browser draws its own radio, so the chosen one still shows', () => {
    // The custom dot is a fill and an inset shadow, both removed by forced
    // colors (Windows High Contrast): a chosen radio looked empty.
    for (const variant of ['default', 'card'] as const) {
      const { unmount } = render(<Formats variant={variant} />);
      for (const radio of screen.getAllByRole('radio')) {
        expect(radio).toHaveClass('appearance-none', 'forced-colors:appearance-auto');
      }
      unmount();
    }
  });

  it('an option outside a group is a mistake that says so', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<RadioGroupItem value="x" label="Lost" />)).toThrow(
      'RadioGroupItem must be inside a RadioGroup',
    );
  });
});
