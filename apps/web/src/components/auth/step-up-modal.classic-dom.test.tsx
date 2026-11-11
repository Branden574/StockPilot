// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, admin lane). The step-up ("Confirm
 * with your authenticator") is shared: Settings (email, email routing,
 * restore points), the platform console (Order items access, Remove
 * organization, Disable account, Act as, billing) and Manage order items all
 * open it. Its Classic DOM is pinned here in four states, from the code BEFORE
 * Liquid Glass adds its hooks: one authenticator (the code field alone), two
 * (the Authenticator select above the code), an authenticator list that could
 * not be read, and none enrolled (the alert line above the foot). Normalised as
 * the classic proof normalises a page (src/test/classic-dom.ts): with the inert
 * hook attributes stripped every state must render exactly the pinned DOM
 * under the `off` rollout (no glass-only element) and under `default`, with no
 * Classic element moved among its siblings. Fix the change, never the snapshot.
 */

const h = vi.hoisted(() => ({ listFactors: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { mfa: { listFactors: () => h.listFactors() } } }),
}));
vi.mock('@/server/actions/mfa', () => ({ challengeFactorAction: vi.fn() }));

import { useStepUp } from './step-up-modal';

const PHONE = { id: 'factor-1', friendly_name: 'Phone', status: 'verified' };
const TABLET = { id: 'factor-2', friendly_name: null, status: 'verified' };

function Harness() {
  const stepUp = useStepUp();
  return (
    <>
      <button type="button" onClick={() => void stepUp.ensure()}>
        Open step-up
      </button>
      {stepUp.modal}
    </>
  );
}

const STATES: Array<{
  name: string;
  factors: () => unknown;
  /** What the open dialog shows once the factor list has been read. */
  settled: () => HTMLElement;
}> = [
  {
    name: 'one-authenticator',
    factors: () => ({ data: { totp: [PHONE] }, error: null }),
    settled: () => screen.getByLabelText('Authentication code'),
  },
  {
    name: 'two-authenticators',
    factors: () => ({ data: { totp: [PHONE, TABLET] }, error: null }),
    settled: () => screen.getByLabelText('Authenticator'),
  },
  {
    name: 'list-unreadable',
    factors: () => ({ data: null, error: { message: 'boom' } }),
    settled: () => screen.getByRole('alert'),
  },
  {
    name: 'none-enrolled',
    factors: () => ({ data: { totp: [] }, error: null }),
    settled: () => screen.getByRole('alert'),
  },
];

afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

async function renderUnder(rollout: 'off' | 'default', state: (typeof STATES)[number]) {
  cleanup();
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  h.listFactors.mockResolvedValue(state.factors());
  render(<Harness />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Open step-up' }));
  });
  expect(
    await screen.findByRole('dialog', { name: /confirm with your authenticator/i }),
  ).toBeInTheDocument();
  await waitFor(() => expect(state.settled()).toBeInTheDocument());
  // The dialog is portalled to body, so the whole body is read.
  return {
    dom: classicDom(document.body),
    structure: classicStructure(document.body),
    glassOnly: glassOnlyCount(document.body),
  };
}

describe('Step-up modal: Classic DOM', () => {
  for (const state of STATES) {
    it(`${state.name}: the pinned Classic DOM under off and under default`, async () => {
      const off = await renderUnder('off', state);
      expect(off.glassOnly).toBe(0);
      const glass = await renderUnder('default', state);
      expect(glass.dom).toBe(off.dom);
      expect(glass.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/step-up-modal.${state.name}.txt`);
    });
  }
});
