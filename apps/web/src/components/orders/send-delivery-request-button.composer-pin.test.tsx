import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F2-4 CALL-SITE PIN, OUTLOOK RULE 1 ON THE WEB: changing an order's needed-by
 * generates no email, and the requester's "Send delivery request" draft
 * (which already carries the current needed-by) opens ONLY when they click
 * "Email delivery request": never when the page renders, when it is read
 * again after a revision (router.refresh, realtime), or when the host dialog
 * opens. The button and the assistant are UNCHANGED by F2-4; this pins that
 * they stay that way. The phone twin is apps/mobile/src/lib/order-f2-4-wiring.test.ts.
 *
 * Unlike send-delivery-request-button.test.tsx (which stubs the assistant),
 * the REAL assistant is mounted here: only its bookkeeping (the audit action,
 * analytics) and the toasts are stubbed, and window.open is the observed
 * edge. Each test names the mutation it catches.
 */

const recordDrafted = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => {}));
vi.mock('@/server/actions/delivery-request', () => ({
  recordDeliveryRequestDraftedAction: (...a: unknown[]) => recordDrafted(...a),
}));
vi.mock('@/lib/analytics', () => ({ capture: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SendDeliveryRequestButton } from './send-delivery-request-button';

const props = {
  recipients: {
    to: 'intake@example.invalid',
    cc: 'copy@example.invalid',
    toName: 'Intake',
  },
  orderId: 'f3d77cda-68aa-43a3-bb6b-09fce21291e4',
  orderNumber: 16,
  warehouseName: 'DC4',
  destination: { id: 'c1', name: 'CVW Clovis', code: 'CVW-CLO', address: { line1: '1 Main St', city: 'Clovis' } },
  requestedFor: 'Doua Vang',
  requesterEmail: 'doua@example.invalid',
  neededBy: '2026-10-01T21:00:00.000Z',
  orgTimezone: 'America/Los_Angeles',
  notes: '',
  lines: [{ itemId: 'i1', quantity: 3, name: 'Charger', sku: 'SP-CHRG-1' }],
};

let openSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  openSpy = vi
    .spyOn(window, 'open')
    .mockImplementation(() => ({ opener: null }) as unknown as Window);
  recordDrafted.mockClear();
});
afterEach(() => {
  openSpy.mockRestore();
});

describe('the delivery-request draft opens only from its click (Outlook rule 1)', () => {
  it('not on render, not when the page is read again after a revision, not when the host dialog opens; only on "Email delivery request" (mutation: open it from an effect)', () => {
    const { rerender } = render(<SendDeliveryRequestButton {...props} />);
    expect(openSpy).not.toHaveBeenCalled();

    // An approver moved the needed-by; the page was read again.
    rerender(<SendDeliveryRequestButton {...props} neededBy="2026-10-05T16:00:00.000Z" />);
    expect(openSpy).not.toHaveBeenCalled();

    // The requester opens the host dialog: the assistant mounts, nothing opens.
    fireEvent.click(screen.getByRole('button', { name: /send delivery request/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();

    // Read again while the dialog is open (realtime): still nothing.
    rerender(<SendDeliveryRequestButton {...props} neededBy="2026-10-06T16:00:00.000Z" />);
    expect(openSpy).not.toHaveBeenCalled();
    expect(recordDrafted).not.toHaveBeenCalled();

    // Their click, and only their click, opens the draft...
    fireEvent.click(screen.getByRole('button', { name: /email delivery request/i }));
    expect(openSpy).toHaveBeenCalledTimes(1);
    // ...carrying the needed-by the page shows now (9:00 AM in Los Angeles).
    // The mailto: rides inside the Outlook link, so it is encoded twice.
    const url = decodeURIComponent(decodeURIComponent(String(openSpy.mock.calls[0]![0])));
    expect(url).toContain('NEEDED BY\nOct 6, 2026, 9:00 AM (America/Los_Angeles)');
    expect(recordDrafted).toHaveBeenCalledTimes(1);
  });

  describe('source pins', () => {
    const code = (rel: string) =>
      readFileSync(path.resolve(__dirname, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    const count = (src: string, needle: string) => src.split(needle).length - 1;
    /** The text between the bracket at `open` and its partner. */
    function balanced(src: string, open: number): string {
      const pairs: Record<string, string> = { '(': ')', '{': '}' };
      const close = pairs[src[open]!]!;
      let depth = 0;
      for (let i = open; i < src.length; i += 1) {
        if (src[i] === src[open]) depth += 1;
        else if (src[i] === close) depth -= 1;
        if (depth === 0) return src.slice(open + 1, i);
      }
      throw new Error(`unbalanced from ${open}`);
    }

    const host = code('./send-delivery-request-button.tsx');
    const assistant = code('./storefront/delivery-request-action.tsx');

    it('the host dialog opens only from its trigger: uncontrolled, no open state, no effect (mutation: defaultOpen or an open prop)', () => {
      expect(host).toMatch(/<Dialog>\s*<DialogTrigger asChild>/);
      expect(host).not.toMatch(/defaultOpen|\bopen=\{|onOpenChange/);
      expect(host).not.toMatch(/\buse(Layout)?Effect\(/);
    });

    it('the assistant opens a draft in one function, handleOpen, and only its two buttons call it (mutation: a second call site)', () => {
      expect(count(assistant, 'window.open(')).toBe(1);
      expect(count(assistant, 'location.assign(')).toBe(1);
      const at = assistant.indexOf('function handleOpen()');
      expect(at).toBeGreaterThan(-1);
      const body = balanced(assistant, assistant.indexOf('{', at));
      expect(body).toContain('window.open(');
      expect(body).toContain('location.assign(');
      // Its declaration, the main button and the preview's "Open in Outlook".
      expect(count(assistant, 'handleOpen')).toBe(3);
      expect(assistant).toContain('onClick={handleOpen}');
      expect(assistant).toMatch(/onClick=\{\(\) => \{\s*handleOpen\(\);/);
    });

    it('no effect in the assistant reaches the composer (mutation: open it from an effect)', () => {
      const hooks = /\bReact\.(useEffect|useLayoutEffect)\(/g;
      const bodies: string[] = [];
      for (let m = hooks.exec(assistant); m; m = hooks.exec(assistant)) {
        bodies.push(balanced(assistant, m.index + m[0].length - 1));
      }
      expect(bodies.length).toBeGreaterThan(0);
      for (const b of bodies) expect(b).not.toMatch(/handleOpen|window\.open|location\.assign|recordDraft/);
    });
  });
});
