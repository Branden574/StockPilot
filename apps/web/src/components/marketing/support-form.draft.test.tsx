import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The support form's draft across a Design switch (Liquid Glass stage 3,
 * plans/REVISION-DEFAULT.md R8). /support is served by two route trees, the
 * classic page and its glass twin, so choosing the other Design on /support
 * unmounts one SupportForm and mounts the other. What the visitor typed waits
 * in sessionStorage for that one remount:
 *   - written when the form unmounts while the address is still the one it
 *     mounted on (a Design switch or a refresh), never after leaving the page;
 *   - read once by the next form on the same address within two minutes, and
 *     removed as it is read;
 *   - never the honeypot, never after the ticket was sent;
 *   - under the `off` rollout there is no twin, and nothing is stored or read.
 */

const createSupportTicketAction = vi.fn();
vi.mock('@/server/actions/support-tickets', () => ({
  createSupportTicketAction: (...a: unknown[]) => createSupportTicketAction(...a),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { SUPPORT_DRAFT_KEY, SUPPORT_DRAFT_MAX_AGE_MS, SupportForm } from './support-form';

const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;

function type(label: RegExp, value: string) {
  fireEvent.change(field(label), { target: { value } });
}

function fill() {
  type(/^Name/u, 'Sam Example');
  type(/^Email/u, 'sam@example.test');
  fireEvent.change(screen.getByLabelText(/What.s this about/u), { target: { value: 'account' } });
  fireEvent.change(screen.getByLabelText(/^Priority/u), { target: { value: 'high' } });
  type(/^Subject/u, 'Cannot sign in');
  type(/^Details/u, 'The code is refused.');
  fireEvent.change(document.getElementById('sup-company') as HTMLInputElement, {
    target: { value: 'bot fill' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/support');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('SupportForm draft across a Design switch', () => {
  it('keeps what was typed for the form that replaces it on the same address', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const first = render(<SupportForm />);
    fill();
    first.unmount();

    const stored = JSON.parse(window.sessionStorage.getItem(SUPPORT_DRAFT_KEY) ?? 'null');
    expect(stored).toMatchObject({
      path: '/support',
      name: 'Sam Example',
      email: 'sam@example.test',
      category: 'account',
      priority: 'high',
      subject: 'Cannot sign in',
      message: 'The code is refused.',
    });
    expect(JSON.stringify(stored)).not.toContain('bot fill');

    render(<SupportForm />);
    expect(field(/^Name/u).value).toBe('Sam Example');
    expect(field(/^Email/u).value).toBe('sam@example.test');
    expect((screen.getByLabelText(/What.s this about/u) as HTMLSelectElement).value).toBe(
      'account',
    );
    expect((screen.getByLabelText(/^Priority/u) as HTMLSelectElement).value).toBe('high');
    expect(field(/^Subject/u).value).toBe('Cannot sign in');
    expect(field(/^Details/u).value).toBe('The code is refused.');
    expect((document.getElementById('sup-company') as HTMLInputElement).value).toBe('');
    // Read once: a later form starts empty.
    expect(window.sessionStorage.getItem(SUPPORT_DRAFT_KEY)).toBeNull();
  });

  it('works the same under the opt-in rollout', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'opt-in');
    const first = render(<SupportForm />);
    type(/^Subject/u, 'Opt-in draft');
    first.unmount();
    render(<SupportForm />);
    expect(field(/^Subject/u).value).toBe('Opt-in draft');
  });

  it('stores and reads nothing under the off rollout (no twin, no switch)', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    const first = render(<SupportForm />);
    fill();
    first.unmount();
    expect(window.sessionStorage.getItem(SUPPORT_DRAFT_KEY)).toBeNull();

    window.sessionStorage.setItem(
      SUPPORT_DRAFT_KEY,
      JSON.stringify({ path: '/support', savedAt: Date.now(), subject: 'Left over' }),
    );
    render(<SupportForm />);
    expect(field(/^Subject/u).value).toBe('');
    expect(window.sessionStorage.getItem(SUPPORT_DRAFT_KEY)).not.toBeNull();
  });

  it('writes nothing when the form unmounts because the visitor left the page', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const first = render(<SupportForm />);
    type(/^Subject/u, 'Typed, then left');
    window.history.pushState(null, '', '/pricing');
    first.unmount();
    expect(window.sessionStorage.getItem(SUPPORT_DRAFT_KEY)).toBeNull();
  });

  it('writes nothing when nothing was typed', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    render(<SupportForm />).unmount();
    expect(window.sessionStorage.getItem(SUPPORT_DRAFT_KEY)).toBeNull();
  });

  it('ignores and removes a draft older than two minutes', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    expect(SUPPORT_DRAFT_MAX_AGE_MS).toBe(2 * 60 * 1000);
    window.sessionStorage.setItem(
      SUPPORT_DRAFT_KEY,
      JSON.stringify({
        path: '/support',
        savedAt: Date.now() - SUPPORT_DRAFT_MAX_AGE_MS - 1000,
        name: '',
        email: '',
        category: 'bug',
        priority: 'normal',
        subject: 'Too old',
        message: '',
      }),
    );
    render(<SupportForm />);
    expect(field(/^Subject/u).value).toBe('');
    expect(window.sessionStorage.getItem(SUPPORT_DRAFT_KEY)).toBeNull();
  });

  it('ignores a draft written on another address, and a malformed one', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    window.sessionStorage.setItem(
      SUPPORT_DRAFT_KEY,
      JSON.stringify({ path: '/contact', savedAt: Date.now(), subject: 'Elsewhere' }),
    );
    const one = render(<SupportForm />);
    expect(field(/^Subject/u).value).toBe('');
    one.unmount();

    window.sessionStorage.setItem(SUPPORT_DRAFT_KEY, '{not json');
    render(<SupportForm />);
    expect(field(/^Subject/u).value).toBe('');
    expect(window.sessionStorage.getItem(SUPPORT_DRAFT_KEY)).toBeNull();
  });

  it('keeps an unknown category or priority out of the selects', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    window.sessionStorage.setItem(
      SUPPORT_DRAFT_KEY,
      JSON.stringify({
        path: '/support',
        savedAt: Date.now(),
        name: 'Sam Example',
        email: 'sam@example.test',
        category: 'not-a-category',
        priority: 42,
        subject: 'Kept',
        message: 'Kept too',
      }),
    );
    render(<SupportForm />);
    expect(field(/^Subject/u).value).toBe('Kept');
    expect((screen.getByLabelText(/What.s this about/u) as HTMLSelectElement).value).toBe('bug');
    expect((screen.getByLabelText(/^Priority/u) as HTMLSelectElement).value).toBe('normal');
  });

  it('forgets the draft once the ticket is sent', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    createSupportTicketAction.mockResolvedValue({ ok: true, data: { id: 't1' } });
    const view = render(<SupportForm />);
    fill();
    fireEvent.submit(field(/^Subject/u).closest('form')!);
    await waitFor(() => expect(screen.getByText('Ticket received')).toBeTruthy());
    view.unmount();
    expect(window.sessionStorage.getItem(SUPPORT_DRAFT_KEY)).toBeNull();
  });
});
