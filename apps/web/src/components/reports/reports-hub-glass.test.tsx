import { render, screen, within } from '@testing-library/react';
import type * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { REPORT_MODULES, type ReportSlug } from '@/lib/reports/report-access';

import { HUB_FEATURE, HUB_GROUPS, ReportsHubGlass, type HubReport } from './reports-hub-glass';

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/reports',
  useRouter: () => ({ prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const REPORT_SLUGS = Object.keys(REPORT_MODULES) as ReportSlug[];

/** Every report, as the page's own list would hold it. */
const every: HubReport[] = REPORT_SLUGS.map((slug) => ({
  slug,
  name: `Report ${slug}`,
  desc: `What ${slug} shows`,
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the Reports hub in Liquid Glass (Reports.dc.html)', () => {
  it('holds every report once: the feature tile, or one tile in one of the board groups', () => {
    const grouped = [HUB_FEATURE, ...HUB_GROUPS.flatMap((g) => g.slugs)];
    expect([...grouped].sort()).toEqual([...REPORT_SLUGS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('draws the board groups in the board order', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    render(<ReportsHubGlass reports={every} />);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Inventory',
      'Purchasing & cost',
      'Bundles',
      'Lots',
    ]);
  });

  it('each link has the Classic tile target and the name and description for words; decoration is hidden', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    render(<ReportsHubGlass reports={every} />);
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href')).sort()).toEqual(
      every.map((r) => `/dashboard/reports/${r.slug}`).sort(),
    );
    for (const r of every) {
      const link = links.find((a) => a.getAttribute('href') === `/dashboard/reports/${r.slug}`)!;
      expect(link.textContent).toContain(r.name);
      expect(link.textContent).toContain(r.desc);
      // The name a screen reader reads: what is left once decoration goes.
      const words = link.cloneNode(true) as HTMLElement;
      for (const hidden of words.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
      expect(words.textContent).toBe(`${r.name}${r.desc}`);
    }
  });

  it('lists only what the page passes: a module that is off loses its tile and an empty group its heading', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const core = every.filter((r) => r.slug === 'inventory-valuation');
    const view = render(<ReportsHubGlass reports={core} />);
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Inventory',
    ]);
    expect(view.container.querySelector('[data-glass="reports-feature"]')).toBeNull();
  });

  it('is glass-only, and nothing at all under the off rollout', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const on = render(<ReportsHubGlass reports={every} />);
    const root = on.container.querySelector('[data-glass-only]');
    expect(root?.getAttribute('data-glass')).toBe('reports-hub');
    expect(within(root as HTMLElement).getAllByRole('link').length).toBe(every.length);
    on.unmount();

    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    const off = render(<ReportsHubGlass reports={every} />);
    expect(off.container.innerHTML).toBe('');
  });
});
