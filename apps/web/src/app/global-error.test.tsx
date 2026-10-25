// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import GlobalError from './global-error';

/**
 * CONFLICTS D1, the last-resort page: "Sign out and back in" pointed at
 * /signin, which bounces a signed-in visitor back to the dashboard. It now
 * loads the cookie-clearing sign-out route in this tab (its click is checked
 * in global-error.sign-out.test.tsx). It is a button, never a link to the
 * route: a link could be opened in another tab, which signs out without
 * running anything here. The page keeps inline styles only (no Tailwind, no
 * tokens) and its words.
 */
describe('global-error', () => {
  const html = renderToStaticMarkup(
    <GlobalError error={Object.assign(new Error('x'), { digest: 'd-1' })} reset={() => {}} />,
  );

  it('"Sign out and back in" is a button, and nothing links to the sign-out route or to /signin', () => {
    expect(html).toMatch(/<button type="button"[^>]*>Sign out and back in<\/button>/);
    expect(html).not.toContain('href="/auth/session-ended');
    expect(html).not.toContain('href="/signin"');
  });

  it('keeps its words and its other ways out', () => {
    for (const words of [
      'Something went wrong',
      'We hit a problem loading the page',
      'Try again',
      'Go to dashboard',
    ]) {
      expect(html).toContain(words);
    }
    expect(html).toMatch(/Error id: (<!-- -->)?d-1/);
    expect(html).toContain('href="/dashboard"');
  });

  it('styles itself inline only, with the redesign dark palette', () => {
    expect(html).not.toMatch(/class="/);
    expect(html).toContain('background:#0c0d0a');
    expect(html).toContain('color:#f0efe8');
  });
});
