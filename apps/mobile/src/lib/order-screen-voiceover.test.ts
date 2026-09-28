import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import {
  approveShortNotice,
  ORDER_LINE_HIDDEN_ITEM_NAME,
  READINESS_NEEDS_CONNECTION_COPY,
  READINESS_ORDER_CHANGED_COPY,
  READINESS_READ_FAILED_COPY,
  REQUESTER_CHECK_FAILED_COPY,
  type OrderReadinessResult,
} from '@stockpilot/core';
import { describe, expect, it } from 'vitest';

import { attrText, parseTsx, tagOf, walkJsx, type JsxNode } from './__fixtures__/jsx-touch-audit';
import { readinessFailureAnnouncement } from './order-readiness';

/**
 * F2-1 PHONE WALK (2026-09-28, iPad simulator, VoiceOver inspector): what
 * VoiceOver says on the order screen, and the name of a line's item.
 *   D1  offline, a line row kept the Button trait (enabled) and did nothing;
 *   O1  a disabled Approve partial / Resume fulfillment did not say why (the
 *       reason was read later, after Deny);
 *   O2  "Couldn't check readiness" had role 'alert', which iOS does not
 *       announce;
 *   O4  a line whose item the viewer cannot read said "Unknown item" (the web:
 *       "Deleted item").
 * The screen imports native modules, so vitest cannot render it: the words
 * are tested here as functions, and the screen is pinned to use them.
 */

const screen = readFileSync(path.resolve(__dirname, '../../app/order/[id].tsx'), 'utf8');
const summary = readFileSync(
  path.resolve(__dirname, '../components/order-readiness-summary.tsx'),
  'utf8',
);

/** Source with comments stripped. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const FAILED: OrderReadinessResult = { state: 'failed', message: 'Could not check readiness.' };

describe('O2: a failed readiness check is announced when it appears', () => {
  it('the full panel announces its failed headline', () => {
    expect(readinessFailureAnnouncement(FAILED, 'full')).toBe(READINESS_READ_FAILED_COPY);
  });

  it("with core's reason when it names one (the line the card shows under the headline)", () => {
    expect(
      readinessFailureAnnouncement(
        { state: 'failed', message: READINESS_ORDER_CHANGED_COPY },
        'full',
      ),
    ).toBe(`${READINESS_READ_FAILED_COPY} ${READINESS_ORDER_CHANGED_COPY}`);
  });

  it("the requester's card announces its own sentence", () => {
    expect(readinessFailureAnnouncement(FAILED, 'requester')).toBe(REQUESTER_CHECK_FAILED_COPY);
  });

  it('an answer that did not fail announces nothing (the headline is read in place)', () => {
    const ok = {
      state: 'ok',
      assessment: { phase: 'closed', observedAt: '2026-09-28T18:00:00Z', order: {} },
    } as unknown as OrderReadinessResult;
    expect(readinessFailureAnnouncement(ok, 'full')).toBeNull();
    expect(readinessFailureAnnouncement(ok, 'requester')).toBeNull();
    expect(readinessFailureAnnouncement(null, 'full')).toBeNull();
  });

  it('the card announces it with AccessibilityInfo when it appears, keyed on the words (not on every render)', () => {
    const s = codeOnly(summary);
    expect(s).toMatch(/import \{[^}]*\bAccessibilityInfo\b[^}]*\} from 'react-native';/);
    expect(s).toContain(
      'const announcement = readinessFailureAnnouncement(result, audience, opts);',
    );
    expect(s).toMatch(
      /React\.useEffect\(\(\) => \{\s*if \(announcement\) AccessibilityInfo\.announceForAccessibility\(announcement\);\s*\}, \[announcement\]\);/,
    );
    // Before any early return (a hook must run on every render).
    expect(s.indexOf('React.useEffect(')).toBeLessThan(s.indexOf('return null;'));
  });
});

/** The screen's line row: the Pressable whose press opens the line editor. */
function lineRow(): { el: JsxNode; sf: ReturnType<typeof parseTsx> } {
  const sf = parseTsx(screen, 'app/order/[id].tsx');
  const found: JsxNode[] = [];
  walkJsx(sf, (el) => {
    if (
      tagOf(el, sf) === 'Pressable' &&
      (attrText(el, 'onPress', sf) ?? '').includes('setEditLineId(')
    ) {
      found.push(el);
    }
  });
  expect(found).toHaveLength(1);
  return { el: found[0]!, sf };
}

describe('D1: a line row that cannot be edited is not announced as a button', () => {
  it("sets the role explicitly ('none', never undefined, which leaves iOS's Button trait on the row)", () => {
    const { el, sf } = lineRow();
    expect(attrText(el, 'accessibilityRole', sf)).toBe("editable ? 'button' : 'none'");
  });

  it('offline, a row that could be edited online says it is disabled, and why', () => {
    const { el, sf } = lineRow();
    expect(screen).toContain(
      'const editBlockedOffline = canEditItems && l.orderRequestLineId !== null && offline;',
    );
    expect(attrText(el, 'accessibilityState', sf)).toBe('{ disabled: editBlockedOffline }');
    expect(attrText(el, 'accessibilityHint', sf)).toBe(
      'editBlockedOffline ? READINESS_NEEDS_CONNECTION_COPY : undefined',
    );
    // Still never tappable offline.
    expect(screen).toContain(
      'const editable = canEditItems && l.orderRequestLineId !== null && !offline;',
    );
    expect(attrText(el, 'onPress', sf)).toMatch(/^editable \? /);
    expect(READINESS_NEEDS_CONNECTION_COPY).toBe('Needs a connection.');
  });
});

describe('O1: a disabled action says why in its hint (the web links the reason with aria-describedby)', () => {
  it('actionBtn takes the reason and gives it to VoiceOver only while the button is disabled', () => {
    const code = codeOnly(screen);
    expect(code).toMatch(
      /const actionBtn = \(\s*label: string,\s*busyKey: string,\s*onPress: \(\) => void,\s*tone: 'primary' \| 'danger' \| 'default' = 'primary',\s*disabledByCaller = false,\s*disabledReason: string \| null = null,\s*\) => \{/,
    );
    expect(code).toMatch(
      /const hint = disabledByCaller\s*\? \(disabledReason \?\? undefined\)\s*: offline && !WORKS_OFFLINE\.has\(busyKey\)\s*\? READINESS_NEEDS_CONNECTION_COPY\s*: undefined;/,
    );
    expect(code).toContain('accessibilityHint={hint}');
  });

  it("Approve partial and Resume fulfillment pass core's notice as that reason", () => {
    const code = codeOnly(screen);
    expect(code).toMatch(
      /'Approve partial',\s*'approve-partial',[\s\S]*?stockGates\.approvePartial === 'disabled',\s*stockGates\.notice,\s*\)/,
    );
    expect(code).toMatch(
      /'Resume fulfillment',\s*'resume',[\s\S]*?stockGates\.resume === 'disabled',\s*stockGates\.notice,\s*\)/,
    );
    // The note under Approve is not a reason for a disabled button.
    expect(approveShortNotice({ state: 'not_needed' })).toBeNull();
  });
});

describe('O4: a line whose item the viewer cannot read', () => {
  it("is named by core's one label, the web's too", () => {
    const code = codeOnly(screen);
    expect(code).toContain('name: orderLineItemName(itemObj),');
    expect(code).not.toContain("'Unknown item'");
    expect(ORDER_LINE_HIDDEN_ITEM_NAME).toBe("An item you can't see");
  });
});
