import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS for the return request on the phone (F14). The mobile suite has
 * no React Native renderer, so the screens are read as text (comments
 * removed) and what a screen could lose silently is pinned: the section is
 * drawn only behind the tested gate, the draft is opened through the shared
 * transport, only a confirmed open is recorded, and the words on screen are
 * the shared ones. The decisions themselves are tested in
 * return-request-actions.test.ts.
 */

const ROOT = path.resolve(__dirname, '../..');
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

const section = code('src/components/return-request-section.tsx');
const workbench = code('src/components/return-workbench-view.tsx');
const order = code('app/order/[id].tsx');
const lib = code('src/lib/return-request-actions.ts');

describe('the RETURN REQUEST section', () => {
  it('opens through the shared transport and records only inside the opened callback', () => {
    expect(section).toContain('openReturnRequestDraft(prepared, platform, () => {');
    const opened = section.slice(section.indexOf('openReturnRequestDraft(prepared, platform, () => {'));
    const callback = opened.slice(0, opened.indexOf('});') + 3);
    expect(callback).toContain('setDraftCount((n) => n + 1)');
    expect(callback).toContain('recordReturnRequestDrafted({');
    // Recorded nowhere else: not on the press, not on a blocked open, not on copy.
    expect(section.match(/recordReturnRequestDrafted\(/g)).toHaveLength(1);
    // It never opens a link itself.
    expect(section).not.toMatch(/Linking\.|openURL/);
  });

  it('a draft too long for a link opens nothing and goes to the copy box; a second draft asks first', () => {
    const press = section.slice(section.indexOf('function handlePress()'), section.indexOf('return (\n    <View'));
    expect(press.indexOf('!prepared.linkFits')).toBeGreaterThan(-1);
    expect(press.indexOf('!prepared.linkFits')).toBeLessThan(press.indexOf('runOpen()'));
    expect(press).toContain('shouldConfirmBeforeOpening(draftCount)');
    expect(press).toContain('RETURN_REQUEST_COPY.duplicate');
  });

  it('is fitted to the one probe answer, and says what it does before any press', () => {
    expect(section.match(/nativeOutlookAvailable\(\)/g)).toHaveLength(1);
    expect(section).toContain('prepareMobileReturnRequest(content, recipients, nativeOutlook)');
    for (const words of [
      'RETURN_REQUEST_COPY.primary',
      'RETURN_REQUEST_COPY.honesty',
      'RETURN_REQUEST_COPY.copy',
      'RETURN_REQUEST_COPY.oversized',
      'returnRequestRecipientsText(recipients)',
      'returnRequestSuccessMessage(result.used)',
      'returnRequestBlockedHeadline(result.attempted)',
    ]) {
      expect(section, words).toContain(words);
    }
    // The copy box always carries the whole message.
    expect(section).toContain('value={prepared.clipboardText}');
    // No sentence typed on the screen claims a send or a ticket.
    expect(section).not.toMatch(/>\s*[^<{]*\b(sent|ticket)\b/i);
  });

  it('draws for Classic and Liquid Glass: the glass heading under glass, the eyebrow otherwise', () => {
    expect(section).toContain('useGlass()');
    expect(section).toMatch(/lg \? \(\s*<GlassHeading>\{sentenceCase\(RETURN_REQUEST_COPY\.eyebrow\)\}<\/GlassHeading>/);
    expect(section).toContain('<Eyebrow accessibilityRole="header">{RETURN_REQUEST_COPY.eyebrow}</Eyebrow>');
  });
});

describe('the return screen', () => {
  it('draws the section only behind the gate, from the mailboxes the read answered', () => {
    expect(workbench).toContain('setRequestEmail(returnRequestEmailFromWorkbench(next.returnRequestEmail))');
    expect(workbench).toContain('returnRequestContentForWorkbench({ ...wb, exchange: ex }, requestEmail)');
    expect(workbench).toMatch(/\{requestContent && requestEmail\.recipients \? \(\s*<ReturnRequestSection/);
    expect(workbench).toContain('surface="return"');
    expect(workbench).toContain('orderId={r.orderRequestId}');
    // An action's answer never clears it; another return does.
    const adopt = workbench.slice(workbench.indexOf('function adopt('), workbench.indexOf('function adopt(') + 200);
    expect(adopt).not.toContain('setRequestEmail');
    expect(workbench).toContain('setRequestEmail(NO_REQUEST_EMAIL);');
  });

  it("offers Report a problem behind the item screen's two gates, with the order and the return number", () => {
    expect(workbench).toContain(
      "enabledModules.has('maintenance_requests') && showWriteCta(permissions, 'maintenance_requests:submit')",
    );
    expect(workbench).toMatch(/\{canReportProblem \? \(\s*<Button/);
    expect(workbench).toContain("pathname: '/maintenance/new'");
    expect(workbench).toContain('params: returnProblemLaunchParams(r)');
  });
});

describe('the order screen', () => {
  it('reads the mailboxes only when a request could be written about, never offline, and keeps them with their order', () => {
    expect(order).toContain('const returnRequestWanted = anyReturnRequestSendable(returnsShown.tracking);');
    expect(order).toContain('if (!returnRequestOrderId || !returnRequestWanted || offline) return;');
    expect(order).toContain('getReturnRequestEmailForOrder(returnRequestOrderId)');
    expect(order).toContain(
      'returnRequestRead && returnRequestRead.orderId === returnRequestOrderId ? returnRequestRead.email : null',
    );
  });

  it('draws the section under a tracking card only behind the gate', () => {
    expect(order).toContain('const content = returnRequestContentForTracking(t, returnRequestEmail);');
    expect(order).toMatch(/<RequesterTrackingCard request=\{t\} \/>\s*\{content && returnRequestEmail\?\.recipients && order \? \(\s*<ReturnRequestSection/);
    expect(order).toContain('surface="order"');
  });
});

describe('the lib', () => {
  it('holds no compiled mailbox and reads the server routes it names', () => {
    expect(lib).not.toMatch(/@[a-z0-9.-]+\.(com|org|net|test)/i);
    expect(lib).not.toContain('DELIVERY_REQUEST_RECIPIENTS');
    expect(lib).toContain('/return-request-email`');
    expect(lib).toContain('/return-request-drafted`');
  });
});
