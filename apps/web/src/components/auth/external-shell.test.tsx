import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ExternalCard, ExternalHeader, ExternalShell, ExternalStatusCard } from './external-shell';

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
    expect(imports.sort()).toEqual(['@/lib/utils', 'react']);
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
