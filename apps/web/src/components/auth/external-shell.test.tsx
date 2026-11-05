import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/theme/theme-toggle', () => ({
  ThemeToggle: () => <button type="button">Toggle theme</button>,
}));

import { ExternalCard, ExternalHeader, ExternalShell, ExternalStatusCard } from './external-shell';

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * The one frame for pages opened from a link, a QR code or an email (P5.1,
 * CONFLICTS E1). It must stay a server component that reads nothing: no
 * session, cookie, header, database or analytics, so an anonymous token page
 * pays for no auth call and logs nothing.
 */

describe('ExternalShell', () => {
  it('is a server component that imports nothing that reads a session, the database or analytics', () => {
    const source = readFileSync(join(__dirname, 'external-shell.tsx'), 'utf8');
    expect(source).not.toMatch(/^['"]use client['"]/m);
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    // The appearance menu (R13): the flag module imports nothing, and the
    // menu is a client component that reads only next-themes and the
    // appearance context.
    expect(imports.sort()).toEqual([
      '@/components/theme/appearance-flag',
      '@/components/theme/theme-toggle',
      '@/lib/utils',
      'react',
    ]);
  });

  it('draws one main column, and the Powered by line only when asked', () => {
    const { rerender } = render(
      <ExternalShell poweredBy>
        <p>Body</p>
      </ExternalShell>,
    );
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByText('Powered by StockPilot')).toBeInTheDocument();
    rerender(
      <ExternalShell>
        <p>Body</p>
      </ExternalShell>,
    );
    expect(screen.queryByText('Powered by StockPilot')).toBeNull();
  });

  it('inside a layout that already has a main, draws only a plain column', () => {
    const { container } = render(
      <ExternalShell frame="column" as="div">
        <p>Body</p>
      </ExternalShell>,
    );
    expect(screen.queryByRole('main')).toBeNull();
    expect(container.querySelector('[data-slot="external-shell"]')).toBeNull();
    expect(container.querySelector('[data-slot="external-column"]')?.tagName).toBe('DIV');
  });

  it('renders an optional top bar (invite, onboarding) above the column', () => {
    render(
      <ExternalShell topBar={<a href="#top">Home</a>}>
        <p>Body</p>
      </ExternalShell>,
    );
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });

  it('the top bar is the page banner landmark, outside the main column (invite and onboarding had one before the shared frame)', () => {
    const { rerender } = render(
      <ExternalShell topBar={<a href="#top">Home</a>}>
        <p>Body</p>
      </ExternalShell>,
    );
    const banner = screen.getByRole('banner');
    expect(banner.tagName).toBe('HEADER');
    expect(banner).toHaveAttribute('data-slot', 'external-top-bar');
    expect(within(banner).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '#top');
    expect(screen.getByRole('main')).not.toContainElement(banner);
    expect(within(banner).queryByText('Body')).toBeNull();

    rerender(
      <ExternalShell>
        <p>Body</p>
      </ExternalShell>,
    );
    expect(screen.queryByRole('banner')).toBeNull();
  });
});

describe('ExternalShell: the way back to Classic (plans/REVISION-DEFAULT.md R13, item 22)', () => {
  const slot = (container: HTMLElement) =>
    container.querySelector('[data-slot="external-appearance"]');

  it.each(['default', 'opt-in'])(
    '%s: a page with no top bar gets the appearance menu in a glass-only corner, outside the main column',
    (rollout) => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      const { container } = render(
        <ExternalShell>
          <p>Body</p>
        </ExternalShell>,
      );
      const corner = slot(container);
      expect(corner).not.toBeNull();
      expect(corner).toHaveAttribute('data-glass-only');
      expect(
        within(corner as HTMLElement).getByRole('button', { name: 'Toggle theme' }),
      ).toBeTruthy();
      expect(screen.getByRole('main')).not.toContainElement(corner as HTMLElement);
    },
  );

  it('a page that brings its own top bar (invite, onboarding) already has the menu: no corner', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const { container } = render(
      <ExternalShell topBar={<span>Brand</span>}>
        <p>Body</p>
      </ExternalShell>,
    );
    expect(slot(container)).toBeNull();
  });

  it('a column inside a layout that draws the page gets no corner of its own (that layout draws it: app/r/layout.tsx)', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const { container } = render(
      <ExternalShell frame="column" as="div">
        <p>Body</p>
      </ExternalShell>,
    );
    expect(slot(container)).toBeNull();
  });

  it('off: the frame is today’s markup exactly', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    const off = render(
      <ExternalShell poweredBy>
        <p>Body</p>
      </ExternalShell>,
    ).container.innerHTML;
    expect(off).not.toContain('external-appearance');
    expect(off).not.toContain('data-glass-only');
  });
});

