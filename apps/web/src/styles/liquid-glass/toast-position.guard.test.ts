// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { cssRules, glassSourceFiles } from './glass-css';

/**
 * THE TOAST STAYS BOTTOM RIGHT IN LIQUID GLASS (owner report 2026-11-12: on
 * the order page the glass toasts appeared bottom centre, classic's appear
 * bottom right). Sonner places its toaster from the position the app gives it
 * (components/ui/sonner.tsx: bottom-right) with its own left, right, transform
 * and width; the glass dock had overridden those from 601 px to centre the
 * stack on the workspace pane. No glass stylesheet may set them on the
 * toaster again, at any width: only its bottom may move (the lifts over a
 * floating bar), so the toast sits in the same corner in both looks and keeps
 * sonner's phone layout. The layout itself was measured in Chromium and WebKit
 * at 1440 x 900 and 390 x 844 (the PR's measurement script).
 */

/** Properties that would move or size the toaster or its toasts sideways. */
const SIDEWAYS =
  /^(left|right|inset|inset-inline|inset-inline-start|inset-inline-end|transform|translate|width|min-width|max-width|margin|margin-left|margin-right|margin-inline|margin-inline-start|margin-inline-end|position)$/u;

/** A selector whose subject is sonner's toaster (the ol) or one of its toasts (the li). */
const TOASTER = /\[data-sonner-toaster\][^\s>+~]*$|\[data-sonner-toast\][^\s>+~]*$/u;

describe('Liquid Glass leaves the toast where sonner puts it, bottom right', () => {
  const hits: string[] = [];
  for (const { file } of glassSourceFiles()) {
    for (const rule of cssRules(file)) {
      for (const selector of rule.selectors) {
        if (!TOASTER.test(selector.replace(/\s+/gu, ' ').trim())) continue;
        for (const prop of Object.keys(rule.decls)) {
          if (SIDEWAYS.test(prop)) hits.push(`${file}: ${selector} { ${prop} }`);
        }
      }
    }
  }

  it('no glass rule sets the toaster’s or a toast’s left, right, transform, width or position', () => {
    expect(hits).toEqual([]);
  });

  it('the glass rules that do reach the toaster still exist (the guard is not reading nothing)', () => {
    const toasterRules = glassSourceFiles().flatMap(({ file }) =>
      cssRules(file).filter((r) =>
        r.selectors.some((s) =>
          /ol\[data-sonner-toaster\]\[data-y-position='bottom'\]$/u.test(
            s.replace(/"/gu, "'").trim(),
          ),
        ),
      ),
    );
    expect(toasterRules.length).toBeGreaterThan(0);
    for (const rule of toasterRules) expect(Object.keys(rule.decls)).toEqual(['bottom']);
  });
});
