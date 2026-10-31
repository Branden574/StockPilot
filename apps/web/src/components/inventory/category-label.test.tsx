import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CategoryLabel } from './category-label';

/**
 * The Category cell on Items, Books and Rentals (table rows and Grid cards)
 * draws the category's stored colour. The column is plain text a manager can
 * write through the Data API, and the server renderer copies a style value
 * into the page as given, so an unchecked `;` added CSS declarations to every
 * member's page (docket T14). Rendered on the server, as the pages are.
 *
 * The name itself reads in ink 2, and the colour is drawn on its 6 px dot
 * only (FX2: DESIGN-SPEC 6.9 draws Category in ink 2, CONFLICTS C8 keeps the
 * dot), the markup the redesign follow-up batch draws in the table and Grid.
 */

const INJECTED = '#000;position:fixed;inset:0;z-index:2147483647;background:#fff;font-size:40px';

/** Every style attribute in the server HTML. */
function styles(html: string): string[] {
  return [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]!);
}

/** The server HTML's outer element, parsed as the browser reads it. */
function parse(html: string): HTMLElement {
  return new DOMParser().parseFromString(html, 'text/html').body.firstElementChild as HTMLElement;
}

/** The label's dot: its own aria-hidden child span, if it has one. */
const dotOf = (label: HTMLElement) =>
  label.querySelector<HTMLElement>(':scope > span[aria-hidden]');

describe('CategoryLabel', () => {
  it('a stored colour that is not #rrggbb never reaches the server HTML: no colour, no dot', () => {
    for (const wrap of [false, true]) {
      const html = renderToString(
        <CategoryLabel category={{ name: 'Swag', color: INJECTED }} wrap={wrap} />,
      );
      expect(html).not.toContain('position');
      expect(html).not.toContain('z-index');
      expect(styles(html)).toEqual([]);
      const label = parse(html);
      expect(label).toHaveClass('text-ink-2');
      expect(dotOf(label)).toBeNull();
      expect(label.textContent).toBe('Swag');
    }
  });

  it('other refused forms draw the plain name too', () => {
    for (const color of [
      'red;position:fixed',
      '#6366f1;',
      ' #6366f1',
      'url(https://x.example/a.png)',
      '#fff',
    ]) {
      const html = renderToString(<CategoryLabel category={{ name: 'Swag', color }} />);
      expect(styles(html), color).toEqual([]);
    }
  });

  // Mutation caught: the name drawn in the stored colour again (a style of
  // its own), ink 2 lost from the name, or the colour lost from the dot.
  it('the name reads in ink 2 with no colour of its own; a #rrggbb colour is drawn on its dot (FX2)', () => {
    for (const wrap of [false, true]) {
      const html = renderToString(
        <CategoryLabel category={{ name: 'Swag', color: '#6366f1' }} wrap={wrap} />,
      );
      expect(styles(html)).toEqual(['background-color:#6366f1']);
      const label = parse(html);
      expect(label).toHaveClass('text-ink-2');
      expect(label.getAttribute('style')).toBeNull();
      const dot = dotOf(label);
      expect(dot).not.toBeNull();
      expect(dot).toHaveClass('h-1.5', 'w-1.5', 'rounded-full');
      expect(dot!.textContent).toBe('');
      expect(label.textContent).toBe('Swag');
    }
  });

  it('no colour: the name in ink 2 with no dot; no category: a dash', () => {
    const html = renderToString(<CategoryLabel category={{ name: 'Swag', color: null }} />);
    expect(styles(html)).toEqual([]);
    const label = parse(html);
    expect(label).toHaveClass('text-ink-2');
    expect(dotOf(label)).toBeNull();
    expect(renderToString(<CategoryLabel category={null} />)).toContain('—');
  });
});
