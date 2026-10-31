import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { isStorableOrgTimezone, resolveOrgTimezone } from '@stockpilot/core';

// Radix Select needs pointer-capture APIs happy-dom doesn't implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/organization', () => ({
  updateOrgTimezoneAction: vi.fn(async () => ({ ok: true, data: undefined })),
}));

import { ORG_TIMEZONE_OPTIONS } from '@/lib/timezone-options';
import { updateOrgTimezoneAction } from '@/server/actions/organization';

import { OrgTimezoneEditor } from './org-timezone-editor';

/**
 * THE WORKSPACE TIME ZONE EDITOR SHOWS THE STORED ZONE (B41).
 *
 * It showed "UTC (no offset)" for any stored zone outside its list of 20,
 * while the rest of the app used the stored zone (core resolveOrgTimezone).
 * And because UTC was then the editor's starting value, choosing UTC left
 * Save disabled: an admin could not switch such a workspace to UTC.
 */

const trigger = () => screen.getByRole('combobox', { name: 'Workspace timezone' });
const save = () => screen.getByRole('button', { name: 'Save timezone' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OrgTimezoneEditor', () => {
  it('a listed zone is shown as itself', () => {
    render(<OrgTimezoneEditor current="America/Chicago" />);
    expect(trigger()).toHaveTextContent('Central Time — Chicago');
    expect(save()).toBeDisabled();
    expect(screen.queryByText(/Choose one and save/)).not.toBeInTheDocument();
  });

  it('a zone outside the list is shown as itself with its offset, not as UTC', () => {
    render(<OrgTimezoneEditor current="America/Indiana/Indianapolis" />);
    // Eastern: UTC−05:00, or UTC−04:00 in daylight time. The time there now
    // follows the label, as for every option.
    expect(trigger()).toHaveTextContent(/^America\/Indiana\/Indianapolis \(UTC−0[45]:00\)/);
    expect(trigger()).not.toHaveTextContent('UTC (no offset)');
    expect(save()).toBeDisabled();
    expect(screen.queryByText(/Choose one and save/)).not.toBeInTheDocument();
  });

  it('writes the offset with its minutes and its sign', () => {
    // No daylight time in Kolkata, so the label never changes.
    render(<OrgTimezoneEditor current="Asia/Kolkata" />);
    expect(trigger()).toHaveTextContent('Asia/Kolkata (UTC+05:30)');
  });

  it('from a zone outside the list, choosing UTC enables Save and sends UTC', async () => {
    const user = userEvent.setup();
    render(<OrgTimezoneEditor current="America/Indiana/Indianapolis" />);
    await user.click(trigger());
    // The stored zone stays offered while it is the stored one.
    expect(
      await screen.findByRole('option', {
        name: /America\/Indiana\/Indianapolis \(UTC−0[45]:00\)/,
      }),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: /UTC \(no offset\)/ }));
    expect(save()).toBeEnabled();
    await user.click(save());
    await waitFor(() => expect(updateOrgTimezoneAction).toHaveBeenCalledWith({ timezone: 'UTC' }));
    expect(refresh).toHaveBeenCalled();
  });

  it('choosing the stored zone again leaves nothing to save', async () => {
    const user = userEvent.setup();
    render(<OrgTimezoneEditor current="America/Indiana/Indianapolis" />);
    await user.click(trigger());
    await user.click(await screen.findByRole('option', { name: /UTC \(no offset\)/ }));
    await user.click(trigger());
    await user.click(
      await screen.findByRole('option', {
        name: /America\/Indiana\/Indianapolis \(UTC−0[45]:00\)/,
      }),
    );
    expect(save()).toBeDisabled();
  });

  it('an unusable stored zone shows the zone the app uses, says why, and lets the admin save', async () => {
    const user = userEvent.setup();
    render(<OrgTimezoneEditor current="Mars/Olympus" />);
    // What the app renders in for that value (core's fallback).
    expect(resolveOrgTimezone('Mars/Olympus')).toBe('America/Los_Angeles');
    expect(trigger()).toHaveTextContent('Pacific Time — Los Angeles');
    expect(
      screen.getByText(
        "Your workspace's saved time zone, Mars/Olympus, is not a time zone name, so the app uses Pacific Time. Choose one and save.",
      ),
    ).toBeInTheDocument();
    expect(save()).toBeEnabled();
    await user.click(save());
    await waitFor(() =>
      expect(updateOrgTimezoneAction).toHaveBeenCalledWith({ timezone: 'America/Los_Angeles' }),
    );
  });

  it('a blank stored zone says so without quoting it', () => {
    render(<OrgTimezoneEditor current="   " />);
    expect(trigger()).toHaveTextContent('Pacific Time — Los Angeles');
    expect(
      screen.getByText(
        "Your workspace's saved time zone is not a time zone name, so the app uses Pacific Time. Choose one and save.",
      ),
    ).toBeInTheDocument();
    expect(save()).toBeEnabled();
  });

  // The page passes null only when its read of the organization row failed:
  // the stored zone is unknown. The editor shows the zone the app uses when it
  // has none, claims nothing about the stored one, and invites no save of a
  // value nobody chose.
  it('with no zone read, shows the zone the app falls back to and offers nothing to save', () => {
    render(<OrgTimezoneEditor current={null} />);
    expect(trigger()).toHaveTextContent('Pacific Time — Los Angeles');
    expect(save()).toBeDisabled();
    expect(screen.queryByText(/Choose one and save/)).not.toBeInTheDocument();
  });

  // Intl accepts EST5EDT, so the web and the phone use it, but the Book Order
  // Totals report's SQL tries only UTC, GMT or an Area/Location name and uses
  // Pacific instead. The editor shows the zone the app uses, says which report
  // differs, and saves only a zone from the list.
  it('a zone the app uses but the report does not is shown as itself, with the report named', async () => {
    const user = userEvent.setup();
    render(<OrgTimezoneEditor current="EST5EDT" />);
    expect(trigger()).toHaveTextContent(/^EST5EDT \(UTC−0[45]:00\)/);
    expect(
      screen.getByText(
        "Your workspace's saved time zone, EST5EDT, is not a full time zone name such as America/Chicago, so Book Order Totals uses Pacific Time. Choose one and save.",
      ),
    ).toBeInTheDocument();
    // The shown zone is not one the server takes (Settings saves only listed
    // zones), so Save waits for a choice from the list.
    expect(save()).toBeDisabled();
    await user.click(trigger());
    await user.click(await screen.findByRole('option', { name: /Eastern Time — New York/ }));
    expect(save()).toBeEnabled();
    await user.click(save());
    await waitFor(() =>
      expect(updateOrgTimezoneAction).toHaveBeenCalledWith({ timezone: 'America/New_York' }),
    );
  });

  it('a listed zone saved with spaces around it is the listed zone', () => {
    render(<OrgTimezoneEditor current=" America/Chicago " />);
    expect(trigger()).toHaveTextContent('Central Time — Chicago');
    expect(save()).toBeDisabled();
  });

  it('the list offers only zones the create check also accepts', () => {
    for (const zone of ORG_TIMEZONE_OPTIONS) expect(isStorableOrgTimezone(zone), zone).toBe(true);
  });
});
