import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /onboarding on the shared external frame and the auth card (P5.1): every
 * field and default kept, and a user who already belongs to a workspace still
 * goes straight to the dashboard.
 */

let membership: { organization_id: string } | null = null;

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: 'user-1', email: 'owner@example.test' }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          not: () => ({ limit: () => ({ maybeSingle: async () => ({ data: membership }) }) }),
        }),
      }),
    }),
  }),
}));
class Redirect extends Error {}
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  useRouter: () => ({ replace, refresh: vi.fn() }),
}));
vi.mock('@/server/actions/organization', () => ({ createOrganizationAction: vi.fn() }));
vi.mock('@/components/theme/theme-toggle', () => ({
  ThemeToggle: () => <button type="button">Theme</button>,
}));

import OnboardingPage from './page';

beforeEach(() => {
  membership = null;
});

describe('/onboarding', () => {
  it('draws the card with every field and its default', async () => {
    render(await OnboardingPage());
    expect(
      screen.getByRole('heading', { level: 1, name: 'Create your workspace' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "We'll set you up with a default location so you can start adding inventory right away.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Workspace name')).toHaveAttribute('placeholder', 'Acme Co.');
    const industry = screen.getByLabelText('Industry') as HTMLSelectElement;
    expect(industry.options).toHaveLength(12);
    const size = screen.getByLabelText('Team size') as HTMLSelectElement;
    expect(Array.from(size.options).map((o) => o.textContent)).toEqual([
      'Select…',
      'Just me',
      '2-5',
      '6-25',
      '26-100',
      '100+',
    ]);
    expect((screen.getByLabelText('Timezone') as HTMLInputElement).value).not.toBe('');
    expect(screen.getByLabelText('Currency')).toHaveValue('USD');
    expect(screen.getByRole('button', { name: 'Create workspace' })).toHaveAttribute(
      'type',
      'submit',
    );
    expect(screen.getByRole('button', { name: 'Theme' })).toBeInTheDocument();
  });

  it('sends a member of a workspace to the dashboard', async () => {
    membership = { organization_id: 'org-1' };
    await expect(OnboardingPage()).rejects.toThrow('/dashboard');
  });
});
