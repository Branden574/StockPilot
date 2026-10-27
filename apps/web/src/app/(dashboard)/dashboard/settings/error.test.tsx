import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B9: Settings had no error boundary of its own, so one settings page that
 * failed to read (a throwing server read) rose to the dashboard's boundary,
 * which replaced the whole settings area, its sub-nav included, with
 * "Something broke loading this page". This boundary sits below the settings
 * layout: the sub-nav stays, and only the page's column says the page could
 * not be read, with the error id and Try again.
 */

const reported = vi.hoisted(() => ({ calls: [] as unknown[][] }));
// The boundary reports through the isomorphic core: it is a client
// component, and @/lib/error-reporter is server-only.
vi.mock('@/lib/error-reporter-core', () => ({
  reportError: vi.fn(async (...args: unknown[]) => {
    reported.calls.push(args);
  }),
}));
const path = vi.hoisted(() => ({ current: '/dashboard/settings/organization' }));
vi.mock('next/navigation', () => ({ usePathname: () => path.current }));

import SettingsError from './error';

beforeEach(() => {
  reported.calls = [];
  path.current = '/dashboard/settings/organization';
});

describe('the settings error boundary', () => {
  it("keeps the page's title and the way back, says the page could not be read, and Try again reads it again", async () => {
    const retry = vi.fn();
    const error = Object.assign(new Error('boom'), { digest: 'abc123' });
    const { container } = render(<SettingsError error={error} retry={retry} />);

    // Drawn in the settings column, under the page's own title.
    expect(container.querySelector('[data-slot="settings-page"]')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Organization' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Back to settings' })).toHaveAttribute(
      'href',
      '/dashboard/settings',
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-state-kind', 'failed');
    expect(alert).toHaveTextContent("We couldn't load this settings page");
    expect(alert).toHaveTextContent('The other settings pages still work.');
    expect(alert).toHaveTextContent('Error id: abc123');
    // Never the thrown message itself.
    expect(alert).not.toHaveTextContent('boom');

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(reported.calls[0]?.[0]).toBe(error);
    expect(reported.calls[0]?.[1]).toMatchObject({
      tag: 'settings.render',
      extra: { digest: 'abc123', path: '/dashboard/settings/organization' },
    });
  });

  it('names a nested page by the settings entry it belongs to', () => {
    path.current = '/dashboard/settings/migrate/sage50';
    render(<SettingsError error={new Error('boom')} retry={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Integrations' })).toBeInTheDocument();
  });

  it('on the settings hub: no back link and no "other pages" line (the hub is the index)', () => {
    path.current = '/dashboard/settings';
    render(<SettingsError error={new Error('boom')} retry={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '← Back to settings' })).toBeNull();
    expect(screen.getByRole('alert')).not.toHaveTextContent('The other settings pages still work.');
  });

  it('falls back to reset, prints no error id without a digest, and takes a thrown non-Error', async () => {
    const reset = vi.fn();
    render(<SettingsError error="a thrown string" reset={reset} />);
    expect(screen.getByRole('alert')).not.toHaveTextContent('Error id');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reported.calls[0]?.[1]).toMatchObject({ extra: { digest: null } });
  });
});
