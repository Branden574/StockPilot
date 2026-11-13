import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render } from '@testing-library/react';
import type { Metadata } from 'next';
import type { ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The Liquid Glass marketing twins against their classic pages (plan 4.6 M3,
 * plans/REVISION-DEFAULT.md R8). Search and assistive technology must meet one
 * page at each address, whichever Design serves it:
 *  - metadata: each twin exports exactly its classic page's metadata (title,
 *    description, canonical, Open Graph), and the landing twin, like the
 *    classic landing, exports none (both serve the root layout's); no twin
 *    says noindex;
 *  - structure: the six content twins have the classic page's headings, in
 *    order, level for level; every twin has one h1 and skips no level;
 *  - ways out: every target the classic page and its chrome link to is on
 *    the twin too (a landing section anchor counts as "/", since the glass
 *    landing's sections are its own).
 * The browser half (the rewrites, the cache, no-JS, the head as served):
 * tests/e2e/appearance/twin-*.spec.ts, run by the integrator's lab run.
 */

vi.mock('@/server/actions/support-tickets', () => ({ createSupportTicketAction: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/theme/theme-toggle', () => ({
  ThemeToggle: () => <button type="button">Toggle theme</button>,
}));

import * as ClassicContact from '@/app/(marketing)/contact/page';
import * as ClassicPricing from '@/app/(marketing)/pricing/page';
import * as ClassicPrivacy from '@/app/(marketing)/privacy/page';
import * as ClassicSecurity from '@/app/(marketing)/security/page';
import * as ClassicSupport from '@/app/(marketing)/support/page';
import * as ClassicTerms from '@/app/(marketing)/terms/page';
import { MarketingFooter } from '@/components/marketing/footer';
import { MarketingHeader } from '@/components/marketing/header';
import { SiteFooter } from '@/components/marketing/glass/site-footer';

import * as TwinContact from './contact/page';
import * as TwinLanding from './page';
import * as TwinPricing from './pricing/page';
import * as TwinPrivacy from './privacy/page';
import * as TwinSecurity from './security/page';
import * as TwinSupport from './support/page';
import * as TwinTerms from './terms/page';

interface PageModule {
  default: ComponentType;
  metadata?: Metadata;
}

const PAIRS: Array<[string, PageModule, PageModule]> = [
  ['/contact', ClassicContact, TwinContact],
  ['/pricing', ClassicPricing, TwinPricing],
  ['/privacy', ClassicPrivacy, TwinPrivacy],
  ['/security', ClassicSecurity, TwinSecurity],
  ['/support', ClassicSupport, TwinSupport],
  ['/terms', ClassicTerms, TwinTerms],
];

const HERE = __dirname;
const APP = join(HERE, '..', '..');

function headings(container: HTMLElement): string[] {
  return [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')].map(
    (h) => `${h.tagName.toLowerCase()} ${(h.textContent ?? '').replace(/\s+/gu, ' ').trim()}`,
  );
}

/** A landing section anchor is the landing ("/"); every other target as written. */
function targets(container: HTMLElement): Set<string> {
  return new Set(
    [...container.querySelectorAll('a[href]')].map((a) => {
      const href = a.getAttribute('href') ?? '';
      return href.startsWith('/#') ? '/' : href;
    }),
  );
}

function expectNoSkippedLevel(list: string[]) {
  const levels = list.map((h) => Number(h[1]));
  expect(levels[0]).toBe(1);
  expect(levels.filter((l) => l === 1)).toHaveLength(1);
  for (let i = 1; i < levels.length; i += 1) {
    expect(levels[i]! - levels[i - 1]!, list[i]).toBeLessThanOrEqual(1);
  }
}

describe('metadata: one page at each address', () => {
  for (const [path, classic, twin] of PAIRS) {
    it(`${path}: the twin exports the classic page's metadata, and no noindex`, () => {
      expect(classic.metadata).toBeDefined();
      expect(twin.metadata).toEqual(classic.metadata);
      expect(JSON.stringify(twin.metadata)).not.toMatch(/noindex|nofollow/iu);
    });
  }

  it('/: neither landing exports metadata (both serve the root layout’s)', () => {
    const classicLanding = readFileSync(join(APP, '(marketing)', 'page.tsx'), 'utf8');
    expect(classicLanding).not.toMatch(
      /export (const|async function|function) (metadata|generateMetadata)/u,
    );
    expect((TwinLanding as PageModule).metadata).toBeUndefined();
    expect(Object.keys(TwinLanding)).toEqual(['default']);
  });

  it('the twin layout adds no metadata and no stylesheet of its own', () => {
    const layout = readFileSync(join(HERE, 'layout.tsx'), 'utf8');
    expect(layout).not.toMatch(
      /export (const|async function|function) (metadata|generateMetadata)/u,
    );
    expect(layout).not.toMatch(/\.css['"]/u);
    expect(layout).toMatch(/data-lg-twin=""/u);
    expect(layout).toMatch(/data-glass-page="site"/u);
  });
});

describe('structure: the same headings and ways out', () => {
  for (const [path, classic, twin] of PAIRS) {
    it(`${path}: the twin has the classic page's headings, in order, level for level`, () => {
      const Classic = classic.default;
      const Twin = twin.default;
      const classicList = headings(render(<Classic />).container);
      const twinList = headings(render(<Twin />).container);
      expect(twinList).toEqual(classicList);
      expectNoSkippedLevel(twinList);
    });

    it(`${path}: every target of the classic page and its chrome is on the twin`, () => {
      const Classic = classic.default;
      const Twin = twin.default;
      const classicTargets = targets(
        render(
          <>
            <MarketingHeader />
            <Classic />
            <MarketingFooter />
          </>,
        ).container,
      );
      const twinTargets = targets(
        render(
          <>
            <Twin />
            <SiteFooter />
          </>,
        ).container,
      );
      expect([...classicTargets].filter((t) => !twinTargets.has(t))).toEqual([]);
    });
  }

  it('/: the glass landing has one h1, skips no level, and keeps every way out of the classic landing', () => {
    const Landing = TwinLanding.default;
    const { container } = render(
      <>
        <Landing />
        <SiteFooter />
      </>,
    );
    const list = headings(container);
    expectNoSkippedLevel(list);
    expect(list[0]).toBe('h1 Everything in its place. Every request in view.');
    const found = targets(container);
    // The classic landing's own targets (components/marketing/landing: nav,
    // hero, closing call and footer), the section anchors aside.
    for (const target of [
      '/signin',
      '/dashboard',
      '/contact',
      '/pricing',
      '/support',
      '/security',
      '/privacy',
      '/privacy#california',
      '/terms',
    ]) {
      expect(found.has(target), target).toBe(true);
    }
    // The previews are images: nothing inside them is a control.
    for (const preview of container.querySelectorAll('[role="img"]')) {
      expect(preview.getAttribute('aria-label')).toBe('Product preview with demo data');
      expect(
        preview.querySelectorAll('a, button, input, select, textarea, [tabindex]'),
      ).toHaveLength(0);
    }
  });
});
