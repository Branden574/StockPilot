// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import GlobalError from './global-error';

/**
 * CONFLICTS D1, the last-resort page: "Sign out and back in" pointed at
 * /signin, which bounces a signed-in visitor back to the dashboard. It now
 * goes to the cookie-clearing sign-out route. The page keeps inline styles
 * only (no Tailwind, no tokens) and its words.
 */
describe('global-error', () => {
  const html = renderToStaticMarkup(
    <GlobalError error={Object.assign(new Error('x'), { digest: 'd-1' })} reset={() => {}} />,
  );

  it('"Sign out and back in" goes to the sign-out route, not /signin', () => {
    expect(html).toMatch(/<a href="\/auth\/session-ended"[^>]*>Sign out and back in<\/a>/);
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
