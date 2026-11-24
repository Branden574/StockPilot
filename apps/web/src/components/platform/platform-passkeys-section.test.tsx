import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Passkeys section of the platform console (plan section 4, "the
 * platform Security page"): the two platform-wide switches with their help,
 * the organizations that have passkeys on (when, how many members hold one,
 * Turn off), and Turn on for an organization found by name. Every read that
 * fails is said, never shown as "off". Default everything OFF: a missing
 * settings row reads Off.
 */

const ORG_A = '0b000000-0000-4000-8000-000000000001';
const ORG_B = '0b000000-0000-4000-8000-000000000002';
const ORG_C = '0b000000-0000-4000-8000-000000000003';

const h = vi.hoisted(() => ({
  read: vi.fn(),
  choices: vi.fn(),
}));

vi.mock('@/server/services/platform/passkey-switches', () => ({
  readPasskeyConsole: () => h.read(),
  listOrganizationsForPasskeys: () => h.choices(),
  PASSKEY_ORGANIZATION_CHOICES_CAP: 2000,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/components/auth/step-up-modal', () => ({
  useStepUp: () => ({ ensure: vi.fn(), modal: null }),
}));
vi.mock('@/server/actions/platform/passkeys', () => ({
  setPasskeysKillSwitchAction: vi.fn(),
  setNewPasskeysSwitchAction: vi.fn(),
  setOrganizationPasskeysAction: vi.fn(),
}));

import { formatExactUtc } from '@/lib/platform/last-active';

import { PlatformPasskeysSection } from './platform-passkeys-section';

async function renderSection() {
  render(await PlatformPasskeysSection());
}

beforeEach(() => {
  vi.clearAllMocks();
  h.read.mockResolvedValue({
    switches: { passkeysOn: false, passkeyAddsOn: false, rowExists: false },
    organizations: [],
  });
  h.choices.mockResolvedValue({
    organizations: [
      { id: ORG_A, name: 'Example Academy' },
      { id: ORG_B, name: 'Sample Schools' },
      { id: ORG_C, name: 'Sample Charter' },
    ],
    capped: false,
  });
});

function switchRow(name: string): HTMLElement {
  return screen.getByRole('group', { name });
}

describe('PlatformPasskeysSection', () => {
  it('everything off by default: both switches read Off with Turn on, and their help', async () => {
    await renderSection();
    expect(screen.getByRole('heading', { name: 'Passkeys' })).toBeInTheDocument();
    const everyone = switchRow('Passkeys for everyone');
    expect(within(everyone).getByText('Off')).toBeInTheDocument();
    expect(within(everyone).getByRole('button', { name: 'Turn on' })).toBeInTheDocument();
    expect(everyone).toHaveTextContent(
      'When off, nobody can add or use a passkey. Members whose only second step is a passkey must use a recovery code.',
    );
    const adds = switchRow('New passkeys');
    expect(within(adds).getByText('Off')).toBeInTheDocument();
    expect(adds).toHaveTextContent(
      'When off, nobody can add a passkey. Passkeys already added keep working while passkeys for everyone are on.',
    );
    expect(screen.getByText('No organization has passkeys on.')).toBeInTheDocument();
  });

  it('shows On with Turn off for a switch that is on', async () => {
    h.read.mockResolvedValue({
      switches: { passkeysOn: true, passkeyAddsOn: false, rowExists: true },
      organizations: [],
    });
    await renderSection();
    expect(
      within(switchRow('Passkeys for everyone')).getByRole('button', { name: 'Turn off' }),
    ).toBeInTheDocument();
    expect(
      within(switchRow('New passkeys')).getByRole('button', { name: 'Turn on' }),
    ).toBeInTheDocument();
  });

  it('a settings read that failed says so and offers no platform-wide button', async () => {
    h.read.mockResolvedValue({ switches: null, organizations: [] });
    await renderSection();
    expect(
      screen.getByText('Could not read the passkey switches. Reload this page to try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Passkeys for everyone' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'New passkeys' })).toBeNull();
  });

  it('lists the organizations with passkeys on: name, when (UTC), members with passkeys, Turn off', async () => {
    h.read.mockResolvedValue({
      switches: { passkeysOn: true, passkeyAddsOn: true, rowExists: true },
      organizations: [
        {
          id: ORG_A,
          name: 'Example Academy',
          switchedOnAt: '2026-11-20T17:05:00Z',
          membersWithPasskeys: 4,
        },
        { id: ORG_B, name: null, switchedOnAt: '2026-11-19T09:00:00Z', membersWithPasskeys: null },
      ],
    });
    await renderSection();
    const table = screen.getByRole('region', { name: 'Organizations with passkeys on' });
    const [, first, second] = within(table).getAllByRole('row') as HTMLElement[];
    expect(within(first!).getByRole('link', { name: 'Example Academy' })).toHaveAttribute(
      'href',
      `/platform/orgs/${ORG_A}`,
    );
    // Shown on the security pages' 12-hour clock (no zone chosen: UTC); the exact UTC in its title.
    expect(first).toHaveTextContent('20 Nov 2026, 5:05 PM UTC');
    expect(first!.querySelector('time')).toHaveAttribute(
      'title',
      formatExactUtc('2026-11-20T17:05:00Z')!,
    );
    expect(formatExactUtc('2026-11-20T17:05:00Z')).toContain('UTC');
    expect(first).toHaveTextContent('4');
    expect(within(first!).getByRole('button', { name: 'Turn off' })).toBeInTheDocument();
    // A name that could not be read falls back to the id; a count that could not be read says so.
    expect(second).toHaveTextContent(ORG_B);
    expect(second).toHaveTextContent('Unknown');
    expect(
      screen.getByText(
        /A member can add a passkey only when every organization they belong to has passkeys on/,
      ),
    ).toBeInTheDocument();
  });

  it('the organizations table sits straight on the page, as every console table does: never inside the section card', async () => {
    h.read.mockResolvedValue({
      switches: { passkeysOn: true, passkeyAddsOn: true, rowExists: true },
      organizations: [
        {
          id: ORG_A,
          name: 'Example Academy',
          switchedOnAt: '2026-11-20T17:05:00Z',
          membersWithPasskeys: 1,
        },
      ],
    });
    await renderSection();
    const table = screen.getByRole('region', { name: 'Organizations with passkeys on' });
    expect(table).toHaveAttribute('data-glass', 'card');
    // No frosted card or panel around the table's own card.
    expect(table.parentElement?.closest('[data-glass]')).toBeNull();
    // The switches stay in the section's card.
    const panel = screen.getByRole('heading', { name: 'Passkeys' }).closest('[data-glass="panel"]');
    expect(panel).not.toBeNull();
    expect(panel).toContainElement(switchRow('Passkeys for everyone'));
    expect(panel).not.toContainElement(table);
  });

  it('a switch-row read that failed says so', async () => {
    h.read.mockResolvedValue({
      switches: { passkeysOn: false, passkeyAddsOn: false, rowExists: false },
      organizations: null,
    });
    await renderSection();
    expect(
      screen.getByText(
        'Could not read which organizations have passkeys on. Reload this page to try again.',
      ),
    ).toBeInTheDocument();
  });

  it('Turn on for an organization: found by name, never one already on, nothing listed before typing', async () => {
    h.read.mockResolvedValue({
      switches: { passkeysOn: true, passkeyAddsOn: true, rowExists: true },
      organizations: [
        {
          id: ORG_B,
          name: 'Sample Schools',
          switchedOnAt: '2026-11-20T17:05:00Z',
          membersWithPasskeys: 0,
        },
      ],
    });
    await renderSection();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const finder = screen.getByRole('group', { name: 'Turn on for an organization' });
    expect(within(finder).queryAllByRole('button', { name: 'Turn on' })).toHaveLength(0);
    await user.type(within(finder).getByLabelText('Find an organization'), 'sample');
    const offered = within(finder).getAllByRole('listitem');
    expect(offered).toHaveLength(1);
    expect(offered[0]).toHaveTextContent('Sample Charter');
    expect(within(offered[0]!).getByRole('button', { name: 'Turn on' })).toBeInTheDocument();
    await user.clear(within(finder).getByLabelText('Find an organization'));
    await user.type(within(finder).getByLabelText('Find an organization'), 'nothing like it');
    expect(within(finder).getByText('No organization matches.')).toBeInTheDocument();
  });

  it('an organization list that could not be loaded says so', async () => {
    h.choices.mockResolvedValue(null);
    await renderSection();
    expect(
      screen.getByText('Could not load the organizations. Reload this page to try again.'),
    ).toBeInTheDocument();
  });
});
