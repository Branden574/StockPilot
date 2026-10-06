import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The digest card said "Sent every Monday morning". The weekly-digest cron
 * runs once for every organization, at 14:00 UTC on Mondays (apps/web/
 * vercel.json): Monday morning in US zones, 2:00 PM for an organization on
 * UTC, and Tuesday from UTC+10 east. The card now states the time the page
 * works out in the organization's zone (digestScheduleLabel, the words the
 * digest email's footer uses).
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/actions/digest', () => ({
  sendDigestPreviewAction: vi.fn(),
  setDigestPrefsAction: vi.fn(),
}));

import { DigestControls } from './digest-controls';

const SECTIONS = { lowStock: true, openPos: true, cycleCounts: true };

describe("the weekly digest card states the send time in the workspace's time zone", () => {
  it('a Pacific workspace: Mondays at 7:00 AM PDT, never "every Monday morning"', () => {
    render(
      <DigestControls
        initialOptIn
        initialSections={SECTIONS}
        scheduleLabel="Mondays at 7:00 AM PDT"
      />,
    );
    expect(
      screen.getByText(
        /^Sent Mondays at 7:00 AM PDT, in your workspace's time zone\. It covers only/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/every Monday morning/)).toBeNull();
  });

  it('a workspace at UTC+11: Tuesdays, as the email footer says', () => {
    render(
      <DigestControls
        initialOptIn={false}
        initialSections={SECTIONS}
        scheduleLabel="Tuesdays at 1:00 AM GMT+11"
      />,
    );
    expect(
      screen.getByText(/^Sent Tuesdays at 1:00 AM GMT\+11, in your workspace's time zone\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Monday morning/)).toBeNull();
  });
});
