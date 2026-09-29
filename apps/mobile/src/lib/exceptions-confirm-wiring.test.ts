import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * COUNT DIFFERENCES ON THE PHONE (owner decision 2026-09-29, after EX-000059):
 * WIRING PINS for the exception screen's top WHAT CLEARS THIS section, the
 * Acknowledge sheet's own help, and the dormant Confirm this count sheet.
 *
 * The screens cannot render under this node test environment (app/ imports
 * native modules at load), so the load-bearing wiring is pinned at source
 * level. The words are core's (exception-confirm.test.ts) and the view is
 * pure (exception-confirm-view.test.ts). Each pin is a rule the plan sets:
 *   1. for a count difference, WHAT CLEARS THIS sits under the header, above
 *      the facts, with the linked recount and Recount inside it; no separate
 *      RECOUNT section and no bottom WHAT CLEARS THIS for the rule;
 *   2. Acknowledge is an outline button there, and its sheet says it does not
 *      clear it;
 *   3. Confirm shows only when the server's block says so; online only,
 *      never queued: offline it is disabled with the reason, and the sheet's
 *      button disables live;
 *   4. switching from Acknowledge to Confirm keeps the typed note;
 *   5. VoiceOver and 44 pt: a modal sheet with an escape, a header, a 44 pt
 *      Close, a backdrop that is a button, the numbers as one element, errors
 *      and success announced.
 */

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

