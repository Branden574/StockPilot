import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * CLASSIC PARITY OF THE MARKETING PAGES (Liquid Glass stage 3, site lane;
 * IMPLEMENTATION-PLAN.md 4.6 M3 and 4.7, plans/REVISION-DEFAULT.md R8).
 *
 * The glass twins of /contact, /pricing, /privacy, /security, /support and
 * /terms render the same words as the classic pages, so the words move into
 * shared modules under components/marketing/content that both import. That
 * move is a restructure: it must not change one byte of what the classic
 * pages render. Each page is rendered here to its server HTML (React's
 * renderToString, the same markup the static page carries, text-node
 * separators included) and compared with the file under __parity__ that was
 * written from today's pages before the move. Nothing is normalised: a
 * changed class, word, attribute, element or order fails.
 *
 * The (marketing) layout and the landing page are not part of the move and
 * are not rendered here.
 */

vi.mock('@/server/actions/support-tickets', () => ({ createSupportTicketAction: vi.fn() }));

const PAGES = ['contact', 'pricing', 'privacy', 'security', 'support', 'terms'] as const;

async function pageHtml(name: (typeof PAGES)[number]): Promise<string> {
  const mod = (await import(`./${name}/page.tsx`)) as { default: () => React.ReactElement };
  const Page = mod.default;
  return renderToString(<Page />).replace(/></gu, '>\n<');
}

describe('classic marketing pages render byte for byte as before the content move', () => {
  for (const name of PAGES) {
    it(`/${name}`, async () => {
      await expect(await pageHtml(name)).toMatchFileSnapshot(`./__parity__/${name}.html`);
    });
  }
});
