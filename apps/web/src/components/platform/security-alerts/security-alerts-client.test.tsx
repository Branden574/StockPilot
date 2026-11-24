import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SECURITY_ALERTS_FAILED,
  SECURITY_ALERTS_REFUSED,
  SECURITY_ALERTS_WORDS as W,
} from '@stockpilot/core';

import {
  FIXTURE_ACTOR_EMAIL,
  FIXTURE_ORG_NAME,
  rawAlert,
  rawSecurityAlertList,
  securityAlertsViewOf,
} from '@/test/security-alerts-fixture';

/**
 * The security alerts as the console shows them (part 5, stage 4a: RECORD
 * ONLY). Security invariant. Pinned: the record-only banner is first, in
 * every state; no text on the page says anything was sent; each alert shows
 * the disposition the database recorded and what it would have done only as
 * far as the record says (the held notice, the email floor, the push budget;
 * the email caps and the held choices are said not to be worked out); the
 * heartbeat's warnings for a check never run, failed, cut short or missed;
 * the thresholds read only, a value not its default marked, an unsafe one
 * warned of; who changed what, by email; times in the viewer's zone; the
 * refused and could-not-check states in plain words, never an empty list;
 * "Check again" asks the action and a throw is "could not check". Made-up
 * data only.
 */

const h = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock('@/server/actions/platform/security-alerts', () => ({
  readPlatformSecurityAlertsAction: (...a: unknown[]) => h.action(...a),
}));

import { SecurityAlertsClient } from './security-alerts-client';

const ok = (raw = rawSecurityAlertList()) => ({
  ok: true as const,
  view: securityAlertsViewOf(raw),
});
const LA = 'America/Los_Angeles';

const CLAIMS_SENT =
  /\b(?:was|were|is|are|has been|have been|got) (?:sent|delivered)\b|^Sent\b|\bwent out\b/im;
const claimsSent = (text: string) =>
  CLAIMS_SENT.test(text.replace(/would have been sent/gi, '').replace(/would have gone/gi, ''));

beforeEach(() => {
  h.action.mockReset();
});

function rowOf(rule: string, n = 0) {
  return screen
    .getByRole('region', { name: 'Latest alerts' })
    .querySelectorAll(`tr[data-rule="${rule}"]`)[n] as HTMLElement;
}

describe('record only', () => {
  it.each([
    ['a view', ok()],
    ['a refusal', SECURITY_ALERTS_REFUSED],
    ['a failed read', SECURITY_ALERTS_FAILED],
  ])('the banner is first, with %s', (_w, initial) => {
    const { container } = render(<SecurityAlertsClient initial={initial} timeZone={LA} />);
    const banner = screen.getByRole('note');
    expect(banner).toHaveTextContent(W.recordOnlyBanner);
    expect(banner).toHaveTextContent(
      'the daily email caps and the choice to hold an alert are not worked out',
    );
    expect(container.querySelector('[data-slot="security-alerts"]')!.firstElementChild).toBe(
      banner,
    );
  });

  it('no text on the page says anything was sent', () => {
    const { container } = render(<SecurityAlertsClient initial={ok()} timeZone={LA} />);
    const text = container.textContent ?? '';
    expect(text.length).toBeGreaterThan(500);
    for (const el of container.querySelectorAll('li, td, p, span')) {
      expect(claimsSent(el.textContent ?? ''), el.textContent ?? '').toBe(false);
    }
    // The planted claim is caught: this check reads what it says it reads.
    expect(claimsSent('The alert was sent by push.')).toBe(true);
  });

  it('a channel on: the note says this release still sends nothing', () => {
    const raw = rawSecurityAlertList({ state: { email_on: true, record_only: false } });
    render(<SecurityAlertsClient initial={ok(raw)} timeZone={LA} />);
    expect(screen.getByRole('note')).toHaveTextContent(W.channelOnNote);
  });
});

