import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/theme/theme-toggle', () => ({
  ThemeToggle: () => <button type="button">Toggle theme</button>,
}));
vi.mock('@/components/auth/auth-stage', () => ({ AuthStage: () => null }));
vi.mock('@/lib/analytics', () => ({ capture: vi.fn() }));

import AuthLayout from '@/app/(auth)/layout';
import TwinContact from '@/app/(site-glass)/glass-site/contact/page';
import TwinPrivacy from '@/app/(site-glass)/glass-site/privacy/page';
import { AuthCard } from '@/components/auth/auth-card';
import { LandingHero } from '@/components/marketing/glass/landing/hero';
import {
  MobileSection,
  ProductSection,
  RolesSection,
  StorySection,
  WorkflowSection,
} from '@/components/marketing/glass/landing/sections';
import { SiteFooter } from '@/components/marketing/glass/site-footer';
import { SiteNav } from '@/components/marketing/glass/site-nav';
import { cssRules, declaredFor, type CssRule } from '@/styles/liquid-glass/glass-css';

/**
 * The board's values on the site lane's rendered markup, read from the glass
 * stylesheets (stage 3 review, findings 8 to 17): each rule's selector is
 * matched against the real component under the glass root, so a value the
 * board draws and the CSS does not reach fails here.
 *  - landing: the four questions (accent discs, 24 / 30 titles, 15 / 1.55
 *    answers), the How it works and Web & mobile heads (760 and 780 px), the
 *    Inventory & books stage (560 px, the card at 84% / 22 / 26 / sh-3, three
 *    fanned covers), the devices (ink bezels around the page ground at 302 and
 *    392 px, the desk's 34 px bar over a 300 px body, h4 / sm captions), the
 *    type scale (.h3, .h4, .sm) and the hero's calls to action on one row;
 *  - the site's .sm roles: the legal date, the footer's brand line, the
 *    contact note;
 *  - the specular edge on every floating glass and content glass surface;
 *  - the sign-in shell: the help pill 22 px under the card, then the
 *    invite-only line on the same glass;
 *  - the invite and onboarding card: the .h2 title and the 26 px padding.
 * Board sources: Landing.dc.html, SiteFooter.dc.html, Site-Contact.dc.html,
 * Auth-SignIn.dc.html and sp.css.
 */

const site = cssRules('pages/site.css');
const landing = cssRules('pages/landing.css');
const auth = cssRules('auth.glass.css');
const access = cssRules('pages/access.css');
const BOTH = [...site, ...landing];

const value = (el: Element, rules: CssRule[], prop: string) => declaredFor(el, rules, prop);

function Landing({ children }: { children: ReactNode }) {
  return (
    <div data-glass-page="site">
      <main data-glass-page="landing">{children}</main>
    </div>
  );
}

beforeEach(() => {
  document.documentElement.setAttribute('data-appearance', 'liquid-glass');
});
afterEach(() => {
  document.documentElement.removeAttribute('data-appearance');
  vi.unstubAllEnvs();
});

describe('landing: the four questions (finding 9)', () => {
  it('accent discs, 24 / 30 titles and 15 / 1.55 answers', () => {
    const { container } = render(
      <Landing>
        <StorySection />
      </Landing>,
    );
    const items = [...container.querySelectorAll('.lgl-questions > div')];
    expect(items).toHaveLength(4);
    for (const item of items) {
      const disc = item.querySelector('.lgl-step-n')!;
      expect(value(disc, BOTH, 'background-color')).toBe('var(--lg-accent-wash)');
      expect(value(disc, BOTH, 'color')).toBe('var(--lg-accent-text)');
      const title = item.querySelector('h3')!;
      expect(value(title, BOTH, 'font-size')).toBe('24px');
      expect(value(title, BOTH, 'line-height')).toBe('30px');
      const answer = item.querySelector('p')!;
      expect(value(answer, BOTH, 'font-size')).toBe('15px');
      expect(value(answer, BOTH, 'line-height')).toBe('1.55');
    }
  });

  it('the step discs of How it works stay ink (the board overrides only the questions)', () => {
    const { container } = render(
      <Landing>
        <WorkflowSection />
      </Landing>,
    );
    const disc = container.querySelector('.lgl-step .lgl-step-n')!;
    expect(value(disc, BOTH, 'background-color')).toBe('var(--lg-ink)');
  });
});