describe('ExternalShell: the page root a Liquid Glass composition is scoped to', () => {
  const root = (container: HTMLElement) =>
    container.querySelector('[data-slot="external-shell"]') as HTMLElement;

  it('a page that names its composition (invite, onboarding: pages/access.css) gets the inert data-glass-page hook on the frame root', () => {
    const { container } = render(
      <ExternalShell glassPage="access" topBar={<span>Brand</span>}>
        <p>Body</p>
      </ExternalShell>,
    );
    expect(root(container)).toHaveAttribute('data-glass-page', 'access');
  });

  it('without it the frame carries no hook, and with it nothing else changes', () => {
    const plain = render(
      <ExternalShell topBar={<span>Brand</span>}>
        <p>Body</p>
      </ExternalShell>,
    ).container;
    expect(root(plain).hasAttribute('data-glass-page')).toBe(false);
    const hooked = render(
      <ExternalShell glassPage="access" topBar={<span>Brand</span>}>
        <p>Body</p>
      </ExternalShell>,
    ).container;
    root(hooked).removeAttribute('data-glass-page');
    expect(hooked.innerHTML).toBe(plain.innerHTML);
  });

  it('the invite and onboarding pages name pages/access.css, and import it themselves', () => {
    const app = join(__dirname, '..', '..', 'app');
    for (const page of [
      join(app, 'invite', '[token]', 'page.tsx'),
      join(app, 'onboarding', 'page.tsx'),
    ]) {
      const source = readFileSync(page, 'utf8');
      expect(source.match(/<ExternalShell\b/g), page).toHaveLength(1);
      expect(source, page).toMatch(/<ExternalShell\s+glassPage="access"/);
      expect(source, page).toContain("import '@/styles/liquid-glass/pages/access.css';");
    }
  });
});

describe('ExternalHeader, ExternalCard and ExternalStatusCard', () => {
  it('the header is the page h1 with its eyebrow and line', () => {
    render(
      <ExternalHeader
        eyebrow="StockPilot"
        title="Track your order"
        description="Enter the email."
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Track your order' })).toBeInTheDocument();
    expect(screen.getByText('StockPilot')).toBeInTheDocument();
    expect(screen.getByText('Enter the email.')).toBeInTheDocument();
  });

  it('a card title is an h2 by default, or the level the page asks for', () => {
    const { rerender } = render(<ExternalCard title="Items">x</ExternalCard>);
    expect(screen.getByRole('heading', { level: 2, name: 'Items' })).toBeInTheDocument();
    rerender(
      <ExternalCard title="Items" headingLevel={3}>
        x
      </ExternalCard>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Items' })).toBeInTheDocument();
  });

  it('a status card is the page h1 with its own words and at most one action', () => {
    render(
      <ExternalStatusCard
        eyebrow="Return request"
        title="Too many requests"
        body="Wait a while."
        action={<a href="#track">Track</a>}
      />,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Too many requests' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Wait a while.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Track' })).toHaveAttribute('href', '#track');
  });
});
