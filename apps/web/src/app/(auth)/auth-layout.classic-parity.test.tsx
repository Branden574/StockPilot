import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AuthLayout from './layout';

/**
 * CLASSIC PARITY OF THE SIGN-IN SHELL (Liquid Glass stage 3, site lane;
 * IMPLEMENTATION-PLAN.md 4.4, 4.7; plans/REVISION-DEFAULT.md R5).
 *
 * app/(auth)/layout.tsx frames /signin, /signin/mfa, /signup, /reset,
 * /reset/complete and /account-disabled. Liquid Glass draws Auth-SignIn.dc.html's
 * frame on it with CSS (styles/liquid-glass/auth.glass.css) plus a few
 * glass-only elements. Classic must not change:
 *  - under the `off` rollout the server HTML is the pinned file byte for byte
 *    and holds no glass-only element at all (R5; the inert data-glass hooks
 *    the shared ui parts carry since stage 2 are in the pinned file too);
 *  - under `opt-in` and `default` it equals the pinned file once the inert
 *    hook attributes (data-glass, data-glass-*) and the [data-glass-only]
 *    elements are removed, which is exactly the normalisation of the lab's
 *    parity run (DECISIONS.md, "PROOF NORMALISATION DECIDED"); the glass-only
 *    elements are hidden in classic by styles/liquid-glass/visibility.css.
 *
 * The pinned file under __parity__ was written from the layout at the stage 3
 * base (d718726e0) before any glass element was added. The page itself is a
 * fixed child here: the layout is what this file pins.
 */

const ROLLOUTS = ['off', 'opt-in', 'default'] as const;
const PIN = './__parity__/auth-layout.html';

function layoutHtml(): string {
  return renderToString(
    <AuthLayout>
      <p>page</p>
    </AuthLayout>,
  ).replace(/></gu, '>\n<');
}

/**
 * The lab run's normalisation: glass-only elements and inert glass hooks
 * removed, and React's useId values mapped to tokens in order of appearance
 * (an element added before a part that calls useId shifts its value).
 */
function normalised(html: string): string {
  const host = document.createElement('div');
  host.innerHTML = html;
  for (const el of host.querySelectorAll('[data-glass-only]')) el.remove();
  for (const el of host.querySelectorAll('*')) {
    for (const name of el.getAttributeNames()) {
      if (name === 'data-glass' || name.startsWith('data-glass-')) el.removeAttribute(name);
    }
  }
  const ids = new Map<string, string>();
  return host.innerHTML.replace(/_R_[A-Za-z0-9]+_/gu, (id) => {
    if (!ids.has(id)) ids.set(id, `useid-${ids.size}`);
    return ids.get(id)!;
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the classic sign-in shell renders as at the stage 3 base', () => {
  it('off: byte for byte, with no glass-only element', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    const html = layoutHtml();
    expect(html).not.toMatch(/data-glass-only/u);
    await expect(html).toMatchFileSnapshot(PIN);
  });

  for (const rollout of ROLLOUTS) {
    it(`${rollout}: equal to the pinned file once the inert hooks and glass-only elements are removed`, async () => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      const { readFile } = await import('node:fs/promises');
      const pinned = await readFile(new URL(PIN, import.meta.url), 'utf8');
      expect(normalised(layoutHtml())).toBe(normalised(pinned));
    });
  }
});
