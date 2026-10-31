import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ORG_TIMEZONE_INVALID_MESSAGE } from '@stockpilot/core';

/**
 * THE NEW WORKSPACE FORM'S TIME ZONE (B41).
 *
 * The box defaults to the creator's browser zone and can be typed into. A zone
 * the app or the Book Order Totals report cannot use is now refused by the
 * shared create schema, so the form says so under the box instead of
 * submitting; and a browser zone that would be refused is not offered as the
 * default.
 */

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/organization', () => ({
  createOrganizationAction: vi.fn(async () => ({
    ok: true,
    data: { organizationId: 'org-1', slug: 'example-workspace' },
  })),
}));

import { createOrganizationAction } from '@/server/actions/organization';

import { CreateOrganizationForm } from './create-organization-form';

const zoneBox = () => screen.getByLabelText('Timezone') as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Makes the browser report `zone` as its own. */
function browserZoneIs(zone: string) {
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...real.call(this), timeZone: zone };
  });
}

async function submitWith(timezone: string) {
  const user = userEvent.setup();
  render(<CreateOrganizationForm />);
  await user.type(screen.getByLabelText('Workspace name'), 'Example Workspace');
  await user.clear(zoneBox());
  await user.type(zoneBox(), timezone);
  await user.click(screen.getByRole('button', { name: 'Create workspace' }));
}

describe('CreateOrganizationForm: the time zone', () => {
  it("defaults to the browser's zone when the app can use it", () => {
    browserZoneIs('America/Indiana/Indianapolis');
    render(<CreateOrganizationForm />);
    expect(zoneBox().value).toBe('America/Indiana/Indianapolis');
  });

  it('an unusable browser zone defaults to UTC', () => {
    browserZoneIs('Etc/Unknown');
    render(<CreateOrganizationForm />);
    expect(zoneBox().value).toBe('UTC');
  });

  it('a zone the app cannot use is named under the box and nothing is created', async () => {
    await submitWith('PST');
    expect(await screen.findByText(ORG_TIMEZONE_INVALID_MESSAGE)).toBeInTheDocument();
    expect(zoneBox()).toHaveAttribute('aria-invalid', 'true');
    expect(createOrganizationAction).not.toHaveBeenCalled();
  });

  it('a valid zone outside the settings list is sent as typed', async () => {
    await submitWith('America/Indiana/Indianapolis');
    await waitFor(() =>
      expect(createOrganizationAction).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: 'America/Indiana/Indianapolis' }),
      ),
    );
    expect(screen.queryByText(ORG_TIMEZONE_INVALID_MESSAGE)).not.toBeInTheDocument();
  });
});
