import { describe, expect, it, vi } from 'vitest';

/**
 * isControlFlow() counts an error as control flow only when unstable_rethrow
 * threw THAT error (or one in its cause chain) back. It used to count anything
 * unstable_rethrow threw. Under a module mock without unstable_rethrow every
 * call throws "not a function", so every failure was taken for a redirect and
 * dropped without a word: 30 component tests that check a failed call says so
 * went silent. Nothing in Next.js throws anything else, but an error must
 * never be hidden because the check itself could not run.
 */

vi.mock('next/navigation', () => ({
  unstable_rethrow: () => {
    throw new TypeError('unstable_rethrow is not a function');
  },
}));

import { isControlFlow } from './control-flow';

describe('isControlFlow when unstable_rethrow cannot judge the error', () => {
  it('is false: the failure is shown as one, not taken for a redirect', () => {
    expect(isControlFlow(new Error('Failed to fetch'))).toBe(false);
    expect(isControlFlow(null)).toBe(false);
  });
});
