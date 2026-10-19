import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ state: vi.fn() }));

vi.mock('@/lib/onboarding/actions', () => ({ getTourStateAction: () => h.state() }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { TOUR_ROUTES, WORKFLOW_GUIDES } from '@/lib/onboarding/workflows';
import { SUPPORT_EMAIL } from '@/lib/site';

import HelpPage, { ALL_TOURS } from './page';

beforeEach(() => {
  vi.clearAllMocks();
  h.state.mockResolvedValue({ completed: { dashboard: true, 'ai-assistant': true } });
});

describe('Help & Learning', () => {
  it('lists every tour in ALL_TOURS order with its steps and replay link', async () => {
    render(await HelpPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Help & Learning' })).toBeInTheDocument();
    const tours = screen.getByRole('heading', { name: 'Page tours' }).closest('section')!;
    const rows = within(tours).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-tour-id'))).toEqual(ALL_TOURS.map((t) => t.id));
    ALL_TOURS.forEach((t, i) => {
      const row = rows[i]!;
      expect(row).toHaveTextContent(t.name);
      expect(row).toHaveTextContent(`${t.steps.length} steps`);
      const route = TOUR_ROUTES[t.id];
      if (route) {
        expect(within(row).getByRole('link', { name: 'Start →' })).toHaveAttribute(
          'href',
          `${route}?tour=${t.id}`,
        );
      } else {
        expect(within(row).getByText('Via the Tour pill on any record')).toBeInTheDocument();
      }
    });
  });

  it('checks the completed tours, and only those', async () => {
    render(await HelpPage());
    const done = screen.getAllByLabelText('Completed');
    expect(done).toHaveLength(2);
    expect(done[0]!.closest('li')).toHaveAttribute('data-tour-id', 'dashboard');
    expect(done[1]!.closest('li')).toHaveAttribute('data-tour-id', 'ai-assistant');
  });

  it('keeps the workflow guides as disclosures with their step links', async () => {
    const { container } = render(await HelpPage());
    const details = container.querySelectorAll('details');
    expect(details).toHaveLength(WORKFLOW_GUIDES.length);
    WORKFLOW_GUIDES.forEach((g, i) => {
      const d = details[i]!;
      expect(d.open).toBe(false);
      expect(d.querySelector('summary')).toHaveTextContent(g.name);
      const links = g.steps.filter((s) => s.href);
      expect(within(d as HTMLElement).getAllByRole('link', { hidden: true })).toHaveLength(
        links.length,
      );
    });
  });

  it('links the release history, the shortcuts and the support email', async () => {
    render(await HelpPage());
    expect(screen.getByRole('link', { name: /Release history/ })).toHaveAttribute(
      'href',
      '/dashboard/whats-new',
    );
    expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: SUPPORT_EMAIL })).toHaveAttribute(
      'href',
      `mailto:${SUPPORT_EMAIL}`,
    );
  });
});