describe('each alert', () => {
  it('rule, kind, when, counts, phase, and what was recorded, for every alert', () => {
    render(<SecurityAlertsClient initial={ok()} timeZone={LA} />);
    const table = screen.getByRole('region', { name: 'Latest alerts' });
    expect(table.querySelectorAll('tbody tr')).toHaveLength(7);
    const serious = rowOf('serious_flag');
    expect(serious).toHaveTextContent('Serious flag · Serious');
    expect(serious).toHaveTextContent('Started');
    expect(serious).toHaveTextContent('3 events');
    // The claim's time in the viewer's zone, its exact UTC in the title.
    const time = serious.querySelector('time')!;
    expect(time).toHaveAttribute('title', '24 Nov 2026, 12:00 UTC');
    expect(time.textContent).toMatch(/4:00 AM PST/);
    expect(serious).toHaveTextContent('Recorded only: no alert channel was on');
    expect(serious).toHaveTextContent('With push on: a push (a slot of its budget was free).');
    expect(serious).toHaveTextContent(
      "With email on: an email (a serious flag's email is never capped or held).",
    );
  });

  it('an aimed alert names its organization as the list returns it, and no other row names one', () => {
    render(<SecurityAlertsClient initial={ok()} timeZone={LA} />);
    expect(rowOf('aimed_guessing')).toHaveTextContent(FIXTURE_ORG_NAME);
    expect(screen.getAllByText(FIXTURE_ORG_NAME)).toHaveLength(1);
    expect(rowOf('aimed_guessing')).toHaveTextContent('With push on: no push slot was left today');
    expect(rowOf('aimed_guessing')).toHaveTextContent(
      'That cap is not counted while email is off.',
    );
  });

  it('the held notice: what it would have said, and that its email was skipped', () => {
    render(<SecurityAlertsClient initial={ok()} timeZone={LA} />);
    const notice = rowOf('alerts_held');
    expect(notice).toHaveTextContent(
      'An "alerts are being held" notice would have been sent: 7 alerts were held in the last 24 hours.',
    );
    expect(notice).toHaveTextContent('Email: 2 skipped (this release sends nothing)');
    expect(notice).not.toHaveTextContent('With push on');
  });

  it("a serious flag's email floor: it would have gone by email although email alerts are off", () => {
    render(<SecurityAlertsClient initial={ok()} timeZone={LA} />);
    const floor = rowOf('serious_flag', 1);
    expect(floor).toHaveTextContent(
      'Would have gone by email although email alerts are off, because the push budget was spent.',
    );
    expect(floor).toHaveTextContent('Handed out to be sent by email.');
  });

  it('held for the summary: the disposition the database recorded, and that no summary lists it yet', () => {
    render(<SecurityAlertsClient initial={ok()} timeZone={LA} />);
    expect(rowOf('record_trouble', 1)).toHaveTextContent(
      'The daily summary is not built yet in this release, so nothing has listed it.',
    );
  });

  it('a reminder and an end say so; an end never pushes', () => {
    render(<SecurityAlertsClient initial={ok()} timeZone={LA} />);
    expect(rowOf('record_trouble')).toHaveTextContent('Reminder: 6 hours on');
    expect(rowOf('spike')).toHaveTextContent('Ended');
    expect(rowOf('spike')).toHaveTextContent('With push on: no push (an end never pushes).');
  });

  it('"How to respond" where a card maps: a serious flag, aimed guessing, record trouble; not a spike or a notice', () => {
    render(<SecurityAlertsClient initial={ok()} timeZone={LA} />);
    for (const [rule, has] of [
      ['serious_flag', true],
      ['aimed_guessing', true],
      ['record_trouble', true],
      ['spike', false],
      ['alerts_held', false],
    ] as const) {
      const buttons = within(rowOf(rule)).queryAllByRole('button', { name: /^How to respond: / });
      expect(buttons.length > 0, rule).toBe(has);
    }
  });

  it('no alert yet: says so, never a blank table', () => {
    render(
      <SecurityAlertsClient initial={ok(rawSecurityAlertList({ alerts: [] }))} timeZone={null} />,
    );
    expect(screen.getByText(W.noAlerts)).toBeInTheDocument();
  });

  it('a full list says only the newest are listed', () => {
    render(
      <SecurityAlertsClient
        initial={ok(rawSecurityAlertList({ alerts_truncated: true, alerts: [rawAlert('spike')] }))}
        timeZone={null}
      />,
    );
    expect(screen.getByText(W.alertsTruncated(50))).toBeInTheDocument();
  });
});

