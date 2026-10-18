import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Input } from './input';
import { SelectTrigger, Select, SelectValue } from './select';
import { Textarea } from './textarea';

/**
 * Redesign P2.2 fields (DESIGN-SPEC 6.3): 32 px and 13 px on desktop; below sm
 * 44 px and 16 px.
 *
 * Defect fixed here: the phone size used to be the field's DEFAULT
 * (`text-base sm:text-sm`), so a caller's own size (`text-[12.5px]` on the
 * Items search, `text-xs` on table inputs) replaced the 16 px on phones, where
 * iOS Safari then zoomed the page on focus, and lost to `sm:text-sm` on
 * desktop, the opposite of what the caller asked for. The phone size now comes
 * from `max-sm:` utilities, which a caller's plain classes never remove.
 */

const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

describe('Input', () => {
  it('32 px / 13 px on desktop, 44 px / 16 px on phones, with the focus ring', () => {
    render(<Input aria-label="Name" />);
    expect(classes(screen.getByLabelText('Name'))).toEqual(
      expect.arrayContaining([
        'h-8',
        'text-[13px]',
        'max-sm:h-11',
        'max-sm:text-base',
        'focus-visible:ring-2',
        'border-[var(--ed-line-strong)]',
      ]),
    );
  });

  it("a caller's desktop size wins on desktop and never removes the phone size", () => {
    render(<Input aria-label="Search items" className="h-8 pl-8 text-[12.5px]" />);
    const c = classes(screen.getByLabelText('Search items'));
    expect(c).toEqual(expect.arrayContaining(['text-[12.5px]', 'max-sm:text-base', 'max-sm:h-11']));
    // Nothing at sm and up overrides the caller any more.
    expect(c.filter((x) => x.startsWith('sm:'))).toEqual([]);
    expect(c).not.toContain('text-[13px]');
  });

  it('a non-text input (colour, checkbox, range) keeps the size its caller gives it on phones', () => {
    render(<Input type="color" aria-label="Custom tag color" className="h-7 w-10 p-0.5" />);
    const c = classes(screen.getByLabelText('Custom tag color'));
    expect(c).toEqual(expect.arrayContaining(['h-7', 'w-10']));
    expect(c).not.toContain('max-sm:h-11');
  });

  it('number, date and search fields are text fields for this purpose', () => {
    render(
      <>
        <Input type="number" aria-label="Qty" />
        <Input type="date" aria-label="Needed by" />
        <Input type="search" aria-label="Find" />
      </>,
    );
    for (const name of ['Qty', 'Needed by', 'Find']) {
      expect(classes(screen.getByLabelText(name))).toContain('max-sm:text-base');
    }
  });
});

describe('Textarea and SelectTrigger follow the same rule', () => {
  it('Textarea: 13 px, 16 px on phones even with a caller size', () => {
    render(<Textarea aria-label="Notes" className="text-xs" />);
    const c = classes(screen.getByLabelText('Notes'));
    expect(c).toEqual(expect.arrayContaining(['text-xs', 'max-sm:text-base']));
  });

  it('SelectTrigger: 32 px / 13 px, 44 px / 16 px on phones, the placeholder muted', () => {
    render(
      <Select>
        <SelectTrigger aria-label="Category" className="h-9 w-44">
          <SelectValue placeholder="Choose a category" />
        </SelectTrigger>
      </Select>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Category' });
    expect(classes(trigger)).toEqual(
      expect.arrayContaining([
        'h-9',
        'max-sm:h-11',
        'max-sm:text-base',
        'data-[placeholder]:text-muted-foreground',
      ]),
    );
    expect(trigger).toHaveAttribute('data-placeholder');
  });
});