describe('landing: section heads (finding 10)', () => {
  it('How it works wraps at 760 px and Web & mobile at 780 px', () => {
    for (const [Section, id, width] of [
      [WorkflowSection, 'lgl-wf-h', '760px'],
      [MobileSection, 'lgl-mob-h', '780px'],
    ] as const) {
      const { container, unmount } = render(
        <Landing>
          <Section />
        </Landing>,
      );
      const head = container.querySelector(`#${id}`)!.parentElement!;
      expect(value(head, BOTH, 'max-width'), id).toBe(width);
      unmount();
    }
  });
});

describe('landing: Inventory & books (finding 11)', () => {
  it('a 560 px stage, the card at 84% / 22 / radius 26 / sh-3, and three fanned covers at its bottom right', () => {
    const { container } = render(
      <Landing>
        <ProductSection />
      </Landing>,
    );
    const stage = container.querySelector('.lgl-stage')!;
    expect(value(stage, BOTH, 'min-height')).toBe('560px');
    expect(value(stage, BOTH, 'position')).toBe('relative');
    const card = stage.querySelector('.lgl-item-card')!;
    expect(value(card, BOTH, 'width')).toBe('84%');
    expect(value(card, BOTH, 'padding')).toBe('22px');
    expect(value(card, BOTH, 'border-radius')).toBe('26px');
    expect(value(card, BOTH, 'box-shadow')).toBe('var(--lg-sh-3)');
    const fan = stage.querySelector('.lgl-fan')!;
    expect(fan.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(value(fan, BOTH, 'position')).toBe('absolute');
    expect(value(fan, BOTH, 'right')).toBe('-6px');
    expect(value(fan, BOTH, 'bottom')).toBe('0');
    expect(value(fan, BOTH, 'display')).toBe('flex');
    const covers = [...fan.querySelectorAll('.lgl-cover')];
    expect(covers.map((c) => value(c, BOTH, 'transform'))).toEqual([
      'rotate(-8deg) translate(30px, 10px)',
      'rotate(-2deg) translate(8px, 0)',
      'rotate(6deg) translate(-14px, 6px)',
    ]);
    expect(covers.map((c) => value(c, BOTH, '--lgl-cover'))).toEqual(['150px', '158px', '150px']);
  });
});

describe('landing: Web & mobile devices (finding 12)', () => {
  it('ink bezels around the page ground at the board’s heights, the desk’s bar and body, h4 / sm captions', () => {
    const { container } = render(
      <Landing>
        <MobileSection />
      </Landing>,
    );
    const tablet = container.querySelector('.lgl-ipad-card')!;
    expect(value(tablet, BOTH, 'background-color')).toBe('var(--lg-ink)');
    expect(value(tablet, BOTH, 'padding')).toBe('8px');
    expect(value(tablet, BOTH, 'border-radius')).toBe('26px');
    const screen1 = container.querySelector('.lgl-ipad-grid')!;
    expect(value(screen1, BOTH, 'height')).toBe('302px');
    expect(value(screen1, BOTH, 'background-color')).toBe('var(--lg-bg)');
    expect(value(screen1, BOTH, 'border-radius')).toBe('18px');
    const phone = container.querySelector('.lgl-phone-frame')!;
    expect(value(phone, BOTH, 'border')).toBe('7px solid var(--lg-ink)');
    expect(value(phone, BOTH, 'height')).toBe('406px');
    expect(value(phone, BOTH, 'border-radius')).toBe('34px');
    expect(value(phone, BOTH, 'background-color')).toBe('var(--lg-bg)');
    expect(value(container.querySelector('.lgl-phone-bar')!, BOTH, 'bottom')).toBe('8px');
    const desk = container.querySelector('.lgl-desk-card')!;
    expect(value(desk, BOTH, 'border-radius')).toBe('18px');
    expect(value(desk, BOTH, 'box-shadow')).toBe('var(--lg-sh-2)');
    const bar = container.querySelector('.lgl-bar')!;
    expect(value(bar, BOTH, 'height')).toBe('34px');
    expect(value(bar, BOTH, 'border-bottom')).toBe('1px solid var(--lg-line)');
    expect(value(container.querySelector('.lgl-desk-grid')!, BOTH, 'height')).toBe('300px');
    for (const title of container.querySelectorAll('.lgl-dev-t')) {
      expect([value(title, BOTH, 'font-size'), value(title, BOTH, 'line-height')]).toEqual([
        '14px',
        '20px',
      ]);
    }
    for (const line of container.querySelectorAll('.lgl-dev-d')) {
      expect([value(line, BOTH, 'font-size'), value(line, BOTH, 'line-height')]).toEqual([
        '13px',
        '18px',
      ]);
    }
  });
});

describe('the type scale on the landing and the site (finding 13)', () => {
  const size = (el: Element, rules: CssRule[] = BOTH) => [
    value(el, rules, 'font-size'),
    value(el, rules, 'line-height'),
  ];

  it('facts .h4 / .sm, step titles .h3, role names .h4, the hero note .sm', () => {
    const { container } = render(
      <Landing>
        <LandingHero />
        <WorkflowSection />
        <ProductSection />
        <RolesSection />
      </Landing>,
    );
    for (const el of container.querySelectorAll('.lgl-fact-t')) {
      expect([...size(el), value(el, BOTH, 'font-weight')]).toEqual(['14px', '20px', '600']);
    }
    for (const el of container.querySelectorAll('.lgl-fact-d')) {
      expect(size(el)).toEqual(['13px', '18px']);
    }
    for (const el of container.querySelectorAll('.lgl-step-t')) {
      expect([...size(el), value(el, BOTH, 'font-weight')]).toEqual(['16px', '22px', '600']);
    }
    for (const el of container.querySelectorAll('.lgl-role-name')) {
      expect([...size(el), value(el, BOTH, 'font-weight')]).toEqual(['14px', '20px', '600']);
    }
    expect(size(container.querySelector('.lgl-hero-note')!)).toEqual(['13px', '18px']);
  });

  it('the legal date, the footer’s brand line and the contact note are .sm (13 / 18)', () => {
    const { container } = render(
      <div data-glass-page="site">
        <TwinPrivacy />
        <TwinContact />
        <SiteFooter />
      </div>,
    );
    expect(size(container.querySelector('.lgs-date')!, site)).toEqual(['13px', '18px']);
    for (const el of container.querySelectorAll('.lgs-foot-line')) {
      expect(size(el, site)).toEqual(['13px', '18px']);
    }
    expect(size(container.querySelector('.lgs-note')!, site)).toEqual(['13px', '18px']);
  });
});

describe('landing: the hero’s calls to action at 390 px (finding 14)', () => {
  it('a plain block holding the two buttons with a space, as the board renders them: no full-width flex basis', () => {
    const { container } = render(
      <Landing>
        <LandingHero />
      </Landing>,
    );
    const cta = container.querySelector('.lgl-cta')!;
    expect(value(cta, BOTH, 'display')).toBe('block');
    expect([...cta.childNodes].map((n) => (n.nodeType === 3 ? 'text' : 'el'))).toEqual([
      'el',
      'text',
      'el',
    ]);
    expect(cta.childNodes[1]!.textContent).toBe(' ');
    for (const button of cta.querySelectorAll('a')) {
      for (const rule of BOTH) {
        if (rule.decls.flex === undefined) continue;
        const hit = rule.selectors.some((s) => button.matches(s.replace(/\s+/gu, ' ')));
        expect(hit, `${rule.selectors.join(', ')} gives a call to action a flex basis`).toBe(false);
      }
    }
  });
});

describe('the specular edge on the site lane’s glass (finding 17)', () => {
  const edge = (el: Element, rules: CssRule[], pseudo: '::before' | '::after') =>
    declaredFor(el, rules, 'background', undefined, pseudo);

  it('floating glass (the nav, the open menu, glass pills and buttons) draws the glass edge; content glass the card edge', () => {
    render(
      <div data-glass-page="site">
        <SiteNav active="contact" />
        <TwinContact />
      </div>,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Open menu' })[0]!);
    const nav = document.querySelector('nav.lgs-nav')!;
    const menu = document.getElementById('lgs-site-menu')!;
    expect(edge(nav, site, '::before')).toBe('var(--lg-glass-edge)');
    expect(edge(menu, site, '::before')).toBe('var(--lg-glass-edge)');
    expect(edge(document.querySelector('.lgs-note')!, site, '::before')).toBe(
      'var(--lg-glass-edge)',
    );
    const cards = document.querySelectorAll('.lgs-card');
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expect(edge(card, site, '::after')).toBe('var(--lg-card-edge)');
  });

  it('the sign-in ring, its card, the help pill, the invite-only line and Contact the team; the invite and onboarding card', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const { container } = render(
      <AuthLayout>
        <AuthCard title="Sign in">x</AuthCard>
      </AuthLayout>,
    );
    for (const selector of [
      '.auth-panel-col',
      '.auth-panel-foot nav',
      '.auth-panel-foot p',
      '.auth-glass-contact',
    ]) {
      expect(edge(container.querySelector(selector)!, auth, '::before'), selector).toBe(
        'var(--lg-glass-edge)',
      );
    }
    const card = container.querySelector("[data-slot='auth-card']")!;
    expect(edge(card, auth, '::after')).toBe('var(--lg-card-edge)');
    expect(value(card, auth, 'position')).toBe('relative');

    const { container: invite } = render(
      <div data-glass-page="access">
        <AuthCard title="You're invited">x</AuthCard>
      </div>,
    );
    expect(edge(invite.querySelector("[data-slot='auth-card']")!, access, '::after')).toBe(
      'var(--lg-card-edge)',
    );
  });
});

describe('the invite and onboarding card (finding 15)', () => {
  it('the board’s .h2 title (20 / 26) and 26 px padding with 14 px between header and body', () => {
    const { container } = render(
      <div data-glass-page="access">
        <AuthCard title="You're invited" description="Accept as someone." footer={<span>f</span>}>
          <p>body</p>
        </AuthCard>
      </div>,
    );
    const card = container.querySelector("[data-slot='auth-card']")!;
    const h1 = card.querySelector('h1')!;
    expect([value(h1, access, 'font-size'), value(h1, access, 'line-height')]).toEqual([
      '20px',
      '26px',
    ]);
    expect(value(card.querySelector('header')!, access, 'padding')).toBe('26px 26px 0');
    expect(value(card.querySelector('header + div')!, access, 'padding')).toBe('14px 26px 26px');
    expect(value(card.querySelector('header + div + div')!, access, 'padding')).toBe('16px 26px');
    expect(value(card, access, 'border-radius')).toBe('24px');
  });
});

describe('the sign-in shell: the help pill and the invite-only line (findings 8 and 16)', () => {
  it('the column ends with the card, the pill follows 22 px below it, then the line on the same glass', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const { container } = render(
      <AuthLayout>
        <p>page</p>
      </AuthLayout>,
    );
    const main = container.querySelector('.auth-panel-main')!;
    expect(value(main, auth, 'flex')).toBe('0 0 auto');
    expect(value(main, auth, 'padding')).toBe('12px 16px 0');
    const foot = container.querySelector('.auth-panel-foot')!;
    expect(value(foot, auth, 'flex')).toBe('1 0 auto');
    expect(value(foot, auth, 'padding')).toBe('22px 16px 40px');
    expect(value(foot, auth, 'justify-content')).toBe('flex-start');
    const line = foot.querySelector('p')!;
    const pill = foot.querySelector('nav')!;
    expect(Number(value(line, auth, 'order') ?? 0)).toBeGreaterThan(
      Number(value(pill, auth, 'order') ?? 0),
    );
    expect(value(line, auth, 'background-color')).toBe('var(--lg-glass)');
    expect(value(line, auth, 'backdrop-filter')).toMatch(/blur/u);
    expect(value(pill, auth, 'background-color')).toBe('var(--lg-glass)');
  });
});
