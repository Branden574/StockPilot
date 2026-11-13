import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings > Profile and the Liquid Glass rollout (plans/REVISION-DEFAULT.md
 * R5, round 2 finding 7; section 9 item 21). Under `off` the page is
 * origin/main's: no Appearance panel and its own subline. With Liquid Glass
 * in the build the Appearance panel is the one declared classic difference,
 * wrapped in [data-appearance-panel] so the classic parity check can take it
 * out and compare the rest with the baseline. The subline is origin/main's in
 * every rollout.
 */

// The page takes the person from the member's context (requireOrgContext);
// the same person either way.
const person = { userId: '11111111-1111-4111-8111-111111111111', email: 'person@example.test' };
vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => person,
  requireOrgContext: async () => person,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null }) }),
      }),
    }),
  }),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/server/services/email-change', () => ({
  reconcileProfileEmail: vi.fn(async () => {}),
  getEmailChangeStatus: vi.fn(async () => null),
}));
vi.mock('@/components/settings/avatar-uploader', () => ({ AvatarUploader: () => null }));
vi.mock('@/components/settings/profile-name-editor', () => ({ ProfileNameEditor: () => null }));
vi.mock('@/components/settings/email-settings-card', () => ({ EmailSettingsCard: () => null }));
vi.mock('@/components/settings/delete-account-button', () => ({ DeleteAccountButton: () => null }));
vi.mock('@/components/settings/appearance-panel', () => ({
  AppearancePanel: () => <p>the appearance choices</p>,
}));

import { SETTINGS_NAV_GROUPS } from '@/components/settings/settings-nav';

import ProfileSettingsPage from './page';

afterEach(() => {
  vi.unstubAllEnvs();
});

const ORIGIN_SUBLINE = 'Your name, avatar, and sign-in email.';

async function renderPage() {
  return render(await ProfileSettingsPage({ searchParams: Promise.resolve({}) }));
}

describe('Settings > Profile and the appearance', () => {
  it('off: no Appearance panel at all, and origin/main’s subline', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    const { container } = await renderPage();
    expect(screen.queryByRole('heading', { name: 'Appearance' })).toBeNull();
    expect(screen.queryByText('the appearance choices')).toBeNull();
    expect(container.querySelector('[data-appearance-panel]')).toBeNull();
    expect(screen.getByText(ORIGIN_SUBLINE)).toBeInTheDocument();
  });

  it.each(['default', 'opt-in'])(
    '%s: the Appearance panel, wrapped so the parity check can take it out; the subline is still origin/main’s',
    async (rollout) => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      const { container } = await renderPage();
      const wrapper = container.querySelector('[data-appearance-panel]') as HTMLElement;
      expect(wrapper).not.toBeNull();
      // No box of its own: removing it removes exactly the panel.
      expect(wrapper).toHaveClass('contents');
      expect(wrapper.children).toHaveLength(1);
      expect(wrapper.firstElementChild).toHaveAttribute('data-slot', 'settings-panel');
      expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
      expect(wrapper).toContainElement(screen.getByText('the appearance choices'));
      expect(screen.getByText(ORIGIN_SUBLINE)).toBeInTheDocument();
    },
  );

  it('the settings index describes Profile in origin/main’s words', () => {
    const profile = SETTINGS_NAV_GROUPS.flatMap((g) => g.entries).find(
      (item) => item.href === '/dashboard/settings/profile',
    );
    expect(profile?.description).toBe(ORIGIN_SUBLINE);
  });
});