/** Source with comments stripped, so a header explaining what a screen avoids
 *  cannot trip the negative pins. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const detail = codeOnly(read('../../app/exceptions/[id].tsx'));
const sheet = codeOnly(read('../components/exception-note-sheet.tsx'));
const list = codeOnly(read('../../app/(drawer)/exceptions.tsx'));

/** The source of one function component in a file. */
function component(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe('exception screen: a count difference opens with what clears it', () => {
  it('works the view out once, from the live network state', () => {
    expect(detail).toContain('countVarianceView(state.detail, { online: !offline })');
    expect(detail).toContain('countVarianceView(detail, { online: !offline })');
    expect(detail).not.toMatch(/countVarianceView\([^)]*online: true/);
  });

  it('WHAT CLEARS THIS sits under the header, above the facts, for a count difference only', () => {
    const top = detail.indexOf('<CountVarianceClears');
    expect(top).toBeGreaterThan(detail.indexOf('{d.detail}'));
    expect(top).toBeLessThan(detail.indexOf('label="ITEM"'));
    expect(detail).toContain('{cv ? (');
  });

  // 11.8: the RECOUNT section and the bottom WHAT CLEARS THIS are not
  // rendered for this rule.
  it('no separate RECOUNT section and no bottom WHAT CLEARS THIS for the rule', () => {
    expect(detail).toContain('const showRecount = isRecountableRule(o.rule) && !countVariance && !resolved;');
    expect(detail).toMatch(/\{countVariance \? null : \(\s+<Section title="WHAT CLEARS THIS">/);
  });

  it('the section carries the linked recount, Recount and why not, with a header role', () => {
    const top = component(detail, 'CountVarianceClears');
    expect(top).toContain('<Eyebrow accessibilityRole="header">');
    expect(top).toContain('COUNT_VARIANCE_CLEARS_TITLE.toUpperCase()');
    expect(top).toContain('{view.clear.lead}');
    expect(top).toContain('{view.clear.options}');
    expect(top).toContain('activeRecountCopy(occurrence.recount)');
    expect(top).toContain('RECOUNT_NONE_LINKED_COPY');
    expect(top).toContain('{view.clear.recountLine}');
    expect(top).toContain('{view.clear.reason}');
    // Recount is filled when Confirm is not offered, outline beside it.
    expect(top).toContain("variant={view.clear.offerConfirm ? 'outline' : 'primary'}");
    expect(top).toContain('disabled={recountReason !== null}');
  });

  // Mutation caught: Confirm rendered without the server's yes.
  it('Confirm only when the server offers it; disabled offline with the reason as its hint', () => {
    const top = component(detail, 'CountVarianceClears');
    expect(top).toContain('{view.clear.offerConfirm ? (');
    expect(top).toContain('disabled={view.clear.confirmDisabledReason !== null}');
    expect(top).toContain(
      'accessibilityHint={view.clear.confirmDisabledReason ?? confirmCountButtonHint({ facts: occurrence.facts, reference: occurrence.reference })}',
    );
    expect(top).toContain("onPress={onConfirm}");
    expect(detail).toContain("onConfirm={() => onOpenSheet('confirm_count')}");
  });

  it('Acknowledge is an outline button on a count difference', () => {
    expect(detail).toContain("variant={countVariance ? 'outline' : 'primary'}");
  });

  it('hands the sheet the help and what a confirm needs', () => {
    expect(detail).toContain('acknowledgeHelp={view?.acknowledgeHelp ?? null}');
    expect(detail).toContain('confirm={view?.confirm ?? null}');
  });

  it('after a confirm: re-reads, refreshes the physical count card, says it and announces it', () => {
    expect(detail).toMatch(/if \(done\.mode === 'confirm_count'\) \{\s+setVerificationNonce\(\(n\) => n \+ 1\);\s+setNotice\(confirmCountSuccessCopy\(state\.detail\.occurrence\.reference\)\);/);
    expect(detail).toContain('AccessibilityInfo.announceForAccessibility(notice)');
    expect(detail).toContain('{notice ? (');
  });

  it('a confirmed row reads with who confirmed it, and a reason it cannot word never reads "Cleared"', () => {
    expect(detail).toContain('confirmationFactsRow(o.confirmation, exceptionTimeLabel(o.confirmation.at, detail.timeZone))');
    expect(detail).toContain(
      'countConfirmationFor(o.facts, o.confirmation?.as ?? null, e.cycleCount?.countNumber ?? null)',
    );
    expect(detail).toContain('resolvedReasonCopy(h.resolvedReason, h.confirmedAs)');
    expect(detail).toContain('resolvedReasonCopy(o.resolvedReason, o.confirmation?.as ?? null)');
    expect(detail).toContain('displayedStateOf(detail)');
    expect(detail).not.toContain('OCCURRENCE_RESOLVED_REASON_COPY[');
    expect(detail).not.toContain("?? 'cleared'");
  });
});

describe('the exceptions list: a confirmed row shows who confirmed it', () => {
  it('passes the role to core, and never guesses a reason', () => {
    expect(list).toContain('confirmedAs: item.occurrence.confirmation?.as ?? null,');
    expect(list).not.toContain("?? 'cleared'");
  });
});

describe('the Acknowledge / Add note / Confirm this count sheet', () => {
  it('one component, three modes; the mode switches in place so the note is kept', () => {
    expect(sheet).toContain('const [mode, setMode] = React.useState<ExceptionSheetMode>(initialMode);');
    // Remounted per opening only: the key is the opening's mode, not the
    // current one.
    expect(sheet).toContain('key={`${String(visible)}:${mode}`}');
    expect(sheet).toContain('initialMode={mode}');
    const sw = sheet.slice(sheet.indexOf('function switchToConfirm'), sheet.indexOf('function switchToConfirm') + 200);
    expect(sw).toContain("setMode('confirm_count');");
    expect(sw).not.toContain('setNote(');
  });

  it('offers Confirm this count instead only with the server\'s yes, in the Acknowledge help', () => {
    expect(sheet).toContain("{mode === 'acknowledge' && block?.canConfirm ? (");
    expect(sheet).toContain('{CONFIRM_COUNT_INSTEAD_LABEL}');
    expect(sheet).toContain('{acknowledgeHelp ?? EXCEPTION_ACKNOWLEDGE_HELP}');
  });

  // Mutation caught: `online: true`, or canConfirm read loosely.
  it('online only and live: the shared gate, fed the live state and the server\'s canConfirm', () => {
    expect(sheet).toMatch(
      /exceptionSheetSubmit\(\{\s+mode,\s+note,\s+submitting,\s+online,\s+canAct: occurrence\.canAct,\s+resolved: occurrence\.resolvedAt !== null,\s+canConfirm: block\?\.canConfirm === true,\s+confirmUnavailable: confirm\?\.unavailable \?\? null,/,
    );
    expect(sheet).not.toMatch(/online:\s*true/);
    expect(sheet).toContain('disabled={!submitState.enabled}');
  });

  it('confirms through the Bearer route with the count and number shown; never queued, no client id', () => {
    expect(sheet).toMatch(
      /confirmExceptionCount\(occurrence\.id, \{\s+cycleCountId: block\.cycleCountId,\s+countedQuantity: block\.counted,\s+note: payloadNote,\s+\}\)/,
    );
    expect(sheet).toContain('onDone(res.occurrence, { mode, replay: res.replay });');
    expect(sheet).toContain('setError(describeConfirmCountError(e, confirm?.errorContext ?? FALLBACK_ERROR_CONTEXT));');
    expect(sheet).not.toMatch(/enqueue|outbox|queueMutation/i);
    const confirmPath = sheet.slice(
      sheet.indexOf("if (mode === 'confirm_count') {"),
      sheet.indexOf('const clientEventId = clientEventIdFor('),
    );
    expect(confirmPath).toContain('confirmExceptionCount(');
    expect(confirmPath).not.toContain('clientEventId');
  });

  it('shows the numbers as one VoiceOver element, the consequence, and the confirm buttons', () => {
    expect(sheet).toMatch(/<View\s+accessible\s+accessibilityLabel=\{dialog\.numbersLabel\}/);
    expect(sheet).toContain('{dialog.consequence}');
    expect(sheet).toContain('dialog.confirmLabel');
    expect(sheet).toContain('dialog.pendingLabel');
    expect(sheet).toContain('{dialog.cancelLabel}');
    expect(sheet).toContain("accessibilityLabel={mode === 'note' ? 'Note' : 'Note, optional'}");
  });

  it('is a modal VoiceOver can escape, with a header, a 44 pt Close and a backdrop that is a button', () => {
    expect(sheet).toContain('accessibilityViewIsModal');
    expect(sheet).toContain('onAccessibilityEscape={requestClose}');
    expect(sheet).toContain('onAccessibilityTap={requestClose}');
    expect(sheet).toMatch(/accessibilityRole="header"/);
    expect(sheet).toContain('minWidth: MIN_TAP');
    expect(sheet).toContain('minHeight: MIN_TAP');
    expect(sheet).not.toContain('hitSlop={8}');
  });

  it('a refusal is inline and announced; a confirm under way cannot be dismissed', () => {
    expect(sheet).toContain('accessibilityRole="alert"');
    expect(sheet).toContain('AccessibilityInfo.announceForAccessibility(error)');
    expect(sheet).toMatch(/function requestClose\(\) \{\s+if \(submitting\) return;\s+onClose\(\);/);
  });
});
