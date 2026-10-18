import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Checkbox, CheckboxGlyph } from './checkbox';

/**
 * The shared checkbox (redesign P2.2, DESIGN-SPEC 6.21). What the owner asked
 * for ("make sure our check boxes ... work in the redesign"), pinned:
 * checkbox semantics with the mixed state, an accessible name, the keyboard,
 * exactly one toggle per click even inside a row that toggles on its own
 * click (the "3-4 clicks" report), and the 20 px box.
 */

function Controlled({
  initial = false,
  indeterminate = false,
  onToggle,
  label = 'Select Blue T-shirt',
}: {
  initial?: boolean;
  indeterminate?: boolean;
  onToggle?: (next: boolean) => void;
  label?: string;
}) {
  const [checked, setChecked] = React.useState(initial);
  return (
    <Checkbox
      checked={checked}
      indeterminate={indeterminate}
      label={label}
      onCheckedChange={(next) => {
        onToggle?.(next);
        setChecked(next);
      }}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Checkbox: semantics', () => {
  it('is a checkbox named by its label, unchecked, checked or mixed', () => {
    const { rerender } = render(<Checkbox checked={false} label="Select all rows on this page" />);
    const box = screen.getByRole('checkbox', { name: 'Select all rows on this page' });
    expect(box).toHaveAttribute('aria-checked', 'false');
    expect(box).toHaveAttribute('type', 'button');

    rerender(<Checkbox checked={false} indeterminate label="Select all rows on this page" />);
    expect(box).toHaveAttribute('aria-checked', 'mixed');

    rerender(<Checkbox checked indeterminate label="Select all rows on this page" />);
    // Checked wins over mixed.
    expect(box).toHaveAttribute('aria-checked', 'true');
  });

  it('can be named by visible text instead, which is part of the one control', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <Checkbox checked={false} onCheckedChange={onCheckedChange}>
        Include images
      </Checkbox>,
    );
    const box = screen.getByRole('checkbox', { name: 'Include images' });
    await user.click(screen.getByText('Include images'));
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(box).toContainElement(screen.getByText('Include images'));
  });

  it('accepts aria-label too, and passes test hooks and ids through', () => {
    render(
      <Checkbox checked aria-label="Unselect all 3 selected items" data-testid="bar-box" id="x" />,
    );
    const box = screen.getByTestId('bar-box');
    expect(box).toHaveAccessibleName('Unselect all 3 selected items');
    expect(box).toHaveAttribute('id', 'x');
  });

  it('keeps its role and state even if a caller passes others', () => {
    // @ts-expect-error role is not a Checkbox prop
    render(<Checkbox checked={false} label="Pick" role="button" />);
    expect(screen.getByRole('checkbox', { name: 'Pick' })).toHaveAttribute('aria-checked', 'false');
  });
});

