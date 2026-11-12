import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MODULE_REGISTRY, SHORTFALL_PO_PHONE_REVIEW_COPY } from '@stockpilot/core';

/**
 * The Recurring purchase orders notification names the controls a reader
 * uses, read here from the components that draw them (B64, B105).
 *
 * It said "Open it in Purchase orders and send it." of a purchase order the
 * run created as a draft and could not mark as ordered, but a draft's page has
 * no Send: its button is Mark as ordered, the same status change the run
 * makes (updateStatus 'ordered'), and the phone shows a draft read-only
 * ("Review and order this draft on the web."). It said "Edit the template"
 * and "Edit or disable it" with no place, and the phone's Recurring POs can
 * turn a template off or delete it, but not edit it. And it counted the
 * purchase orders the run marked as ordered as "sent", though nothing is sent
 * to a supplier (B105).
 *
 * So the words are taken from the controls: Mark as ordered from the draft
 * page's commit button, Edit and the off switch from the Recurring POs list,
 * and both pages' names from the module registry, the names the sidebar and
 * the phone's drawer show.
 */

const updatePoStatusAction = vi.fn();
vi.mock('@/server/actions/purchase-orders', () => ({
  updatePoStatusAction: (...args: unknown[]) => updatePoStatusAction(...args),
}));
const setRecurringTemplateEnabledAction = vi.fn(async (_id: string, _enabled: boolean) => ({
  ok: true as const,
  data: { id: 'tpl-1' },
}));
vi.mock('@/server/actions/recurring-pos', () => ({
  setRecurringTemplateEnabledAction: (id: string, enabled: boolean) =>
    setRecurringTemplateEnabledAction(id, enabled),
  createRecurringTemplateAction: vi.fn(),
  updateRecurringTemplateAction: vi.fn(),
  deleteRecurringTemplateAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ capture: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return {
    ...actual,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatRelative: () => 'just now',
  };
});

import { recurringRunNotice, type RecurringRunSummary } from '@/server/services/recurring-pos';

import { PoActions } from './po-actions';
import { RecurringTemplatesPanel, type RecurringTemplateRow } from './recurring-templates-panel';

/** A page's name as the sidebar or the phone's drawer shows it. */
const label = (surface: 'web_sidebar' | 'mobile_drawer', href: string) =>
  MODULE_REGISTRY.purchase_orders.placements.find((p) => p.surface === surface && p.href === href)!
    .label;

/** A file in the repository, as written. */
const REPO = resolve(__dirname, '../../../../..');
const repoFile = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');

const EMPTY: RecurringRunSummary = {
  created: 0,
  sent: 0,
  heldForReview: 0,
  failures: 0,
  linesLeftOff: 0,
  templatesWithLinesLeftOff: [],
  templatesWithNothingOrderable: [],
  templatesSkipped: [],
  templatesSendFailed: [],
};

const TEMPLATE: RecurringTemplateRow = {
  id: 'tpl-1',
  name: 'Weekly Supplies',
  supplier_id: null,
  destination_location_id: null,
  enabled: true,
  cadence: 'weekly',
  custom_days: null,
  send_mode: 'draft',
  max_auto_send_cents: null,
  line_items: [{ itemId: 'item-1', quantityOrdered: 2, unitCost: 10 }],
  notes: null,
  last_run_at: null,
  next_run_at: new Date().toISOString(),
};

/** Send or sent, in any form: the run sends nothing to anyone. */
const SEND_WORDS = /\bsen(?:d|ds|t|ding)\b/i;

beforeEach(() => {
  vi.clearAllMocks();
  updatePoStatusAction.mockResolvedValue({ ok: true, data: null });
});

describe('the Recurring purchase orders notification names the controls it sends a reader to', () => {
  it("names the draft page's commit button, which makes the change the run makes, on the web", async () => {
    render(<PoActions poId="po-1" status="draft" part="commit" />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    // The button draws an icon and then its name.
    const buttonLabel = buttons[0]!.textContent!.trim();
    fireEvent.click(buttons[0]!);
    // The run's own change (updateStatus(po.id, 'ordered'), pinned in
    // registry.small-fixes-8.test.ts): the button and the run do the same.
    await waitFor(() => expect(updatePoStatusAction).toHaveBeenCalledWith('po-1', 'ordered'));

    const orders = label('web_sidebar', '/dashboard/purchase-orders');
    expect(orders).toBe('Purchase orders');
    // "Mark as ordered" -> "marked as ordered": what the run did, in the
    // button's words.
    const marked = buttonLabel.replace(/^Mark\b/, 'marked');
    expect(marked).toBe('marked as ordered');

    const one = recurringRunNotice({
      ...EMPTY,
      created: 1,
      failures: 1,
      templatesSendFailed: ['Weekly Supplies'],
    })!.body;
    expect(one).toContain(
      `"Weekly Supplies" created its purchase order as a draft, but it could not be ${marked}. Open it in ${orders} on the web and select ${buttonLabel}.`,
    );
    const two = recurringRunNotice({
      ...EMPTY,
      created: 2,
      failures: 2,
      templatesSendFailed: ['A', 'B'],
    })!.body;
    expect(two).toContain(
      `"A" and "B" created their purchase orders as drafts, but they could not be ${marked}. Open each in ${orders} on the web and select ${buttonLabel}.`,
    );
    // The run line counts what it marked as ordered, in the same words.
    const ran = recurringRunNotice({ ...EMPTY, created: 3, sent: 2, heldForReview: 1 })!.body;
    expect(ran).toBe(
      `Recurring purchase orders created 3 purchase orders, 2 ${marked}, 1 held for review.`,
    );
    for (const body of [one, two, ran]) expect(body).not.toMatch(SEND_WORDS);

    // "On the web": the phone shows a draft read-only.
    expect(SHORTFALL_PO_PHONE_REVIEW_COPY).toBe('Review and order this draft on the web.');
    // The page shows this part as its commit button.
    expect(
      repoFile('apps/web/src/app/(dashboard)/dashboard/purchase-orders/[id]/page.tsx'),
    ).toMatch(/<PoActions poId=\{id\} status=\{status\} part="commit" \/>/);
  });

  it('sends the reader to the web to edit a template, and to Recurring POs on either to turn it off', async () => {
    render(
      <RecurringTemplatesPanel
        initial={[TEMPLATE]}
        items={[{ id: 'item-1', name: 'Widget A', sku: 'WGT-A', unit_cost: 10 }]}
        suppliers={[]}
        locations={[]}
        entitled
        seed={null}
      />,
    );
    const edit = screen.getByRole('button', { name: 'Edit' });
    // The template's off switch: checked while it is on, and a click turns it off.
    const toggle = screen.getByRole('checkbox', { name: 'Disable template' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(setRecurringTemplateEnabledAction).toHaveBeenCalledWith('tpl-1', false),
    );

    // Both surfaces call the page Recurring POs.
    const recurring = label('web_sidebar', '/dashboard/purchase-orders/recurring');
    expect(recurring).toBe('Recurring POs');
    expect(label('mobile_drawer', '/recurring-pos')).toBe(recurring);
    const verb = edit.textContent!.trim().toLowerCase();
    expect(verb).toBe('edit');

    const leftOffOne = recurringRunNotice({
      ...EMPTY,
      created: 1,
      linesLeftOff: 1,
      templatesWithLinesLeftOff: ['Weekly Supplies'],
    })!.body;
    expect(leftOffOne).toContain(
      `On the web, open ${recurring} and ${verb} the template to remove it.`,
    );
    const leftOffMany = recurringRunNotice({
      ...EMPTY,
      linesLeftOff: 5,
      templatesWithLinesLeftOff: ['A', 'B', 'C', 'D', 'E'],
    })!.body;
    expect(leftOffMany).toContain(
      `On the web, open ${recurring} and ${verb} the templates to remove them.`,
    );
    // A template with nothing orderable had its lines left off (the run
    // names it there too), as the run reports it.
    const idleOne = recurringRunNotice({
      ...EMPTY,
      failures: 1,
      linesLeftOff: 1,
      templatesWithLinesLeftOff: ['Monthly Pens'],
      templatesWithNothingOrderable: ['Monthly Pens'],
    })!.body;
    expect(idleOne).toContain(`In ${recurring}, ${verb} it on the web or turn it off.`);
    const idleTwo = recurringRunNotice({
      ...EMPTY,
      failures: 2,
      linesLeftOff: 2,
      templatesWithLinesLeftOff: ['A', 'B'],
      templatesWithNothingOrderable: ['A', 'B'],
    })!.body;
    expect(idleTwo).toContain(`In ${recurring}, ${verb} them on the web or turn them off.`);

    // Why "edit" says "on the web" and "turn it off" does not: the phone's
    // Recurring POs has a switch per template and Delete template, but no Edit.
    const phone = repoFile('apps/mobile/app/(drawer)/recurring-pos.tsx');
    expect(phone).toContain(`title="${recurring}"`);
    expect(phone).toMatch(/<Toggle\s+value=\{row\.enabled\}\s+onValueChange=/);
    expect(phone).toContain('Delete template');
    expect(phone).not.toMatch(/>\s*Edit\b/);
    expect(phone).not.toMatch(/['"`]Edit( template)?['"`]/);
  });
});
