import { cleanup, render } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlatformPage } from '@/components/platform/platform-page';
import { PlatformTable } from '@/components/platform/platform-table';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/settings/profile',
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { SettingsPage, SettingsPanel } from './settings-nav';

/**
 * Liquid Glass stage 4, admin lane: the inert hooks pages/admin.css and
 * pages/platform.css draw from (the Classic DOM around them is pinned in the
 * *.classic-dom.test.tsx files; this file pins that the hooks are there and
 * sit where the stylesheets look for them).
 */

afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

describe('settings panels and pages', () => {
  it('a form panel names its variant and tone, and its head and body', () => {
    const { container } = render(
      <SettingsPanel title="Profile" description="Your name and photo.">
        <p>Fields</p>
      </SettingsPanel>,
    );
    const panel = container.querySelector('[data-slot="settings-panel"]')!;
    expect(panel.getAttribute('data-glass-variant')).toBe('form');
    expect(panel.getAttribute('data-glass-tone')).toBe('default');
    const [head, body] = Array.from(panel.children);
    expect(head!.getAttribute('data-glass')).toBe('settings-panel-head');
    expect(head!.querySelector('h2')).toHaveTextContent('Profile');
    expect(body!.getAttribute('data-glass')).toBe('settings-panel-body');
  });

  it('a flush danger panel says so', () => {
    const { container } = render(
      <SettingsPanel title="Delete account" tone="danger" flush>
        <ul />
      </SettingsPanel>,
    );
    const panel = container.querySelector('[data-slot="settings-panel"]')!;
    expect(panel.getAttribute('data-glass-variant')).toBe('flush');
    expect(panel.getAttribute('data-glass-tone')).toBe('danger');
  });

  it('a page carries the settings root only when it is drawn outside the frame', () => {
    const { container, rerender } = render(<SettingsPage>Inside the frame</SettingsPage>);
    const page = () => container.querySelector('[data-slot="settings-page"]')!;
    expect(page().hasAttribute('data-glass-page')).toBe(false);
    rerender(<SettingsPage data-glass-page="settings">The hub's error</SettingsPage>);
    expect(page().getAttribute('data-glass-page')).toBe('settings');
  });
});

describe('the shared radio group', () => {
  for (const variant of ['default', 'card'] as const) {
    it(`names its ${variant} look, with each radio straight inside its label`, () => {
      const { container } = render(
        <RadioGroup aria-label="Access" value="allow" variant={variant}>
          <RadioGroupItem value="allow" label="Allow" />
          <RadioGroupItem value="deny" label="Deny" />
        </RadioGroup>,
      );
      const group = container.querySelector('[data-glass="radio-group"]')!;
      expect(group.getAttribute('data-glass-variant')).toBe(variant);
      for (const label of Array.from(group.children)) {
        expect(label.tagName).toBe('LABEL');
        expect(label.querySelector(':scope > [data-glass="radio"]')).not.toBeNull();
      }
    });
  }
  it('names the row look when no variant is passed', () => {
    const { container } = render(
      <RadioGroup aria-label="Access" value="allow">
        <RadioGroupItem value="allow" label="Allow" />
      </RadioGroup>,
    );
    expect(
      container.querySelector('[data-glass="radio-group"]')!.getAttribute('data-glass-variant'),
    ).toBe('default');
  });
});

describe('the platform console body and table', () => {
  it('the page body names its width', () => {
    const { container, rerender } = render(<PlatformPage>Body</PlatformPage>);
    const body = () => container.querySelector('[data-slot="platform-page"]')!;
    expect(body().getAttribute('data-glass-width')).toBe('wide');
    rerender(<PlatformPage width="narrow">Form</PlatformPage>);
    expect(body().getAttribute('data-glass-width')).toBe('narrow');
  });

  it('the table card is a card and its table a table, the card still the keyboard stop', () => {
    const { container } = render(
      <PlatformTable label="Members">
        <tbody>
          <tr>
            <td>Member</td>
          </tr>
        </tbody>
      </PlatformTable>,
    );
    const card = container.querySelector('[data-slot="platform-table"]')!;
    expect(card.getAttribute('data-glass')).toBe('card');
    expect(card.getAttribute('tabindex')).toBe('0');
    expect(card.querySelector(':scope > table')!.getAttribute('data-glass')).toBe('table');
  });
});