describe('Checkbox: toggling', () => {
  it('a click toggles once, with the next value', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<Controlled onToggle={onToggle} />);
    const box = screen.getByRole('checkbox', { name: 'Select Blue T-shirt' });
    await user.click(box);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenLastCalledWith(true);
    expect(box).toHaveAttribute('aria-checked', 'true');
    await user.click(box);
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onToggle).toHaveBeenLastCalledWith(false);
    expect(box).toHaveAttribute('aria-checked', 'false');
  });

  it('a mixed box becomes checked (select the rest of the page)', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <Checkbox
        checked={false}
        indeterminate
        label="Select all"
        onCheckedChange={onCheckedChange}
      />,
    );
    await user.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('Space and Enter each toggle exactly once', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<Controlled onToggle={onToggle} />);
    const box = screen.getByRole('checkbox', { name: 'Select Blue T-shirt' });
    await user.tab();
    expect(box).toHaveFocus();
    await user.keyboard(' ');
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(box).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Enter}');
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(box).toHaveAttribute('aria-checked', 'false');
  });

  it('inside a row that toggles on its own click: the box and the row area each toggle once', async () => {
    // The owner's "3-4 clicks": a box nested in a toggling row fired both
    // handlers on one click, and the two toggles cancelled out.
    const user = userEvent.setup();
    const flips = vi.fn();
    function Row() {
      const [checked, setChecked] = React.useState(false);
      const toggle = () => {
        flips();
        setChecked((c) => !c);
      };
      return (
        <table>
          <tbody>
            <tr onClick={toggle} data-testid="row">
              <td>
                <Checkbox checked={checked} label="Select Persepolis" onCheckedChange={toggle} />
              </td>
              <td>Persepolis</td>
            </tr>
          </tbody>
        </table>
      );
    }
    render(<Row />);
    const box = screen.getByRole('checkbox', { name: 'Select Persepolis' });

    await user.click(box);
    expect(flips).toHaveBeenCalledTimes(1);
    expect(box).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByText('Persepolis'));
    expect(flips).toHaveBeenCalledTimes(2);
    expect(box).toHaveAttribute('aria-checked', 'false');
  });

  it("a caller's onClick runs first and can cancel the toggle", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    const onClick = vi.fn((e: React.MouseEvent) => e.preventDefault());
    render(
      <Checkbox checked={false} label="Pick" onClick={onClick} onCheckedChange={onCheckedChange} />,
    );
    await user.click(screen.getByRole('checkbox', { name: 'Pick' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('disabled: no toggle by click or key', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <Checkbox checked={false} disabled label="No warehouse" onCheckedChange={onCheckedChange} />,
    );
    const box = screen.getByRole('checkbox', { name: 'No warehouse' });
    expect(box).toBeDisabled();
    await user.click(box);
    box.focus();
    await user.keyboard(' ');
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});

describe('Checkbox: never inside another control', () => {
  it('logs an error in development when rendered inside a button', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <button type="button">
        <Checkbox checked={false} label="Nested" />
      </button>,
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('inside another interactive element'),
    );
  });

  it('stays quiet in a table cell, a label or a plain list row', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <>
        <table>
          <tbody>
            <tr>
              <td>
                <Checkbox checked={false} label="In a cell" />
              </td>
            </tr>
          </tbody>
        </table>
        <ul>
          <li>
            <Checkbox checked label="In a list row" />
          </li>
        </ul>
        <label>
          <Checkbox checked={false} label="In a label" /> Send me the digest
        </label>
      </>,
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('in a label, a click on the text toggles once', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <label>
        <Checkbox checked={false} label="Weekly digest" onCheckedChange={onCheckedChange} /> Send me
        the digest
      </label>,
    );
    await user.click(screen.getByText(/Send me/));
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
  });
});

describe('Checkbox: the box', () => {
  it('is the 20 px box with radius 5; ticked when checked, a bar when mixed, empty otherwise', () => {
    const { rerender } = render(<Checkbox checked={false} label="Pick" />);
    const glyph = () =>
      screen.getByRole('checkbox', { name: 'Pick' }).firstElementChild as HTMLElement;
    expect(glyph()).toHaveClass('h-5', 'w-5', 'rounded-[5px]');
    expect(glyph()).toHaveAttribute('aria-hidden', 'true');
    expect(glyph().childElementCount).toBe(0);

    rerender(<Checkbox checked label="Pick" />);
    // The tick: bottom and RIGHT borders turned +45 degrees (never the mirror).
    expect(glyph().firstElementChild).toHaveClass('rotate-45', 'border-b-2', 'border-r-2');

    rerender(<Checkbox checked={false} indeterminate label="Pick" />);
    expect(glyph().firstElementChild).toHaveClass('h-[2px]', 'w-[10px]');
  });

  it('the mixed bar keeps a system-colour fill in forced colors, so a mixed select-all never looks empty', () => {
    // Forced colors (Windows High Contrast) remove backgrounds; the bar is a
    // background, so it vanished and a partly selected page looked unselected.
    // The tick is drawn with borders, which forced colors keeps.
    render(<Checkbox checked={false} indeterminate label="Select all rows on this page" />);
    const box = screen.getByRole('checkbox', { name: 'Select all rows on this page' })
      .firstElementChild as HTMLElement;
    expect(box.firstElementChild).toHaveClass(
      'forced-colors:forced-color-adjust-none',
      'forced-colors:bg-[CanvasText]',
    );
  });

  it('CheckboxGlyph is the same box with no behaviour, hidden from assistive technology', () => {
    const { container } = render(
      <div role="checkbox" aria-checked="true" aria-label="Warehouse A" tabIndex={0}>
        <CheckboxGlyph checked />
        Warehouse A
      </div>,
    );
    const glyph = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(glyph).toHaveClass('h-5', 'w-5', 'rounded-[5px]');
    expect(glyph.tagName).toBe('SPAN');
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });
});
