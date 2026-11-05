import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen, within } from '@testing-library/react';
import postcss, { type Rule } from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/theme/theme-toggle', () => ({
  ThemeToggle: () => (
    <button type="button" id="theme-toggle-trigger">
      Toggle theme
    </button>
  ),
}));
vi.mock('@/components/auth/auth-stage', () => ({ AuthStage: () => null }));

import AuthLayout from './layout';

/**
 * The glass-only parts of the sign-in shell (Auth-SignIn.dc.html: "Contact the
 * team" in the top bar, Security among the help links). Each opens a public
 * page, exists only where the build offers Liquid Glass, and can never show in
 * classic: visibility.css hides [data-glass-only] in layer lg, so no classic
 * rule of auth.css (unlayered, it would win) may give them a display.
 * Markup parity in classic: auth-layout.classic-parity.test.tsx.
 */

const AUTH_CSS = readFileSync(join(__dirname, 'auth.css'), 'utf8');
const ALLOWLIST = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', 'tests', 'e2e', 'appearance', 'glass-only-allowlist.json'),
    'utf8',
  ),
) as {
  kinds: Record<string, string>;
  entries: { id: string; source: string; kind: string; routes: string[]; selector: string }[];
};

function renderShell() {
  return render(
    <AuthLayout>
      <p>page</p>
    </AuthLayout>,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the sign-in shell in a build with Liquid Glass', () => {
  for (const rollout of ['opt-in', 'default'] as const) {
    it(`${rollout}: the top bar holds "Contact the team" (/contact), glass-only, after the appearance menu`, () => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      renderShell();
      const banner = screen.getByRole('banner');
      const contact = within(banner).getByRole('link', { name: 'Contact the team' });
      expect(contact).toHaveAttribute('href', '/contact');
      expect(contact).toHaveAttribute('data-glass-only');
      const trigger = within(banner).getByRole('button', { name: 'Toggle theme' });
      expect(
        trigger.compareDocumentPosition(contact) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it(`${rollout}: the help links keep Support, Privacy and Terms in their order, and add Security (/security) in a glass-only span`, () => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      renderShell();
      const help = screen.getByRole('navigation', { name: 'Help' });
      const links = within(help).getAllByRole('link');
      expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
        ['Support', '/support'],
        ['Privacy', '/privacy'],
        ['Terms', '/terms'],
        ['Security', '/security'],
      ]);
      const security = links[3]!;
      expect(security.parentElement).toHaveAttribute('data-glass-only');
      expect(security.parentElement?.tagName).toBe('SPAN');
      for (const link of links.slice(0, 3)) {
        expect(link.closest('[data-glass-only]')).toBeNull();
      }
    });
  }

  it('off: neither glass-only link is rendered', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    const { container } = renderShell();
    expect(container.querySelector('[data-glass-only]')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Contact the team' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Security' })).toBeNull();
  });

  it('no classic rule of auth.css (unlayered) can give a glass-only element a display', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const { container } = renderShell();
    const glassOnly = [...container.querySelectorAll<HTMLElement>('[data-glass-only]')];
    expect(glassOnly).toHaveLength(2);
    const offenders: string[] = [];
    postcss.parse(AUTH_CSS).walkRules((rule: Rule) => {
      if (!rule.some((n) => n.type === 'decl' && n.prop === 'display')) return;
      for (const raw of rule.selectors) {
        // State pseudo-classes and pseudo-elements do not change which element matches.
        const selector = raw.replace(/::?[a-z-]+(\([^)]*\))?/gu, '').trim();
        if (!selector) continue;
        for (const el of glassOnly) {
          if (el.matches(selector)) offenders.push(`${raw} -> ${el.outerHTML.slice(0, 60)}`);
        }
      }
    });
    expect(offenders).toEqual([]);
  });

  it('both are on the 8.5 glass-only allowlist, as public page links on the sign-in routes', () => {
    const entries = ALLOWLIST.entries.filter(
      (e) => e.source === 'apps/web/src/app/(auth)/layout.tsx',
    );
    expect(entries.map((e) => e.id).sort()).toEqual([
      'auth-contact-the-team',
      'auth-help-security',
    ]);
    for (const entry of entries) {
      expect(entry.kind).toBe('public page link (no data action)');
      expect(entry.routes).toEqual([
        '/signin',
        '/signin/mfa',
        '/signup',
        '/reset',
        '/reset/complete',
        '/account-disabled',
      ]);
    }
    expect(ALLOWLIST.kinds).toHaveProperty(['public page link (no data action)']);
  });
});
