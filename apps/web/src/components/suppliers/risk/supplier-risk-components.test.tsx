import { act, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  vendorRiskQuestionsFor,
  vendorRiskReasonCount,
  type VendorRiskAnswers,
} from '@stockpilot/core';

import type {
  SupplierRiskEvent,
  SupplierRiskItem,
  SupplierRiskReview,
} from '@/server/services/supplier-risk';

/**
 * Security invariant: what the vendor review page's parts show and send
 * (REVIEW-0481 round 3 follow-ups).
 *   1. A note or a reason with hidden characters (pasted text, a phone's emoji
 *      joiners) is cleaned with core's own list as it is typed, and the field
 *      SHOWS the cleaned text and says so: a reason is never changed unseen,
 *      and an honest paste is not refused.
 *   2. Beside a date: a judged date later than tomorrow in UTC is "in the
 *      future", the input allows nothing later, and one more than 12 months
 *      old is said plainly to count as Not shown; a Yes needs its date.
 *   3. The reason counter is core's vendorRiskReasonCount: the numbers shown
 *      are its numbers (characters as seen, after spaces collapse; different
 *      ones), with the database's thresholds.
 *   4. Supplier and member names inside a sentence sit in <bdi>; every text a
 *      person typed is rendered as text.
 *   No write control for a seat that may not write.
 */

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  save: vi.fn(),
  finish: vi.fn(),
  discard: vi.fn(),
  update: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('next/link', async () => {
  const R = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
      R.createElement('a', { href, ...rest }, children),
  };
});
vi.mock('@/components/auth/step-up-modal', () => ({
  useStepUp: () => ({ ensure: vi.fn(async () => true), modal: null }),
}));
vi.mock('@/server/actions/supplier-risk', () => ({
  saveSupplierRiskDraftAction: (...a: unknown[]) => h.save(...a),
  finishSupplierRiskReviewAction: (...a: unknown[]) => h.finish(...a),
  discardSupplierRiskDraftAction: (...a: unknown[]) => h.discard(...a),
  updateSupplierRiskItemAction: (...a: unknown[]) => h.update(...a),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CleanTextField } from './clean-text-field';
import { ReasonField } from './reason-field';
import { SupplierRiskReviewForm } from './review-form';
import { SupplierRiskHistory } from './history';
import { SupplierRiskItems } from './review-items';
import { SupplierRiskReviewSummary } from './review-summary';

const SUPPLIER = '5a5a5a5a-0000-4000-8000-000000000001';
const ME = '11111111-1111-4111-8111-111111111111';

function Controlled({ kind, start = '' }: { kind: 'reason' | 'note'; start?: string }) {
  const [value, setValue] = React.useState(start);
  return kind === 'reason' ? (
    <ReasonField id="reason" label="Why" value={value} onChange={setValue} />
  ) : (
    <CleanTextField id="note" label="Note" max={1000} value={value} onChange={setValue} />
  );
}

beforeEach(() => {
  for (const f of [h.refresh, h.save, h.finish, h.discard, h.update]) f.mockReset();
  h.save.mockResolvedValue({ ok: true, data: { reviewId: 'r', updatedAt: null } });
});

describe('follow-up 1: hidden characters are cleaned, and the person sees the cleaned text', () => {
  it('a reason pasted with joiners and selectors is shown cleaned, with a note saying so', () => {
    render(<Controlled kind="reason" />);
    const box = screen.getByLabelText('Why') as HTMLTextAreaElement;
    fireEvent.change(box, {
      target: { value: 'The vendor\u200d sent a signed\ufe0f letter today.\u2028Checked.' },
    });
    expect(box.value).toBe('The vendor sent a signed letter today.\nChecked.');
    // The joiner and the selector are taken out; the line separator becomes a
    // line break (counted too: it was changed).
    expect(screen.getByRole('status').textContent).toMatch(/We took out 3 hidden characters/);
    expect(screen.getByRole('status').textContent).toMatch(/read it again/);
  });

  it('a note pasted with a zero-width space is saved as shown, not refused', () => {
    render(<Controlled kind="note" />);
    const box = screen.getByLabelText(/Note/) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Seen in the contract\u200b, page 4.' } });
    expect(box.value).toBe('Seen in the contract, page 4.');
    expect(screen.getByRole('status').textContent).toMatch(/We took out 1 hidden character /);
    expect(box.getAttribute('aria-invalid')).toBeNull();
  });

  it('plain text is left alone and nothing is said', () => {
    render(<Controlled kind="note" />);
    const box = screen.getByLabelText(/Note/) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Seen in the contract.' } });
    expect(box.value).toBe('Seen in the contract.');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe("follow-up 3: the reason counter is core's count", () => {
  it.each([
    'aaaa      aaaa aaaa aaaa aaaa',
    'Seen the letter.',
    'The vendor sent a signed letter from their auditor.',
    '\u{1F44D}\u{1F3FD}\u{1F44D}\u{1F3FD} flags \u{1F1FA}\u{1F1F8} and more words here',
    '\u2800\u2800\u2800 braille blanks are spaces to the database',
  ])('%s', (text) => {
    render(<Controlled kind="reason" start={text} />);
    const count = vendorRiskReasonCount(text);
    const rules = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(rules[0]).toBe(
      `${count.seen >= 20 ? 'Met' : 'Not yet'}: at least 20 characters (now ${count.seen})`,
    );
    expect(rules[1]).toBe(
      `${count.different >= 5 ? 'Met' : 'Not yet'}: at least 5 different characters (now ${count.different})`,
    );
    const box = screen.getByLabelText('Why');
    expect(box.getAttribute('aria-invalid')).toBe(count.ok ? null : 'true');
  });

  it('runs of spaces count as one, so padding does not reach 20', () => {
    render(<Controlled kind="reason" start={'ok              ok'} />);
    expect(screen.getAllByRole('listitem')[0]?.textContent).toMatch(
      /^Not yet: at least 20 characters \(now 5\)$/,
    );
  });
});

function formProps(over: Partial<React.ComponentProps<typeof SupplierRiskReviewForm>> = {}) {
  return {
    supplierId: SUPPLIER,
    supplierName: 'Example Supply Co',
    orgToday: '2026-11-27',
    utcToday: '2026-11-28',
    start: {
      dataLevel: 'staff' as const,
      answers: {} as VendorRiskAnswers,
      from: 'empty' as const,
    },
    draftUpdatedAt: null,
    canWrite: true,
    canDiscard: false,
    people: [{ userId: ME, name: 'Avery Example' }],
    ...over,
  };
}

describe('follow-up 2: the evidence dates', () => {
  it('the security report and insurance dates allow nothing after tomorrow in UTC, and say when Yes needs them', () => {
    render(
      <SupplierRiskReviewForm
        {...formProps({
          start: {
            dataLevel: 'staff',
            answers: { security_report: { answer: 'yes' } },
            from: 'draft',
          },
        })}
      />,
    );
    const report = screen.getByLabelText(/Report period end/) as HTMLInputElement;
    expect(report.max).toBe('2026-11-29');
    expect(report.getAttribute('aria-required')).toBe('true');
    expect(
      screen.getByText('Give the date on the document. It is needed to finish the review.'),
    ).toBeTruthy();
    const insurance = screen.getByLabelText(/Date on the certificate/) as HTMLInputElement;
    expect(insurance.max).toBe('2026-11-29');
    // The data agreement's date is not judged: no latest day.
    expect((screen.getByLabelText(/Date signed/) as HTMLInputElement).max).toBe('');
  });

  it('a date in the future is said plainly and stops a save', async () => {
    render(
      <SupplierRiskReviewForm
        {...formProps({
          start: {
            dataLevel: 'staff',
            answers: { security_report: { answer: 'yes', date: '2026-12-05' } },
            from: 'draft',
          },
        })}
      />,
    );
    expect(
      screen.getByText('This date is in the future. Give the date printed on the document.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(h.save).not.toHaveBeenCalled();
    expect((await screen.findByRole('alert')).textContent).toMatch(/in the future/);
  });

  it('a date more than 12 months old is said to count as Not shown, and the preview counts it so', () => {
    render(
      <SupplierRiskReviewForm
        {...formProps({
          start: {
            dataLevel: 'staff',
            answers: { insurance: { answer: 'yes', date: '2025-06-01' } },
            from: 'draft',
          },
        })}
      />,
    );
    expect(
      screen.getByText(
        /more than 12 months before today, so the document counts as Not shown to us/,
      ),
    ).toBeTruthy();
    const reasons = document.querySelector('[data-slot="supplier-risk-reasons"]');
    expect(reasons?.textContent).toMatch(/Out of date, so counted as Not shown to us/);
  });

  it('finishing with a Yes and no date is refused on the page, nothing sent', async () => {
    const answers: VendorRiskAnswers = {};
    render(
      <SupplierRiskReviewForm
        {...formProps({
          start: {
            dataLevel: 'staff',
            answers: { ...answers, insurance: { answer: 'yes' } },
            from: 'draft',
          },
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Finish the review…' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Give the date on the document/);
    expect(h.finish).not.toHaveBeenCalled();
  });
});

describe('the computed result with its reasons, and no control for a seat that may not write', () => {
  it('the preview lists every reason the rules give', () => {
    render(<SupplierRiskReviewForm {...formProps()} />);
    const reasons = document.querySelector('[data-slot="supplier-risk-reasons"]');
    expect(reasons?.textContent).toMatch(
      /What they hold: Staff contact details, so the starting risk is/,
    );
    expect(reasons?.textContent).toMatch(/Evidence:/);
    expect(reasons?.textContent).toMatch(/not answered yet: they count as Not shown to us/);
    expect(reasons?.textContent).toMatch(/Risk left:/);
  });

  it('the student group is asked only with student data', () => {
    const { rerender } = render(<SupplierRiskReviewForm {...formProps()} />);
    expect(document.querySelector('[data-group="student"]')).toBeNull();
    rerender(
      <SupplierRiskReviewForm
        {...formProps({ start: { dataLevel: 'student', answers: {}, from: 'empty' } })}
        key="student"
      />,
    );
    expect(document.querySelector('[data-group="student"]')).not.toBeNull();
  });

  it('read-only: no Save, no Finish, no Discard', () => {
    render(<SupplierRiskReviewForm {...formProps({ canWrite: false, canDiscard: false })} />);
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Finish/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard draft' })).toBeNull();
  });
});

function review(over: Partial<SupplierRiskReview> = {}): SupplierRiskReview {
  return {
    id: 'e1e1e1e1-0000-4000-8000-000000000001',
    supplierId: SUPPLIER,
    supplierName: 'Example Supply Co',
    supplierState: 'active',
    version: 3,
    status: 'final',
    isCurrent: true,
    rulesVersion: 1,
    dataLevel: 'student',
    answers: {},
    startingRisk: 'high',
    evidence: 'weak',
    residualRisk: 'high',
    hardStops: ['student_data_no_agreement'],
    computedResult: 'do_not_use',
    overrideResult: 'more_information',
    overrideReason: 'Line one <b>not bold</b>\n  line two kept as written',
    result: 'more_information',
    reviewerName: 'Rami \u202eExample',
    reviewedAt: '2026-11-27T10:00:00Z',
    reviewedOn: '2026-11-27',
    nextReviewOn: '2027-05-27',
    createdAt: null,
    updatedAt: null,
    items: [],
    ...over,
  };
}

function item(over: Partial<SupplierRiskItem> = {}): SupplierRiskItem {
  return {
    id: '17e17e17-0000-4000-8000-000000000001',
    reviewId: 'e1e1e1e1-0000-4000-8000-000000000001',
    questionKey: 'breach_notice',
    answer: 'no',
    severity: 'high',
    finding: '<img src=x onerror=alert(1)> no clause',
    action: 'Ask for a clause.',
    ownerUserId: ME,
    ownerName: 'Avery Example',
    ownerIsAdmin: false,
    dueOn: '2026-12-31',
    status: 'accepted',
    closedAt: null,
    changedByName: 'Blake Example',
    changedAt: '2026-11-27T10:00:00Z',
    acceptedByName: 'Casey Example',
    acceptedReason: 'Accepted until the new contract starts in January.',
    ...over,
  };
}

describe('follow-up 4: names in <bdi>, and text as text', () => {
  it('an override: what the rules gave, "Set by <bdi>name</bdi>: reason" exactly as written, the hard stops named', () => {
    const { container } = render(
      <SupplierRiskReviewSummary
        review={review()}
        title="Current review"
        timeZone="America/Los_Angeles"
      />,
    );
    const override = container.querySelector('[data-slot="supplier-risk-override"]')!;
    expect(override.textContent).toMatch(/The rules gave: Do not use/);
    const bdi = override.querySelector('bdi');
    expect(bdi?.textContent).toBe('Rami \u202eExample');
    const reason = bdi?.parentElement?.querySelector('span');
    expect(reason?.textContent).toBe('Line one <b>not bold</b>\n  line two kept as written');
    expect(override.querySelector('b')).toBeNull();
    expect(container.querySelector('[data-slot="supplier-risk-hard-stops"]')?.textContent).toMatch(
      /no signed data agreement/,
    );
  });

  it('an item: owner, accepted by and changed by in <bdi>; the finding as text', () => {
    const { container } = render(
      <SupplierRiskItems
        reviewId="r"
        items={[item()]}
        people={[]}
        canWrite={false}
        orgToday="2026-11-27"
        timeZone="America/Los_Angeles"
      />,
    );
    const names = Array.from(container.querySelectorAll('bdi')).map((b) => b.textContent);
    expect(names).toEqual(['Avery Example', 'Casey Example', 'Blake Example']);
    expect(container.textContent).toMatch(/Avery Example \(no longer an owner or admin\)/);
    expect(container.querySelector('[data-slot="supplier-risk-accepted"]')?.textContent).toBe(
      'Accepted by Casey Example: Accepted until the new contract starts in January.',
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)> no clause');
  });

  it('no Change control without the right to write; one per item with it', () => {
    const { rerender } = render(
      <SupplierRiskItems
        reviewId="r"
        items={[item()]}
        people={[]}
        canWrite={false}
        orgToday="2026-11-27"
        timeZone="America/Los_Angeles"
      />,
    );
    expect(screen.queryByRole('button', { name: /Change the item/ })).toBeNull();
    rerender(
      <SupplierRiskItems
        reviewId="r"
        items={[item()]}
        people={[]}
        canWrite
        orgToday="2026-11-27"
        timeZone="America/Los_Angeles"
      />,
    );
    const change = screen.getByRole('button', { name: /Change the item/ });
    fireEvent.click(change);
    const form = screen.getByRole('form', { name: 'Change this item' });
    // The owner who is no longer an admin stays choosable, said so.
    expect(
      within(form).getByRole('option', { name: /Avery Example \(no longer an owner or admin\)/ }),
    ).toBeTruthy();
  });

  it('a reason for Risk accepted is cleaned before it is sent', async () => {
    h.update.mockResolvedValue({ ok: true, data: { item: item() } });
    render(
      <SupplierRiskItems
        reviewId="r"
        items={[item({ status: 'open', acceptedByName: null, acceptedReason: null })]}
        people={[{ userId: ME, name: 'Avery Example' }]}
        canWrite
        orgToday="2026-11-27"
        timeZone="America/Los_Angeles"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Change the item/ }));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'accepted' } });
    const reason = screen.getByLabelText('Why the risk is accepted') as HTMLTextAreaElement;
    fireEvent.change(reason, {
      target: { value: 'Accepted\u200d until the new contract starts.' },
    });
    expect(reason.value).toBe('Accepted until the new contract starts.');
    fireEvent.click(screen.getByRole('button', { name: 'Save the item' }));
    await vi.waitFor(() => expect(h.update).toHaveBeenCalledTimes(1));
    expect(h.update.mock.calls[0]?.[0]).toMatchObject({
      status: 'accepted',
      reason: 'Accepted until the new contract starts.',
    });
  });
});

describe('the stored summary says what is true about the hard stops (S5)', () => {
  function studentAnswers(over: VendorRiskAnswers = {}): VendorRiskAnswers {
    const out: VendorRiskAnswers = {};
    for (const q of vendorRiskQuestionsFor('student')) {
      out[q.key] = q.date ? { answer: 'yes', date: '2026-10-01' } : { answer: 'yes' };
    }
    return { ...out, ...over };
  }
  const notRuledOut = 'A hard-stop question is not answered yet: more information is needed.';

  it('a hard-stop question answered Not shown to us: never "No hard stop applies."', () => {
    const { container } = render(
      <SupplierRiskReviewSummary
        review={review({
          hardStops: [],
          overrideResult: null,
          overrideReason: null,
          computedResult: 'more_information',
          result: 'more_information',
          answers: studentAnswers({ data_agreement: { answer: 'not_shown' } }),
        })}
        title="Current review"
        timeZone="America/Los_Angeles"
      />,
    );
    expect(container.textContent).not.toContain('No hard stop applies.');
    const pending = container.querySelector('[data-slot="supplier-risk-hard-stops-pending"]');
    expect(pending?.textContent).toContain(notRuledOut);
    expect(pending?.textContent).toMatch(/no signed data agreement/);
  });

  it('every answer Yes: no hard stop applies', () => {
    const { container } = render(
      <SupplierRiskReviewSummary
        review={review({
          hardStops: [],
          overrideResult: null,
          overrideReason: null,
          computedResult: 'approve',
          result: 'approve',
          answers: studentAnswers(),
        })}
        title="Current review"
        timeZone="America/Los_Angeles"
      />,
    );
    expect(container.textContent).toContain('No hard stop applies.');
    expect(container.textContent).not.toContain(notRuledOut);
  });
});

describe('every date in the organization zone, the same on the server and in the browser (S3)', () => {
  it('"Last changed" is the day in the organization zone, with the exact UTC beside it', () => {
    const { container } = render(
      <SupplierRiskItems
        reviewId="r"
        items={[item({ changedAt: '2026-11-27T16:30:00Z' })]}
        people={[]}
        canWrite={false}
        orgToday="2026-11-28"
        timeZone="Asia/Tokyo"
      />,
    );
    expect(container.textContent).toMatch(/Last changed by Blake Example on November 28, 2026/);
    expect(container.querySelector('time')?.getAttribute('title')).toBe('27 Nov 2026, 16:30 UTC');
  });

  it('"Reviewed" is the day the review was finished in the organization zone', () => {
    const { container } = render(
      <SupplierRiskReviewSummary
        review={review({ reviewedAt: '2026-11-27T16:30:00Z', reviewedOn: '2026-11-28' })}
        title="Current review"
        timeZone="Asia/Tokyo"
      />,
    );
    expect(container.textContent).toContain('November 28, 2026');
    expect(container.textContent).not.toContain('November 27, 2026');
  });

  it('a due date is a calendar day: never moved by a zone', () => {
    const { container } = render(
      <SupplierRiskItems
        reviewId="r"
        items={[item({ dueOn: '2026-12-31' })]}
        people={[]}
        canWrite={false}
        orgToday="2026-11-28"
        timeZone="Pacific/Kiritimati"
      />,
    );
    expect(container.textContent).toContain('December 31, 2026');
  });

  it('the items rendered on a server in UTC hydrate in a browser in Los Angeles with no mismatch', async () => {
    const before = process.env.TZ;
    const tree = (
      <SupplierRiskItems
        reviewId="r"
        items={[item({ changedAt: '2026-11-28T03:00:00Z' })]}
        people={[]}
        canWrite={false}
        orgToday="2026-11-27"
        timeZone="America/Los_Angeles"
      />
    );
    try {
      process.env.TZ = 'UTC';
      const html = renderToString(tree);
      process.env.TZ = 'America/Los_Angeles';
      const container = document.createElement('div');
      container.innerHTML = html;
      document.body.appendChild(container);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const recoverable: unknown[] = [];
      await act(async () => {
        hydrateRoot(container, tree, { onRecoverableError: (e) => recoverable.push(e) });
      });
      expect(recoverable).toEqual([]);
      expect(errors).not.toHaveBeenCalled();
      expect(container.textContent).toContain('on November 27, 2026');
      errors.mockRestore();
      container.remove();
    } finally {
      process.env.TZ = before;
    }
  });
});

describe("the history: the database's record, every value as text", () => {
  function event(over: Partial<SupplierRiskEvent> = {}): SupplierRiskEvent {
    return {
      id: 'ee000000-0000-4000-8000-000000000001',
      event: 'item_changed',
      reviewId: 'e1e1e1e1-0000-4000-8000-000000000001',
      itemId: '17e17e17-0000-4000-8000-000000000001',
      version: 3,
      actorName: 'Rami \u202eExample',
      at: '2026-11-27T16:30:00Z',
      detail: {
        questionKey: 'breach_notice',
        before: { status: 'open', ownerName: 'Avery Example', dueOn: '2026-12-31' },
        after: { status: 'accepted', ownerName: 'Blake <b>Example</b>', dueOn: null },
        reason: 'Line one <img src=x onerror=alert(1)>\n  line two',
        computedResult: null,
        result: null,
      },
      ...over,
    };
  }

  it('who, when (in the organization zone), what changed, and the reason as written', () => {
    const { container } = render(
      <SupplierRiskHistory
        read={{ state: 'ok', value: { events: [event()], next: null } }}
        timeZone="Asia/Tokyo"
        olderHref={null}
        newestHref={null}
      />,
    );
    const li = container.querySelector('[data-event="item_changed"]')!;
    expect(li.textContent).toMatch(/Item changed/);
    expect(li.textContent).toMatch(/Version 3/);
    expect(li.textContent).toContain('November 28, 2026, 1:30 AM GMT+9');
    expect(li.querySelector('time')?.getAttribute('title')).toBe('27 Nov 2026, 16:30 UTC');
    const names = Array.from(li.querySelectorAll('bdi')).map((b) => b.textContent);
    expect(names).toEqual(['Rami \u202eExample', 'Avery Example', 'Blake <b>Example</b>']);
    expect(li.textContent).toMatch(/Status changed from Open to Risk accepted\./);
    expect(li.textContent).toMatch(/Due changed from December 31, 2026 to none\./);
    expect(li.textContent).toContain(
      'Reason: Line one <img src=x onerror=alert(1)>\n  line two',
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });

  it("an event this page does not know is shown by the database's word, never hidden", () => {
    const { container } = render(
      <SupplierRiskHistory
        read={{
          state: 'ok',
          value: {
            events: [event({ event: 'something_new', detail: { ...event().detail, before: null, after: null, reason: null } })],
            next: null,
          },
        }}
        timeZone="UTC"
        olderHref={null}
        newestHref={null}
      />,
    );
    expect(container.querySelector('[data-event="something_new"]')?.textContent).toMatch(
      /something_new/,
    );
  });

  it('a finished review with a result set by an admin says both results', () => {
    const { container } = render(
      <SupplierRiskHistory
        read={{
          state: 'ok',
          value: {
            events: [
              event({
                event: 'result_overridden',
                itemId: null,
                detail: {
                  questionKey: null,
                  before: null,
                  after: null,
                  reason: 'The vendor showed us a signed letter.',
                  computedResult: 'do_not_use',
                  result: 'more_information',
                },
              }),
            ],
            next: 'cursor',
          },
        }}
        timeZone="UTC"
        olderHref="/dashboard/suppliers/x/risk?history=cursor"
        newestHref={null}
      />,
    );
    const li = container.querySelector('[data-event="result_overridden"]')!;
    expect(li.textContent).toMatch(/Result set by an admin/);
    expect(li.textContent).toMatch(/The rules gave Do not use; the result is More information needed\./);
    expect(screen.getByRole('link', { name: 'Older changes' }).getAttribute('href')).toBe(
      '/dashboard/suppliers/x/risk?history=cursor',
    );
  });

  it('a history that could not be read says so; it is never "no change"', () => {
    const { container } = render(
      <SupplierRiskHistory
        read={{ state: 'could_not_check' }}
        timeZone="UTC"
        olderHref={null}
        newestHref={null}
      />,
    );
    expect(container.textContent).toMatch(/The history could not be checked just now/);
    expect(container.textContent).not.toMatch(/No change recorded/);
  });
});

describe('a result an admin set is marked where it is shown (S6)', () => {
  it('the summary badge says so', () => {
    const { container } = render(
      <SupplierRiskReviewSummary review={review()} title="Current review" timeZone="UTC" />,
    );
    expect(container.querySelector('[data-slot="supplier-risk-result"]')?.textContent).toBe(
      'More information needed (set by an admin)',
    );
  });
});
