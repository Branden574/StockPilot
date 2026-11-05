import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/actions/auth', () => ({
  signInAction: vi.fn(),
  requestPasswordResetAction: vi.fn(),
  completePasswordResetAction: vi.fn(),
}));
vi.mock('@/server/actions/support-tickets', () => ({ createSupportTicketAction: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/support',
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { AuthCard } from '@/components/auth/auth-card';
import { ResetCompleteForm } from '@/components/auth/reset-complete-form';
import { ResetForm } from '@/components/auth/reset-form';
import { SignInForm } from '@/components/auth/sign-in-form';
import { SupportForm } from '@/components/marketing/support-form';
import { cssRules, declaredFor, NO_MEDIA, type CssRule } from '@/styles/liquid-glass/glass-css';

/**
 * The glass look of the site lane's real forms, read from the stylesheets
 * themselves (stage 3 review, findings 5, 6 and 7): each rule's selector is
 * matched against the rendered form under the glass root, so a rule keyed on
 * markup a form does not have (the sign-in form's .auth-field on the reset
 * forms) fails here.
 *  - /signin, /reset and /reset/complete: every text field is the board's
 *    input-lg (44 px, 15 px, radius 12) and every field label 13 / 600; below
 *    640 px each field keeps 16 px so iOS Safari does not zoom on focus;
 *    Remember me is the board's 18 px .cb and its label is not a field label;
 *  - /support: every field (inputs, the details box, the two selects) is
 *    input-lg too, 16 px below 640 px, and Send ticket the accent primary at
 *    44 px; the hidden honeypot is never styled as a field.
 * The browser half (a phone viewport, focus, the computed size):
 * stage3/site-shots and the lab run.
 */

function declared(
  el: Element,
  rules: CssRule[],
  prop: string,
  media: (m: string[]) => boolean = NO_MEDIA,
): string | undefined {
  return declaredFor(el, rules, prop, media);
}

/** Below 640 px: the Input's max-sm (width < 40rem). */
const PHONE = (m: string[]) => m.length === 1 && /width\s*<\s*40rem|max-width:\s*639/u.test(m[0]!);

beforeEach(() => {
  document.documentElement.setAttribute('data-appearance', 'liquid-glass');
});
afterEach(() => {
  document.documentElement.removeAttribute('data-appearance');
});

describe('the sign-in shell’s fields in glass (auth.glass.css)', () => {
  const rules = cssRules('auth.glass.css');
  const FORMS = [
    ['/signin', <SignInForm key="signin" />],
    ['/reset', <ResetForm key="reset" />],
    ['/reset/complete', <ResetCompleteForm key="complete" />],
  ] as const;

  for (const [route, form] of FORMS) {
    it(`${route}: every text field is input-lg (44 px, 15 px, radius 12), 16 px below 640 px, and every field label 13 / 600`, () => {
      const { container } = render(
        <div className="auth-shell">
          <AuthCard title="Title">{form}</AuthCard>
        </div>,
      );
      const fields = [...container.querySelectorAll("input[data-glass='input']")];
      expect(fields.length, route).toBeGreaterThan(0);
      for (const field of fields) {
        const at = `${route} #${field.id}`;
        expect(declared(field, rules, 'height'), at).toBe('44px');
        expect(declared(field, rules, 'font-size'), at).toBe('15px');
        expect(declared(field, rules, 'border-radius'), at).toBe('12px');
        expect(declared(field, rules, 'font-size', PHONE), `${at} below 640 px`).toBe('16px');
      }
      const labels = [...container.querySelectorAll('label[for]')];
      expect(labels.length, route).toBe(fields.length);
      for (const label of labels) {
        expect(declared(label, rules, 'font-size'), label.textContent!).toBe('13px');
        expect(declared(label, rules, 'font-weight'), label.textContent!).toBe('600');
      }
    });
  }

  it('/signin: Remember me is the board’s 18 px .cb, and its label is not drawn as a field label', () => {
    const { container } = render(
      <div className="auth-shell">
        <AuthCard title="Sign in">
          <SignInForm />
        </AuthCard>
      </div>,
    );
    const box = container.querySelector("input[type='checkbox']")!;
    expect(declared(box, rules, 'appearance')).toBe('none');
    expect(declared(box, rules, 'width')).toBe('18px');
    expect(declared(box, rules, 'height')).toBe('18px');
    expect(declared(box, rules, 'border-radius')).toBe('5px');
    expect(declared(box, rules, 'border')).toBe('1.5px solid var(--lg-input-line)');
    const remember = box.closest('label')!;
    expect(declared(remember, rules, 'font-weight')).toBeUndefined();
  });
});

describe('the support form in glass (pages/site.css)', () => {
  const rules = cssRules('pages/site.css');
  function renderSupport() {
    return render(
      <div data-glass-page="site">
        <div className="lgs-support">
          <SupportForm />
        </div>
      </div>,
    );
  }

  it('every field is input-lg (44 px for a line, 15 px, radius 12) and 16 px below 640 px', () => {
    const { container } = renderSupport();
    const fields = [
      ...container.querySelectorAll("input[data-glass='input'], textarea, select"),
    ].filter((el) => el.id !== 'sup-company');
    expect(fields.map((f) => f.id).sort()).toEqual(
      [
        'sup-category',
        'sup-email',
        'sup-message',
        'sup-name',
        'sup-priority',
        'sup-subject',
      ].sort(),
    );
    for (const field of fields) {
      const at = `#${field.id}`;
      if (field.tagName !== 'TEXTAREA') expect(declared(field, rules, 'height'), at).toBe('44px');
      expect(declared(field, rules, 'font-size'), at).toBe('15px');
      expect(declared(field, rules, 'border-radius'), at).toBe('12px');
      expect(declared(field, rules, 'border-color'), at).toBe('var(--lg-input-line)');
      expect(declared(field, rules, 'font-size', PHONE), `${at} below 640 px`).toBe('16px');
    }
  });

  it('the hidden honeypot is never drawn as a field', () => {
    const { container } = renderSupport();
    const honeypot = container.querySelector('#sup-company')!;
    expect(declared(honeypot, rules, 'height')).toBeUndefined();
    expect(declared(honeypot, rules, 'font-size')).toBeUndefined();
  });

  it('Send ticket is the board’s accent primary at 44 px', () => {
    const { container } = renderSupport();
    const send = container.querySelector("button[type='submit']")!;
    expect(send.textContent).toMatch(/Send/u);
    expect(declared(send, rules, 'background-color')).toBe('var(--lg-accent)');
    expect(declared(send, rules, 'color')).toBe('var(--lg-on-accent)');
    expect(declared(send, rules, 'height')).toBe('44px');
    expect(declared(send, rules, 'font-size')).toBe('15px');
    expect(declared(send, rules, 'border-radius')).toBe('12px');
  });
});
