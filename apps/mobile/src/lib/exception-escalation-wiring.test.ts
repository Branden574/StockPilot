import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Escalate to maintenance on the phone (F1-5): WIRING PINS for the exception
 * screen, the Exceptions list, the request form and the request screen.
 *
 * The screens cannot render under this node test environment (vitest excludes
 * app/, which imports native modules at load), so the load-bearing wiring is
 * pinned at source level; the decisions themselves are pure and tested in
 * exception-escalation.test.ts and maintenance-filters.test.ts. Each pin
 * encodes an owner rule (2026-09-27):
 *   1. explicit: a tap on "Escalate to maintenance" opens the form; Save there
 *      makes the ONE linked request, through the escalate route;
 *   2. the email composer opens only on a tap on the request's screen: never
 *      from the exception screen or the form;
 *   3. online only: disabled offline with the reason, nothing queued;
 *   4. the web's gates: the server's hint AND the phone's module set and
 *      maintenance_requests:submit;
 *   5. the related location rides on every request (it was hard-coded null);
 *   6. 44pt targets and spoken names on every new control.
 */

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

/** Source with comments stripped, so a header explaining what a screen avoids
 *  cannot trip the negative pins. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const detail = codeOnly(read('../../app/exceptions/[id].tsx'));
const list = codeOnly(read('../../app/(drawer)/exceptions.tsx'));
const form = codeOnly(read('../../app/maintenance/new.tsx'));
const request = codeOnly(read('../../app/maintenance/[id].tsx'));

/** The code between two markers. Both must be there: a marker that went
 *  missing would otherwise slice to the end and pass vacuously. */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  expect(a, `missing marker: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `missing marker: ${to}`).toBeGreaterThan(a);
  return src.slice(a, b);
}

/** Every quoted string in the code (the words a person can see). */
function literals(code: string): string[] {
  return [...code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

describe('exception screen: the MAINTENANCE section', () => {
  // Mutation caught: a hard-coded true for either gate, or the gate computed
  // and left unused next to it.
  it('the phone\'s own gates are the module set and maintenance_requests:submit', () => {
    expect(detail).toContain("const maintenanceEnabled = enabledModules.has('maintenance_requests');");
    expect(detail).toContain("const canSubmitMaintenance = showWriteCta(perms, 'maintenance_requests:submit');");
    expect(detail).toMatch(
      /escalationSectionView\(\{\s+occurrence: o,\s+maintenanceEnabled,\s+canSubmit: canSubmitMaintenance,\s+online: !offline,\s+\}\)/,
    );
    expect(detail).toContain('maintenanceEnabled={maintenanceEnabled}');
    expect(detail).toContain('canSubmitMaintenance={canSubmitMaintenance}');
  });

  // Mutation caught: the button enabled offline, or offered without the view.
  it('the button is offered only by the view, and disabled with the reason offline', () => {
    const block = between(detail, '{escalation.offerButton ? (', '{escalation.note ? (');
    expect(block).toContain('disabled={escalation.buttonDisabledReason !== null}');
    expect(block).toContain('onPress={() => onEscalate(o)}');
    expect(block).toContain('{ESCALATE_TO_MAINTENANCE_LABEL}');
    expect(block).toContain('{ESCALATE_TO_MAINTENANCE_HELP}');
    expect(block).toContain('{escalation.buttonDisabledReason}');
    expect(detail).toContain('{escalation.show ? (');
  });

  // Rule 1 and 2: the button opens the FORM (Save there is the act); nothing
  // here escalates, emails or queues.
  it('Escalate opens the request form; this screen never escalates, opens a composer or queues', () => {
    expect(detail).toMatch(
      /onEscalate=\{\(occurrence\) => \{\s+rereadOnReturn\.current = true;\s+router\.push\(escalateFormRoute\(occurrence\) as unknown as Href\);/,
    );
    expect(detail).not.toMatch(/escalateException|openMaintenanceDraft|recordDraftOpened|Linking|openURL/);
    expect(detail).not.toMatch(/outbox|enqueue|AsyncStorage/);
  });

  it('"Escalated: MR-..." opens the request only when the view says the reader can, as a 44pt link', () => {
    const link = between(detail, '{escalation.badge && escalation.openRequestId ? (', ') : escalation.badge ? (');
    expect(link).toMatch(/^\{escalation\.badge && escalation\.openRequestId \? \(\s+<Pressable\s+accessibilityRole="link"/);
    expect(link).toContain('accessibilityLabel={escalation.badge}');
    expect(link).toContain('onPress={() => onOpenRequest(escalation.openRequestId!)}');
    expect(link).toContain('minHeight: MIN_TAP');
    expect(detail).toMatch(
      /onOpenRequest=\{\(requestId\) => \{\s+rereadOnReturn\.current = true;\s+router\.push\(`\/maintenance\/\$\{requestId\}` as Href\);/,
    );
    // Beside the state for every reader.
    expect(detail).toMatch(/\{escalation\.badge \? \(\s+<Pill status="default" dot=\{false\}>\s+\{escalation\.badge\}/);
    expect(detail).toContain('{escalation.requestState}');
  });

  // Mutation caught: re-reading on every focus (a double read on mount), or
  // never (coming back from the request still says "not yet opened").
  it('coming back from the form or the request re-reads once', () => {
    expect(detail).toMatch(
      /useFocusEffect\(\s+React\.useCallback\(\(\) => \{\s+if \(!rereadOnReturn\.current\) return;\s+rereadOnReturn\.current = false;\s+void load\(\);\s+\}, \[load\]\),\s+\);/,
    );
  });

  it('an escalated event names its request in the timeline (core words it)', () => {
    expect(detail).toMatch(/describeTimelineEvent\(\{[^}]*maintenanceRequestReference: e\.maintenanceRequestReference,\s+\}\)/);
  });
});

describe('Exceptions list', () => {
  // The experience review: the list never said a linked request had been
  // cancelled. Mutation caught: the pill worded without requestCancelled.
  it('shows "Escalated: MR-..." beside the state on an escalated row, "(request cancelled)" included', () => {
    expect(list).toMatch(
      /\{o\.escalation \? \(\s+<Pill status="default" dot=\{false\}>\s+\{escalationBadgeCopy\(o\.escalation\.reference, o\.escalation\.requestCancelled\)\}/,
    );
  });
});

describe('request form: escalating an exception', () => {
  it('reads the exception id and the location id from the route as uuids only', () => {
    expect(form).toContain('const target = escalationTarget(params.exceptionOccurrenceId);');
    expect(form).toContain("const escalationId = target.kind === 'escalate' ? target.occurrenceId : null;");
    expect(form).toContain('const relatedLocationId = uuidParam(params.locationId);');
  });

  // Mutation caught: the refusal removed (a malformed link opened an ordinary,
  // unlinked request form).
  it('a malformed exception param is refused, before any form renders', () => {
    const gate = between(form, "if (target.kind === 'malformed') {", '</GateScreen>');
    expect(gate).toContain('{ESCALATE_BAD_LINK_COPY}');
    expect(gate).toContain('return (');
    expect(form.indexOf("if (target.kind === 'malformed') {")).toBeLessThan(form.indexOf('<FormStep'));
  });

  // Rule 5. Mutation caught: `relatedLocationId: null` (the hard-code this
  // step removed), for every flow.
  it('the related location rides on every request', () => {
    const values = between(form, 'function formValues()', 'async function onSave()');
    expect(values).toMatch(/\n\s+relatedLocationId,\n/);
    expect(form).not.toContain('relatedLocationId: null');
    expect(form).toContain(
      'const hasLinkedRecord = Boolean(relatedItemId || relatedOrderRequestId || relatedRentalId || relatedLocationId);',
    );
  });

  it('prefills from the exception once, never over what the person typed', () => {
    expect(form).toContain('const detail = await getException(escalationId);');
    expect(form).toContain('const prefill = escalationFormPrefill(detail.occurrence);');
    expect(form).toContain('setSubject((typed) => typed || prefill.subject);');
    expect(form).toContain('setDescription((typed) => typed || prefill.description);');
    expect(form).toContain('if (!prefilled.current) {');
    // An answer for another workspace is an error, never a prefill.
    expect(form.indexOf('if (detail.organizationId !== orgId) {')).toBeLessThan(
      form.indexOf("setEscLoad({ kind: 'ready', occurrence: detail.occurrence });"),
    );
  });

  // Rule 3. Mutation caught: `online: true`, or Save not following the state.
  it('the form follows the escalation state, fed the live network state', () => {
    expect(form).toContain('const offline = isOfflineState(useNetworkState());');
    expect(form).toContain(
      'const escState = escalationFormState({ load: escLoad, online: !offline, saving, maintenanceEnabled: enabled });',
    );
    expect(form).toContain('if (!escalationId || escalating.current || !escState.saveEnabled) return;');
    expect(form).toContain('const saveDisabled = saving || (escalation !== null && !escalation.state.saveEnabled);');
    expect(form).toMatch(/onPress=\{onSave\}\s+disabled=\{saveDisabled\}\s+accessibilityRole="button"/);
    expect(form).toContain('{escalation.state.reason}');
    // No form until the exception can be escalated: only the card, with why.
    expect(form).toContain('escalationId && !escState.showForm ? (');
  });

  // Rule 1. Mutation caught: the escalation saved through the plain create
  // route (an unlinked request), or Save still wired to it.
  it('Save escalates through the escalate route, then opens the request\'s own screen', () => {
    expect(form).toContain('onSave={escalationId ? () => void onEscalate() : onSave}');
    const fn = between(form, 'async function onEscalate()', 'const [photoEntries, setPhotoEntries]');
    expect(fn).toContain('const created = await escalateException(escalationId, {');
    expect(fn).not.toContain('createMaintenanceRequest');
    expect(fn).toMatch(/subject: parsed\.data\.subject,\s+description: parsed\.data\.description,\s+priority: parsed\.data\.priority,\s+category: parsed\.data\.category \?\? null,/);
    expect(fn).toContain('router.replace(`/maintenance/${created.id}` as Href);');
  });

  // Mutation caught: always opening the 409's request (a reader who cannot
  // open it lands on an error).
  it('already escalated opens that request only for a reader who can open it', () => {
    const fn = between(form, 'async function onEscalate()', 'const [photoEntries, setPhotoEntries]');
    expect(fn).toContain('const outcome = duplicateOutcome(failure.duplicate, fresh, enabled);');
    expect(fn).toMatch(/if \(outcome\.kind === 'open'\) \{\s+router\.replace\(`\/maintenance\/\$\{outcome\.requestId\}` as Href\);/);
    expect(fn.match(/router\.replace\(/g)).toHaveLength(2);
  });

  // Rule 2 and 3.
  it('the form never opens a composer and queues nothing', () => {
    expect(form).not.toMatch(/openMaintenanceDraft|recordDraftOpened|Linking|openURL|mailto/);
    expect(form).not.toMatch(/outbox|enqueue|AsyncStorage|SecureStore/);
  });

  // A field the escalate route would drop is never offered.
  it('escalating shows only the four fields the route takes', () => {
    expect(form).toMatch(/\{escalation \? null : \(\s+<ChipPickerField label="SITE"/);
    expect(form).toMatch(/\{escalation \? null : \(\s+<>\s+<Field label="CONTACT PHONE \(OPTIONAL\)">/);
    expect(form).toContain('{hasLinkedRecord && !escalation ? (');
    expect(form).toContain('{escalation ? <EscalationSourceCard view={escalation} /> : null}');
  });

  it('a category is shown and sent only while the organization lists it', () => {
    expect(form).toContain('const shownCategory = listedCategory(categories, category);');
    expect(form).toContain('category: shownCategory,');
    expect(form).toContain('category={shownCategory}');
    expect(form).not.toContain('category: category || null');
  });

  it('no workspace: says so, with Try again that loads it again', () => {
    expect(form).toContain('if (escalationId && !orgId && !workspaceLoading) {');
    expect(form).toContain('{EXCEPTION_WORKSPACE_UNAVAILABLE}');
    expect(form).toContain('void retryWorkspace().finally(() => setRetrying(false));');
  });

  it('the linked-exception card uses core\'s words, and its controls are 44pt', () => {
    const card = between(form, 'function EscalationSourceCard(', 'function PhotosStep(');
    expect(card).toContain('{ESCALATE_TO_MAINTENANCE_HELP}');
    expect(card).toContain('{ESCALATION_FORM_NOTE_COPY}');
    expect(card).toContain('{state.openExisting.label}');
    expect(card).toMatch(/disabled=\{!view\.online\}\s+onPress=\{view\.onRetry\}\s+style=\{\{ alignSelf: 'flex-start', minHeight: 44 \}\}/);
    expect(card).toContain('accessibilityRole="alert"');
  });
});

describe('request screen: the related item and location', () => {
  // Mutation caught: the location row missing (the escalated exception's
  // location lives on the request but was never shown).
  it('shows them, named as the email names them, as 44pt links', () => {
    expect(request).toMatch(
      /maintenanceRelatedRows\(\{\s+relatedItemId: detail\.relatedItemId,\s+relatedLocationId: detail\.relatedLocationId,\s+relatedItem: emailContent\?\.relatedItem,\s+relatedLocation: emailContent\?\.relatedLocation,\s+\}\)/,
    );
    expect(request).toContain('<RelatedRow label="RELATED LOCATION" row={related.location}');
    expect(request).toContain('<RelatedRow label="RELATED ITEM" row={related.item}');
    const row = between(request, 'function RelatedRow(', 'function DetailRow(');
    expect(row).toContain('accessibilityRole="link"');
    expect(row).toContain('minHeight: 44');
  });
});

describe('honesty', () => {
  // Owner rule: never "sent" or "ticket created"; never "book" for the
  // recorded quantity. Over every string the four screens' code carries.
  it('no screen string claims a send, a ticket or a notification', () => {
    for (const code of [detail, list, form]) {
      for (const s of literals(code)) {
        expect(s).not.toMatch(/\bsent\b|ticket created|\bnotified\b|\bemailed\b|\bbook\b/i);
      }
    }
  });
});
