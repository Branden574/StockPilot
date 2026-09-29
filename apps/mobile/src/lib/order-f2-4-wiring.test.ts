import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * F2-4 CALL-SITE PINS: Outlook rule 1 on the phone. Changing an order's
 * needed-by generates no email, and the requester's "Email delivery request"
 * draft (which already carries the current needed-by) opens only when they
 * tap it: never on render, on a refresh, on focus or on an offline replay.
 * The order screen imports native modules, so vitest cannot render it; these
 * pins keep the one path from the composer to the OS a tap. (The web twin:
 * send-delivery-request-button.test.tsx, "does not mount the assistant until
 * opened".) Each names the mutation it catches.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const SCREEN_FILE = 'app/order/[id].tsx';

/** Source with comments stripped, so a comment cannot satisfy a pin. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const screen = codeOnly(readFileSync(path.join(MOBILE_ROOT, SCREEN_FILE), 'utf8'));

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

/** The body of `function name(...) { ... }` in the screen. */
function functionBody(name: string): string {
  const at = screen.search(new RegExp(`function ${name}\\(`));
  expect(at, `function ${name} is in ${SCREEN_FILE}`).toBeGreaterThan(-1);
  return balanced(screen, screen.indexOf('{', screen.indexOf(')', at)));
}

function count(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

describe('the delivery-request draft opens only on a tap (Outlook rule 1)', () => {
  it('the OS opener is called in one place, runDeliveryOpen (mutation: a second call site)', () => {
    expect(count(screen, 'openDeliveryRequestDraft(')).toBe(1);
    expect(functionBody('runDeliveryOpen')).toContain('openDeliveryRequestDraft(');
  });

  it('runDeliveryOpen runs from the press handler and its "Open Another Draft" button only', () => {
    // Every call, not the declaration (`async function runDeliveryOpen()`).
    const calls = count(screen, 'runDeliveryOpen()') - count(screen, 'function runDeliveryOpen()');
    const press = functionBody('handleDeliveryRequestPress');
    expect(calls).toBe(2);
    expect(count(press, 'runDeliveryOpen()')).toBe(calls);
    expect(press).toMatch(/text: 'Open Another Draft', onPress: \(\) => void runDeliveryOpen\(\)/);
  });

  it('the press handler is wired to the "Email delivery request" button and nothing else', () => {
    expect(count(screen, 'handleDeliveryRequestPress')).toBe(2); // its declaration and the button
    expect(screen).toMatch(/actionBtn\('Email delivery request', 'delivery-request', handleDeliveryRequestPress\)/);
  });

  it('no effect, focus or refresh callback reaches the composer (mutation: open it from an effect)', () => {
    const hooks = /\b(?:React\.)?(useEffect|useLayoutEffect|useFocusEffect|useCallback)\(/g;
    const bodies: string[] = [];
    for (let m = hooks.exec(screen); m; m = hooks.exec(screen)) {
      bodies.push(balanced(screen, m.index + m[0].length - 1));
    }
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      expect(b).not.toMatch(/runDeliveryOpen|handleDeliveryRequestPress|openDeliveryRequestDraft/);
    }
  });
});