describe('the job', () => {
  it('"Last checked at" the last good check, in the viewer\'s zone; no warning on a good day', () => {
    const { container } = render(<SecurityAlertsClient initial={ok()} timeZone={LA} />);
    const hb = container.querySelector('[data-slot="security-alerts-heartbeat"]')!;
    expect(hb).toHaveTextContent(/^Last checked at 24 Nov 2026, 4:00 AM PST\./);
    expect(hb.querySelectorAll('[data-warning]')).toHaveLength(0);
    expect(screen.getByText(/In Pacific Standard Time/, { selector: 'p' })).toBeInTheDocument();
  });

  it.each([
    [
      'never run',
      {
        last_run_started_at: null,
        last_run_finished_at: null,
        last_run_ok: null,
        last_run_partial: null,
        last_ok_at: null,
      },
      [W.notRunYet],
    ],
    [
      'failed',
      { last_run_ok: false, last_ok_at: '2026-11-24T11:50:06+00:00' },
      ['did not finish its work'],
    ],
    ['could not check fully', { last_run_partial: true }, [W.partial]],
    [
      'missed, three in a row, reported',
      {
        last_run_started_at: '2026-11-24T11:20:01+00:00',
        last_run_finished_at: '2026-11-24T11:20:06+00:00',
        last_ok_at: '2026-11-24T11:20:06+00:00',
        failures_in_a_row: 3,
        failure_reported_at: '2026-11-24T11:50:00+00:00',
      },
      [
        'Checks are being missed',
        '3 checks in a row were missed or failed.',
        'That was last reported at',
      ],
    ],
  ])('%s: a plain warning', (_w, heartbeat, words) => {
    const raw = rawSecurityAlertList({
      state: {
        heartbeat: {
          ...(rawSecurityAlertList().state as { heartbeat: object }).heartbeat,
          ...heartbeat,
        },
      },
    });
    const { container } = render(<SecurityAlertsClient initial={ok(raw)} timeZone={LA} />);
    const hb = container.querySelector('[data-slot="security-alerts-heartbeat"]')!;
    for (const word of words) expect(hb).toHaveTextContent(word);
    expect(hb.querySelectorAll('[data-warning]').length).toBeGreaterThan(0);
    expect(within(hb as HTMLElement).getAllByText('Warning:').length).toBeGreaterThan(0);
  });

  it('the spike baseline, the push budget counted as if push were on, and no baseline yet', () => {
    const { unmount } = render(<SecurityAlertsClient initial={ok()} timeZone={LA} />);
    expect(
      screen.getByText(/the week's high mark is 42 events and 7 sources in 10 minutes/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Counted as if push were on\./)).toBeInTheDocument();
    const none = rawSecurityAlertList({
      state: {
        baseline: {
          event_high: null,
          source_high: null,
          from: null,
          to: null,
          shortened: null,
          computed_at: null,
        },
      },
    });
    unmount();
    render(<SecurityAlertsClient initial={ok(none)} timeZone={LA} />);
    expect(screen.getByText(W.spikeNoBaseline)).toBeInTheDocument();
  });
});

describe('thresholds and changes', () => {
  it('the ten thresholds read only; one not its default is marked; one at its most is warned of', () => {
    const raw = rawSecurityAlertList({
      state: {
        thresholds: {
          ...(rawSecurityAlertList().state as { thresholds: Record<string, number> }).thresholds,
          record_trouble_rows: 100000,
        },
      },
    });
    render(<SecurityAlertsClient initial={ok(raw)} timeZone={LA} />);
    const table = screen.getByRole('region', { name: 'Thresholds' });
    expect(table.querySelectorAll('tbody tr')).toHaveLength(10);
    const aimed = table.querySelector('tr[data-threshold="aimed_guessing_events"]')!;
    expect(aimed).toHaveAttribute('data-differs', 'true');
    expect(aimed).toHaveTextContent('40');
    expect(aimed).toHaveTextContent('Not its default.');
    expect(table.querySelector('tr[data-threshold="record_trouble_rows"]')).toHaveTextContent(
      'At its most: its rule may never fire.',
    );
    expect(table.querySelectorAll('[data-differs]')).toHaveLength(2);
    // Read only: nothing to type into and nothing to press.
    expect(within(table).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(table).queryAllByRole('button')).toHaveLength(0);
  });

  it('who changed what, from and to, by email; an actor with no email is "A platform admin"', () => {
    const view = securityAlertsViewOf();
    view.changes = [...view.changes, { ...view.changes[0]!, actorEmail: null }];
    render(<SecurityAlertsClient initial={{ ok: true, view }} timeZone={LA} />);
    const history = screen.getByRole('region', { name: 'Change history' });
    const rows = history.querySelectorAll('tbody tr');
    expect(rows[0]).toHaveTextContent('Guessing aimed at one organization: events');
    expect(rows[0]).toHaveTextContent('20');
    expect(rows[0]).toHaveTextContent('40');
    expect(rows[0]).toHaveTextContent(FIXTURE_ACTOR_EMAIL);
    expect(rows[1]).toHaveTextContent('A platform admin');
    expect(screen.getByRole('region', { name: 'Who set each value in force' })).toHaveTextContent(
      FIXTURE_ACTOR_EMAIL,
    );
  });

  it('no change yet: says so', () => {
    render(
      <SecurityAlertsClient
        initial={ok(rawSecurityAlertList({ changes: [], latest_changes: [] }))}
        timeZone={LA}
      />,
    );
    expect(screen.getAllByText(W.noChanges)).toHaveLength(2);
  });
});

describe('refused, could not check, and Check again', () => {
  it('refused: plain words, no list', () => {
    render(<SecurityAlertsClient initial={SECURITY_ALERTS_REFUSED} timeZone={LA} />);
    expect(screen.getByText(W.refused)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Latest alerts' })).toBeNull();
  });

  it('could not check: plain words, never an empty list, and Check again reads once more', async () => {
    h.action.mockResolvedValue(ok());
    render(<SecurityAlertsClient initial={SECURITY_ALERTS_FAILED} timeZone={LA} />);
    expect(screen.getByText(W.couldNotCheck)).toBeInTheDocument();
    expect(screen.queryByText(W.noAlerts)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: W.checkAgain }));
    });
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Latest alerts' })).toBeInTheDocument(),
    );
    expect(h.action).toHaveBeenCalledWith({});
  });

  it('a Check again that throws is "could not check"; one refused is refused', async () => {
    h.action.mockRejectedValueOnce(new Error('network'));
    render(<SecurityAlertsClient initial={ok()} timeZone={LA} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: W.checkAgain }));
    });
    await waitFor(() => expect(screen.getByText(W.couldNotCheck)).toBeInTheDocument());
    h.action.mockResolvedValueOnce(SECURITY_ALERTS_REFUSED);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: W.checkAgain }));
    });
    await waitFor(() => expect(screen.getByText(W.refused)).toBeInTheDocument());
  });
});
