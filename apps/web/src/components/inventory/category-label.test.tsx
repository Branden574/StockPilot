import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CategoryLabel } from './category-label';

/**
 * The Category cell on Items, Books and Rentals (table rows and Grid cards)
 * draws the category's stored colour. The column is plain text a manager can
 * write through the Data API, and the server renderer copies a style value
 * into the page as given, so an unchecked `;` added CSS declarations to every
 * member's page (docket T14). Rendered on the server, as the pages are.
 */

const INJECTED = '#000;position:fixed;inset:0;z-index:2147483647;background:#fff;font-size:40px';

/** Every style attribute in the server HTML. */
function styles(html: string): string[] {
  return [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]!);
}

describe('CategoryLabel', () => {
  it('a stored colour that is not #rrggbb never reaches the server HTML: no colour, no dot', () => {
    for (const wrap of [false, true]) {
      const html = renderToString(
        <CategoryLabel category={{ name: 'Swag', color: INJECTED }} wrap={wrap} />,
      );
      expect(html).not.toContain('position');
      expect(html).not.toContain('z-index');
      expect(styles(html)).toEqual([]);
      expect(html).toContain('Swag');
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

  it('a #rrggbb colour still colours the name and its dot', () => {
    const html = renderToString(
      <CategoryLabel category={{ name: 'Swag', color: '#6366f1' }} wrap />,
    );
    expect(styles(html)).toEqual(['color:#6366f1', 'background-color:#6366f1']);
  });

  it('no colour: the plain name; no category: a dash', () => {
    expect(
      styles(renderToString(<CategoryLabel category={{ name: 'Swag', color: null }} />)),
    ).toEqual([]);
    expect(renderToString(<CategoryLabel category={null} />)).toContain('—');
  });
});
