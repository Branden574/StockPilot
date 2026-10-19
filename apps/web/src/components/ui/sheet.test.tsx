import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Sheet, SheetContent, SheetDescription, SheetTitle } from './sheet';

/**
 * Redesign P2.2c (from P2.3c): a sheet is a floating surface like the menus
 * and popovers, so its edge is the same stronger hairline (--ed-line-strong),
 * not the default structure line.
 */

const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

describe('SheetContent edge', () => {
  it.each([
    ['right', 'border-l'],
    ['left', 'border-r'],
    ['top', 'border-b'],
    ['bottom', 'border-t'],
  ] as const)('a %s sheet draws %s in the stronger hairline', (side, edge) => {
    render(
      <Sheet open>
        <SheetContent side={side}>
          <SheetTitle>Release notes</SheetTitle>
          <SheetDescription>What changed</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    expect(classes(screen.getByRole('dialog'))).toEqual(
      expect.arrayContaining([edge, 'border-[var(--ed-line-strong)]']),
    );
  });

  it("a caller's own border colour still wins", () => {
    render(
      <Sheet open>
        <SheetContent side="left" className="border-sidebar-border">
          <SheetTitle>Menu</SheetTitle>
          <SheetDescription>Navigation</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    const c = classes(screen.getByRole('dialog'));
    expect(c).toContain('border-sidebar-border');
    expect(c).not.toContain('border-[var(--ed-line-strong)]');
  });
});
